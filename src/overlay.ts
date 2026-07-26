import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const OVERLAY_DIR = '.microgit_overlay';

/** OverlayFS 互換の whiteout プレフィックス（同ディレクトリに `.wh.<name>`） */
export const WHITEOUT_PREFIX = '.wh.';

/** 展開済みビューの完成マーカー（list / sync 対象外） */
const VIEW_OK_MARKER = '.microgit_view_ok';

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
    views: string;
};

export type CheckoutMethod = 'full' | 'incremental' | 'cached-view';

export type CheckoutResult = {
    /** 常に Node.js ユーザー空間エンジン */
    backend: 'nodejs';
    method: CheckoutMethod;
    layerCount: number;
    fileCount: number;
    /** 今回新たに適用したレイヤ数（キャッシュヒット時は 0） */
    appliedLayers: number;
    viewHash?: string;
};

type CheckoutState = {
    backend: 'nodejs';
    layerPath: string[];
    writeBranchTag: string;
    viewHash?: string;
    at: string;
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
        views: path.join(root, 'views'),
    };
}

export function ensureOverlayDirs(workspaceRoot: string): OverlayPaths {
    const paths = getOverlayPaths(workspaceRoot);
    for (const dir of [paths.root, paths.meta, paths.layers, paths.write, paths.merge, paths.views]) {
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

export function viewDir(paths: OverlayPaths, commitHash: string): string {
    return path.join(paths.views, commitHash);
}

export function isWhiteoutName(name: string): boolean {
    return name.startsWith(WHITEOUT_PREFIX) && name.length > WHITEOUT_PREFIX.length;
}

export function whiteoutNameFor(basename: string): string {
    return `${WHITEOUT_PREFIX}${basename}`;
}

export function targetNameFromWhiteout(name: string): string | undefined {
    if (!isWhiteoutName(name)) { return undefined; }
    return name.slice(WHITEOUT_PREFIX.length);
}

/** `dir/file.txt` → `dir/.wh.file.txt` */
export function whiteoutRelPath(fileRel: string): string {
    const parts = fileRel.split('/');
    const base = parts.pop();
    if (!base) { return whiteoutNameFor(fileRel); }
    parts.push(whiteoutNameFor(base));
    return parts.join('/');
}

function isSkippedName(name: string): boolean {
    return name === '.git' || name === '.DS_Store' || name === VIEW_OK_MARKER;
}

export function isViewReady(paths: OverlayPaths, commitHash: string): boolean {
    return fs.existsSync(path.join(viewDir(paths, commitHash), VIEW_OK_MARKER));
}

function markViewReady(paths: OverlayPaths, commitHash: string): void {
    const dir = viewDir(paths, commitHash);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, VIEW_OK_MARKER), commitHash, 'utf8');
}

function readCheckoutState(paths: OverlayPaths): CheckoutState | undefined {
    const stateFile = path.join(paths.meta, 'checkout.json');
    try {
        if (!fs.existsSync(stateFile)) { return undefined; }
        return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as CheckoutState;
    } catch {
        return undefined;
    }
}

function writeCheckoutState(paths: OverlayPaths, state: CheckoutState): void {
    fs.mkdirSync(paths.meta, { recursive: true });
    fs.writeFileSync(path.join(paths.meta, 'checkout.json'), JSON.stringify(state, null, 2), 'utf8');
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
        const parent = parts.length > 1 ? parts[1] : undefined;
        node = parent;
    }
    return pathHashes;
}

/**
 * OverlayGit の「空間で時間を買う」核:
 * 各コミットの完全展開ビューを views/<hash>/ に永続化し、
 * 親ビュー + 差分レイヤで O(変更) で伸ばす。
 */
export function ensureExpandedView(
    paths: OverlayPaths,
    layerPath: string[],
): { viewPath: string; method: CheckoutMethod; appliedLayers: number; viewHash?: string } {
    fs.mkdirSync(paths.views, { recursive: true });

    if (layerPath.length === 0) {
        const emptyHash = '_empty';
        const dest = viewDir(paths, emptyHash);
        if (!isViewReady(paths, emptyHash)) {
            clearDirContents(dest);
            fs.mkdirSync(dest, { recursive: true });
            markViewReady(paths, emptyHash);
        }
        return { viewPath: dest, method: 'cached-view', appliedLayers: 0, viewHash: emptyHash };
    }

    const tip = layerPath[layerPath.length - 1];
    if (isViewReady(paths, tip)) {
        return {
            viewPath: viewDir(paths, tip),
            method: 'cached-view',
            appliedLayers: 0,
            viewHash: tip,
        };
    }

    // パス上で最も先端に近い既存ビューを親にする
    let parentIdx = -1;
    for (let i = layerPath.length - 2; i >= 0; i--) {
        if (isViewReady(paths, layerPath[i])) {
            parentIdx = i;
            break;
        }
    }

    const dest = viewDir(paths, tip);
    clearDirContents(dest);
    fs.mkdirSync(dest, { recursive: true });

    let appliedLayers = 0;
    let method: CheckoutMethod = 'full';

    if (parentIdx >= 0) {
        // view 構築は実体コピー（ハードリンクは小ファイル多数で逆に遅いことがある）
        copyTreeBytes(viewDir(paths, layerPath[parentIdx]), dest);
        for (let i = parentIdx + 1; i < layerPath.length; i++) {
            applyLayerOntoMerge(layerDir(paths, layerPath[i]), dest);
            appliedLayers++;
        }
        method = 'incremental';
    } else {
        for (const hash of layerPath) {
            applyLayerOntoMerge(layerDir(paths, hash), dest);
            appliedLayers++;
        }
        method = 'full';
    }

    markViewReady(paths, tip);
    return { viewPath: dest, method, appliedLayers, viewHash: tip };
}

/**
 * コミット直後: 親ビューがあれば差分レイヤだけで新ビューを展開して保持する。
 * （切替時に再構築しない = OverlayGit の時間短縮）
 * 親ビューが無い場合は不完全なビューを作らず、checkout 時のフルパス構築に任せる。
 */
export function expandViewAfterExport(
    paths: OverlayPaths,
    commitHash: string,
    parentHash: string | undefined,
): CheckoutMethod {
    if (isViewReady(paths, commitHash)) {
        return 'cached-view';
    }

    const dest = viewDir(paths, commitHash);

    if (parentHash && isViewReady(paths, parentHash)) {
        clearDirContents(dest);
        fs.mkdirSync(dest, { recursive: true });
        copyTreeBytes(viewDir(paths, parentHash), dest);
        applyLayerOntoMerge(layerDir(paths, commitHash), dest);
        markViewReady(paths, commitHash);
        return 'incremental';
    }

    if (!parentHash) {
        clearDirContents(dest);
        fs.mkdirSync(dest, { recursive: true });
        applyLayerOntoMerge(layerDir(paths, commitHash), dest);
        markViewReady(paths, commitHash);
        return 'full';
    }

    return 'full';
}

function writeLayerHasFiles(paths: OverlayPaths, writeBranchTag: string): boolean {
    const writeSrc = writeLayerDir(paths, writeBranchTag);
    return listFilesRecursive(writeSrc).length > 0;
}

/** merge を消して（symlink/junction/実体いずれも）作り直せるようにする */
export function resetMergeDir(paths: OverlayPaths): void {
    if (!fs.existsSync(paths.merge)) {
        return;
    }
    try {
        fs.rmSync(paths.merge, { recursive: true, force: true });
    } catch {
        clearDirContents(paths.merge);
        try { fs.rmdirSync(paths.merge); } catch { /* keep */ }
    }
}

/**
 * write レイヤが空なら merge を view へのディレクトリジャンクション/symlink にする（O(1) 載せ替え）。
 * write があるときだけ実ディレクトリへ展開してレイヤを載せる。
 */
export function pointMergeAtView(paths: OverlayPaths, viewPath: string): 'junction' | 'symlink' | 'link-tree' {
    resetMergeDir(paths);
    try {
        if (process.platform === 'win32') {
            fs.symlinkSync(viewPath, paths.merge, 'junction');
            return 'junction';
        }
        fs.symlinkSync(viewPath, paths.merge, 'dir');
        return 'symlink';
    } catch {
        fs.mkdirSync(paths.merge, { recursive: true });
        linkOrCopyTree(viewPath, paths.merge);
        return 'link-tree';
    }
}

/**
 * Node.js ユーザー空間 Overlay（OverlayFS 意味論）:
 * write が空なら merge=view ジャンクション、あるときだけ実体化して上書き。
 */
export function materializeMerge(
    paths: OverlayPaths,
    layerPath: string[],
    writeBranchTag: string,
): { fileCount: number; method: CheckoutMethod; appliedLayers: number; viewHash?: string } {
    const ensured = ensureExpandedView(paths, layerPath);
    const writeSrc = writeLayerDir(paths, writeBranchTag);

    if (!writeLayerHasFiles(paths, writeBranchTag)) {
        pointMergeAtView(paths, ensured.viewPath);
    } else {
        resetMergeDir(paths);
        fs.mkdirSync(paths.merge, { recursive: true });
        linkOrCopyTree(ensured.viewPath, paths.merge);
        applyLayerOntoMerge(writeSrc, paths.merge);
    }

    return {
        fileCount: listFilesRecursive(paths.merge).length,
        method: ensured.method,
        appliedLayers: ensured.appliedLayers,
        viewHash: ensured.viewHash,
    };
}

/** checkout の唯一の実装入口（常に Node.js + 展開ビュー） */
export function checkoutLayers(
    paths: OverlayPaths,
    layerPath: string[],
    writeBranchTag: string,
): CheckoutResult {
    const prev = readCheckoutState(paths);
    const tip = layerPath.length ? layerPath[layerPath.length - 1] : undefined;

    // 同一 tip・同一 write・write 空 → 何もしない（ジャンクション載せ替え済み）
    if (
        tip &&
        prev?.viewHash === tip &&
        prev.writeBranchTag === writeBranchTag &&
        isViewReady(paths, tip) &&
        fs.existsSync(paths.merge) &&
        !writeLayerHasFiles(paths, writeBranchTag)
    ) {
        const fileCount = listFilesRecursive(paths.merge).length;
        return {
            backend: 'nodejs',
            method: 'cached-view',
            layerCount: layerPath.length,
            fileCount,
            appliedLayers: 0,
            viewHash: tip,
        };
    }

    const materialized = materializeMerge(paths, layerPath, writeBranchTag);
    writeCheckoutState(paths, {
        backend: 'nodejs',
        layerPath,
        writeBranchTag,
        viewHash: materialized.viewHash,
        at: new Date().toISOString(),
    });
    return {
        backend: 'nodejs',
        method: tip && prev?.viewHash === tip ? 'cached-view' : materialized.method,
        layerCount: layerPath.length,
        fileCount: materialized.fileCount,
        appliedLayers: tip && prev?.viewHash === tip ? 0 : materialized.appliedLayers,
        viewHash: materialized.viewHash,
    };
}

export function describeOverlayEngine(): string {
    return `backend=nodejs space-for-time=views merge=junction-or-link platform=${process.platform}`;
}

/**
 * 同一ボリュームならハードリンク、ダメならコピー。
 * view→merge / 親view→子view の「載せ替え」を O(inode) に近づける。
 */
export function linkOrCopyFile(src: string, dest: string): void {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
    }
    try {
        fs.linkSync(src, dest);
    } catch {
        fs.copyFileSync(src, dest);
    }
}

/** ディレクトリツリーをハードリンク優先で載せ替え（ビューマーカーは除外） */
export function linkOrCopyTree(srcDir: string, destDir: string): void {
    if (!fs.existsSync(srcDir)) { return; }
    fs.mkdirSync(destDir, { recursive: true });

    const walk = (dir: string, relPrefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (isSkippedName(entry.name)) { continue; }
            const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                fs.mkdirSync(path.join(destDir, ...rel.split('/')), { recursive: true });
                walk(abs, rel);
            } else if (entry.isFile()) {
                linkOrCopyFile(abs, path.join(destDir, ...rel.split('/')));
            }
        }
    };
    walk(srcDir, '');
}

/** ディレクトリツリーをバイトコピー（ビュー展開用） */
export function copyTreeBytes(srcDir: string, destDir: string): void {
    if (!fs.existsSync(srcDir)) { return; }
    fs.mkdirSync(destDir, { recursive: true });

    const walk = (dir: string, relPrefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (isSkippedName(entry.name)) { continue; }
            const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                fs.mkdirSync(path.join(destDir, ...rel.split('/')), { recursive: true });
                walk(abs, rel);
            } else if (entry.isFile()) {
                const to = path.join(destDir, ...rel.split('/'));
                fs.mkdirSync(path.dirname(to), { recursive: true });
                fs.copyFileSync(abs, to);
            }
        }
    };
    walk(srcDir, '');
}

/** 後方互換エイリアス */
export function copyTree(srcDir: string, destDir: string): void {
    copyTreeBytes(srcDir, destDir);
}

/**
 * レイヤを merge/view に適用（通常ファイル + whiteout）。
 * ハードリンク先を壊さないよう、上書き前に必ず unlink する。
 */
export function applyLayerOntoMerge(srcDir: string, mergeDir: string): void {
    if (!fs.existsSync(srcDir)) { return; }

    const walk = (dir: string, relPrefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (isSkippedName(entry.name)) { continue; }
            const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            const abs = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                walk(abs, rel);
                continue;
            }
            if (!entry.isFile()) { continue; }

            if (isWhiteoutName(entry.name)) {
                const targetName = targetNameFromWhiteout(entry.name);
                if (!targetName) { continue; }
                const parentRel = relPrefix;
                const targetRel = parentRel ? `${parentRel}/${targetName}` : targetName;
                removeMergePath(mergeDir, targetRel);
                continue;
            }

            const to = path.join(mergeDir, ...rel.split('/'));
            fs.mkdirSync(path.dirname(to), { recursive: true });
            if (fs.existsSync(to)) {
                fs.unlinkSync(to);
            }
            // レイヤ実体は view と共有しない（後でレイヤを消しても merge/view が残るようコピー）
            fs.copyFileSync(abs, to);
        }
    };

    walk(srcDir, '');
}

function removeMergePath(mergeDir: string, rel: string): void {
    const target = path.join(mergeDir, ...rel.split('/'));
    if (!fs.existsSync(target)) { return; }
    fs.rmSync(target, { recursive: true, force: true });
}

export function listFilesRecursive(rootDir: string): string[] {
    const result: string[] = [];
    if (!fs.existsSync(rootDir)) { return result; }

    const walk = (dir: string, prefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (isSkippedName(entry.name) || isWhiteoutName(entry.name)) { continue; }
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
    applyLayerOntoMerge(srcDir, destDir);
}

function filesContentEqual(a: string, b: string): boolean {
    try {
        const sa = fs.statSync(a);
        const sb = fs.statSync(b);
        if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) { return false; }
        if (sa.size === 0) { return true; }
        // 同一 inode（ハードリンク）なら中身比較不要
        if (sa.dev === sb.dev && sa.ino === sb.ino) { return true; }
        return fs.readFileSync(a).equals(fs.readFileSync(b));
    } catch {
        return false;
    }
}

type WorkspaceSyncCache = Record<string, { size: number; mtimeMs: number }>;

function syncCachePath(paths: OverlayPaths): string {
    return path.join(paths.meta, 'workspace-sync.json');
}

function readSyncCache(paths: OverlayPaths): WorkspaceSyncCache {
    try {
        const p = syncCachePath(paths);
        if (!fs.existsSync(p)) { return {}; }
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as WorkspaceSyncCache;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeSyncCache(paths: OverlayPaths, cache: WorkspaceSyncCache): void {
    fs.mkdirSync(paths.meta, { recursive: true });
    fs.writeFileSync(syncCachePath(paths), JSON.stringify(cache), 'utf8');
}

/** commit の変更ファイルを layers/<hash>/ にフル実体（または whiteout）で書き出す */
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
    fs.mkdirSync(paths.views, { recursive: true });

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
            const wo = path.join(dest, ...whiteoutRelPath(relPath).split('/'));
            if (fs.existsSync(wo)) { fs.unlinkSync(wo); }
        } catch {
            const outFile = path.join(dest, ...relPath.split('/'));
            if (fs.existsSync(outFile)) {
                fs.rmSync(outFile, { recursive: true, force: true });
            }
            const wo = path.join(dest, ...whiteoutRelPath(relPath).split('/'));
            fs.mkdirSync(path.dirname(wo), { recursive: true });
            fs.writeFileSync(wo, '');
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

    // 空間で時間を買う: コミット時点でビューを展開保持
    expandViewAfterExport(paths, commitHash, parentHash);

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
    const dest = layerDir(paths, commitHash);
    const hasContent = fs.existsSync(dest) && fs.readdirSync(dest).some((n) => !isSkippedName(n));
    if (dag.nodes[commitHash] && hasContent) {
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
    const wo = path.join(paths.write, branchTag, ...whiteoutRelPath(relativeFilePath).split('/'));
    if (fs.existsSync(wo)) {
        fs.unlinkSync(wo);
    }
}

/** 書き込みレイヤに whiteout を置いて「削除」を表現 */
export function whiteoutInWriteLayer(
    paths: OverlayPaths,
    branchTag: string,
    relativeFilePath: string,
): void {
    removeFromWriteLayer(paths, branchTag, relativeFilePath);
    const wo = path.join(paths.write, branchTag, ...whiteoutRelPath(relativeFilePath).split('/'));
    fs.mkdirSync(path.dirname(wo), { recursive: true });
    fs.writeFileSync(wo, '');
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
 * size+mtime キャッシュと inode 一致でフルリード比較を避ける。
 */
export function syncMergeToWorkspace(
    workspaceRoot: string,
    paths: OverlayPaths,
    isSafeRepoRelativePath: (relPath: string, rootPath: string) => boolean,
    isMicroGitArtifactPath: (filePath: string, rootPath: string) => boolean,
    extraManagedFiles?: string[],
): { written: string[]; deleted: string[]; skipped: number } {
    const dag = readDag(paths);
    const mergeFiles = new Set(listFilesRecursive(paths.merge));
    const managed = new Set(dag.managedFiles);
    for (const f of mergeFiles) { managed.add(f); }
    for (const f of extraManagedFiles ?? []) { managed.add(f); }

    const cache = readSyncCache(paths);
    const nextCache: WorkspaceSyncCache = {};
    const written: string[] = [];
    const deleted: string[] = [];
    let skipped = 0;

    for (const rel of mergeFiles) {
        if (!isSafeRepoRelativePath(rel, workspaceRoot)) { continue; }
        const from = path.join(paths.merge, ...rel.split('/'));
        const to = path.join(workspaceRoot, ...rel.split('/'));
        if (isMicroGitArtifactPath(to, workspaceRoot)) { continue; }

        let srcStat: fs.Stats;
        try {
            srcStat = fs.statSync(from);
            if (!srcStat.isFile()) { continue; }
        } catch {
            continue;
        }

        const cached = cache[rel];
        if (
            cached &&
            cached.size === srcStat.size &&
            cached.mtimeMs === srcStat.mtimeMs &&
            fs.existsSync(to)
        ) {
            try {
                const dstStat = fs.statSync(to);
                if (dstStat.isFile() && dstStat.size === srcStat.size) {
                    nextCache[rel] = cached;
                    skipped++;
                    continue;
                }
            } catch { /* fall through */ }
        }

        if (fs.existsSync(to) && filesContentEqual(from, to)) {
            nextCache[rel] = { size: srcStat.size, mtimeMs: srcStat.mtimeMs };
            skipped++;
            continue;
        }

        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        written.push(rel);
        nextCache[rel] = { size: srcStat.size, mtimeMs: srcStat.mtimeMs };
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
    writeSyncCache(paths, nextCache);
    return { written, deleted, skipped };
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
