import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const OVERLAY_DIR = '.microgit_overlay';

export type OverlayDagNode = {
    hash: string;
    parents: string[];
    changedFiles: string[];
    branchTag?: string;
};

export type OverlayDag = {
    nodes: Record<string, OverlayDagNode>;
    managedFiles: string[];
    current?: string;
    currentTag?: string;
};

export type OverlayPaths = {
    root: string;
    meta: string;
    dagFile: string;
    layers: string;
    write: string;
    merge: string;
};

type GitRunner = (cwd: string, args: string[]) => string;
type GitTryRunner = (cwd: string, args: string[]) => string | undefined;

export function isOverlayCheckoutEnabled(getConfig: (key: string) => boolean | undefined): boolean {
    return getConfig('microgit.useOverlayCheckout') !== false;
}

export function getOverlayPaths(workspaceRoot: string): OverlayPaths {
    const root = path.join(workspaceRoot, OVERLAY_DIR);
    return {
        root,
        meta: path.join(root, 'meta'),
        dagFile: path.join(root, 'meta', 'dag.json'),
        layers: path.join(root, 'layers'),
        write: path.join(root, 'write'),
        merge: path.join(root, 'merge'),
    };
}

export function ensureOverlayDirs(workspaceRoot: string): OverlayPaths {
    const paths = getOverlayPaths(workspaceRoot);
    for (const dir of [paths.root, paths.meta, paths.layers, paths.write, paths.merge]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    if (!fs.existsSync(paths.dagFile)) {
        writeDag(paths, { nodes: {}, managedFiles: [] });
    }
    return paths;
}

export function readDag(paths: OverlayPaths): OverlayDag {
    try {
        if (!fs.existsSync(paths.dagFile)) {
            return { nodes: {}, managedFiles: [] };
        }
        const parsed = JSON.parse(fs.readFileSync(paths.dagFile, 'utf8')) as OverlayDag;
        return {
            nodes: parsed.nodes ?? {},
            managedFiles: Array.isArray(parsed.managedFiles) ? parsed.managedFiles : [],
            current: parsed.current,
            currentTag: parsed.currentTag,
        };
    } catch {
        return { nodes: {}, managedFiles: [] };
    }
}

export function writeDag(paths: OverlayPaths, dag: OverlayDag): void {
    fs.mkdirSync(paths.meta, { recursive: true });
    fs.writeFileSync(paths.dagFile, JSON.stringify(dag, null, 2), 'utf8');
}

export function writeLayerDir(paths: OverlayPaths, branchTag: string): string {
    const dir = path.join(paths.write, branchTag);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function layerDir(paths: OverlayPaths, commitHash: string): string {
    return path.join(paths.layers, commitHash);
}

/** primary parent を辿って root→target の1本パスを返す（兄弟を混ぜない） */
export function computePath(
    shadowRepoPath: string,
    targetHash: string,
    _runGit: GitRunner,
    tryRunGit: GitTryRunner,
): string[] {
    const pathHashes: string[] = [];
    let node: string | undefined = targetHash;
    const guard = new Set<string>();

    while (node && !guard.has(node)) {
        guard.add(node);
        pathHashes.unshift(node);
        const parentLine: string | undefined = tryRunGit(
            shadowRepoPath,
            ['rev-list', '--parents', '-n', '1', node],
        )?.trim();
        if (!parentLine) { break; }
        const parts: string[] = parentLine.split(/\s+/).filter(Boolean);
        // rev-list --parents: <commit> <parent1> <parent2>...
        const parent = parts.length > 1 ? parts[1] : undefined;
        node = parent;
    }
    return pathHashes;
}

/**
 * Stage 1a: OverlayFS の代わりにレイヤを順に上書きコピーして merge/ を組み立てる
 */
export function materializeMerge(
    paths: OverlayPaths,
    layerPath: string[],
    writeBranchTag: string,
): void {
    clearDirContents(paths.merge);
    fs.mkdirSync(paths.merge, { recursive: true });

    for (const hash of layerPath) {
        const src = layerDir(paths, hash);
        if (fs.existsSync(src)) {
            copyMerge(src, paths.merge);
        }
    }

    const writeSrc = writeLayerDir(paths, writeBranchTag);
    if (fs.existsSync(writeSrc)) {
        copyMerge(writeSrc, paths.merge);
    }
}

export function listFilesRecursive(rootDir: string): string[] {
    const result: string[] = [];
    if (!fs.existsSync(rootDir)) { return result; }

    const walk = (dir: string, prefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === '.git' || entry.name === '.DS_Store') { continue; }
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(abs, rel);
            } else if (entry.isFile()) {
                result.push(rel.split(path.sep).join('/'));
            }
        }
    };
    walk(rootDir, '');
    return result;
}

export function clearDirContents(dir: string): void {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        return;
    }
    for (const entry of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
}

export function copyMerge(srcDir: string, destDir: string): void {
    if (!fs.existsSync(srcDir)) { return; }
    const files = listFilesRecursive(srcDir);
    for (const rel of files) {
        const from = path.join(srcDir, ...rel.split('/'));
        const to = path.join(destDir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
    }
}

/** commit の変更ファイルを layers/<hash>/ にフル実体で書き出す */
export function exportCommitLayer(
    shadowRepoPath: string,
    paths: OverlayPaths,
    commitHash: string,
    parentHash: string | undefined,
    branchTag: string | undefined,
    _runGit: GitRunner,
    tryRunGit: GitTryRunner,
): string[] {
    fs.mkdirSync(paths.layers, { recursive: true });
    fs.mkdirSync(paths.meta, { recursive: true });

    const dest = layerDir(paths, commitHash);
    fs.mkdirSync(dest, { recursive: true });

    let changedFiles: string[] = [];
    if (parentHash) {
        const diff = tryRunGit(shadowRepoPath, [
            'diff-tree', '--no-commit-id', '--name-only', '-r', parentHash, commitHash,
        ])?.trim();
        changedFiles = diff ? diff.split('\n').filter(Boolean) : [];
    }
    if (changedFiles.length === 0) {
        const all = tryRunGit(shadowRepoPath, ['ls-tree', '--name-only', '-r', commitHash])?.trim();
        changedFiles = all ? all.split('\n').filter(Boolean) : [];
    }

    for (const relPath of changedFiles) {
        if (!relPath || relPath.includes('..')) { continue; }
        try {
            const content = execFileSync('git', ['show', `${commitHash}:${relPath}`], {
                cwd: shadowRepoPath,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            const outFile = path.join(dest, ...relPath.split('/'));
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            fs.writeFileSync(outFile, content);
        } catch {
            // 削除されたファイルはレイヤに置かない（MVP: whiteout なし）
            const outFile = path.join(dest, ...relPath.split('/'));
            if (fs.existsSync(outFile)) {
                fs.unlinkSync(outFile);
            }
        }
    }

    const dag = readDag(paths);
    const parents = parentHash ? [parentHash] : [];
    dag.nodes[commitHash] = {
        hash: commitHash,
        parents,
        changedFiles,
        branchTag,
    };
    const managed = new Set(dag.managedFiles);
    for (const f of changedFiles) { managed.add(f); }
    dag.managedFiles = Array.from(managed).sort();
    dag.current = commitHash;
    if (branchTag) { dag.currentTag = branchTag; }
    writeDag(paths, dag);

    return changedFiles;
}

/** レイヤが無ければ shadow から書き出す（既存履歴の遅延バックフィル） */
export function ensureLayerExists(
    shadowRepoPath: string,
    paths: OverlayPaths,
    commitHash: string,
    runGit: GitRunner,
    tryRunGit: GitTryRunner,
): void {
    const dag = readDag(paths);
    if (dag.nodes[commitHash]) {
        return;
    }
    const dest = layerDir(paths, commitHash);
    if (fs.existsSync(dest) && listFilesRecursive(dest).length > 0) {
        return;
    }

    const line = tryRunGit(shadowRepoPath, ['rev-list', '--parents', '-n', '1', commitHash])?.trim();
    const parts = line ? line.split(/\s+/).filter(Boolean) : [];
    const parentHash = parts.length > 1 ? parts[1] : undefined;
    const tag = tryRunGit(shadowRepoPath, ['tag', '--points-at', commitHash, '-l', 'mb-*'])?.trim()?.split('\n')[0];
    exportCommitLayer(shadowRepoPath, paths, commitHash, parentHash, tag, runGit, tryRunGit);
}

export function removeFromWriteLayer(
    paths: OverlayPaths,
    branchTag: string,
    relativeFilePath: string,
): void {
    const filePath = path.join(paths.write, branchTag, ...relativeFilePath.split('/'));
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

/** shadow 履歴に登場した全パスを収集（兄弟枝の取り残し削除用） */
export function collectShadowTrackedFiles(
    shadowRepoPath: string,
    tryRunGit: GitTryRunner,
): string[] {
    const out = tryRunGit(shadowRepoPath, [
        'log', '--all', '--pretty=format:', '--name-only',
    ])?.trim();
    if (!out) { return []; }
    return Array.from(new Set(
        out.split('\n').map((l) => l.trim()).filter((l) => l && !l.includes('..'))
    ));
}

/**
 * merge/ の内容をワークスペースへ同期する。
 * managedFiles にあって merge に無いファイルは削除し、兄弟枝の取り残しを防ぐ。
 */
export function syncMergeToWorkspace(
    workspaceRoot: string,
    paths: OverlayPaths,
    isSafeRepoRelativePath: (relPath: string, rootPath: string) => boolean,
    isMicroGitArtifactPath: (filePath: string, rootPath: string) => boolean,
    extraManagedFiles?: string[],
): { written: string[]; deleted: string[] } {
    const dag = readDag(paths);
    const mergeFiles = new Set(listFilesRecursive(paths.merge));
    const managed = new Set(dag.managedFiles);
    for (const f of mergeFiles) { managed.add(f); }
    for (const f of extraManagedFiles ?? []) { managed.add(f); }

    const written: string[] = [];
    const deleted: string[] = [];

    for (const rel of mergeFiles) {
        if (!isSafeRepoRelativePath(rel, workspaceRoot)) { continue; }
        const from = path.join(paths.merge, ...rel.split('/'));
        const to = path.join(workspaceRoot, ...rel.split('/'));
        if (isMicroGitArtifactPath(to, workspaceRoot)) { continue; }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        written.push(rel);
    }

    for (const rel of managed) {
        if (mergeFiles.has(rel)) { continue; }
        if (!isSafeRepoRelativePath(rel, workspaceRoot)) { continue; }
        const to = path.join(workspaceRoot, ...rel.split('/'));
        if (isMicroGitArtifactPath(to, workspaceRoot)) { continue; }
        if (fs.existsSync(to) && fs.statSync(to).isFile()) {
            fs.unlinkSync(to);
            deleted.push(rel);
        }
    }

    dag.managedFiles = Array.from(managed).sort();
    writeDag(paths, dag);
    return { written, deleted };
}

export function updateDagCurrent(
    paths: OverlayPaths,
    commitHash: string,
    branchTag: string,
): void {
    const dag = readDag(paths);
    dag.current = commitHash;
    dag.currentTag = branchTag;
    writeDag(paths, dag);
}
