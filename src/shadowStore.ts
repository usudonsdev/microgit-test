import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export function sanitizeBranchKey(branch: string): string {
    return branch.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function shadowWorkTreePath(mainRepoPath: string): string {
    return path.join(mainRepoPath, '.microgit_shadow');
}

export function bareGitDirPath(mainRepoPath: string, mainBranch: string): string {
    return path.join(mainRepoPath, '.git', 'microgit', 'repos', `${sanitizeBranchKey(mainBranch)}.git`);
}

export function parentMicroRefPrefix(mainBranch: string): string {
    return `refs/microgit/${sanitizeBranchKey(mainBranch)}`;
}

function runGitDir(gitDir: string, args: string[], workTree?: string): string {
    const fullArgs = ['--git-dir', gitDir, ...(workTree ? ['--work-tree', workTree] : []), ...args];
    return execFileSync('git', fullArgs, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    }).toString();
}

function tryGitDir(gitDir: string, args: string[], workTree?: string): string | undefined {
    try {
        return runGitDir(gitDir, args, workTree);
    } catch {
        return undefined;
    }
}

/**
 * 作業ツリー内にネスト .git ディレクトリを置かず、
 * `.git/microgit/repos/<branch>.git`（bare）+ `.microgit_shadow/.git`（gitfile）で運用する。
 * Overlay の軽量 checkout はそのまま利用可能。
 */
export function ensureShadowRepoForBranch(
    mainRepoPath: string,
    mainBranch: string,
    log?: (message: string, level?: 'INFO' | 'WARN' | 'ERROR') => void,
): string {
    const workTree = shadowWorkTreePath(mainRepoPath);
    const bare = bareGitDirPath(mainRepoPath, mainBranch);
    fs.mkdirSync(workTree, { recursive: true });
    fs.mkdirSync(path.dirname(bare), { recursive: true });

    const gitMarker = path.join(workTree, '.git');

    // 旧来のネスト .git ディレクトリを bare へ移行
    if (fs.existsSync(gitMarker) && fs.statSync(gitMarker).isDirectory()) {
        if (!fs.existsSync(bare)) {
            fs.renameSync(gitMarker, bare);
            log?.(`レガシーなネスト .git を移行しました: ${bare}`);
        } else {
            fs.rmSync(gitMarker, { recursive: true, force: true });
            log?.('レガシーなネスト .git を削除（bare が既に存在）', 'WARN');
        }
    }

    if (!fs.existsSync(bare)) {
        execFileSync('git', ['init', '--bare', bare], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        runGitDir(bare, ['symbolic-ref', 'HEAD', 'refs/heads/micro-history']);
        log?.(`bare シャドウを初期化: ${bare}`);
    }

    // worktree 側は gitfile のみ（相対パス）。親の通常コミットにネスト .git が載らない。
    const rel = path.relative(workTree, bare).split(path.sep).join('/');
    fs.writeFileSync(gitMarker, `gitdir: ${rel}\n`, 'utf8');

    // 作業ツリー設定を明示（Windows の絶対パスでも git が解決できるように）
    runGitDir(bare, ['config', 'core.bare', 'false']);
    runGitDir(bare, ['config', 'core.worktree', workTree]);

    if (tryGitDir(bare, ['rev-parse', '--verify', 'refs/heads/micro-history']) === undefined) {
        runGitDir(bare, ['symbolic-ref', 'HEAD', 'refs/heads/micro-history']);
    }

    return workTree;
}

/** bare の tip / tags を親リポジトリの refs/microgit/<branch>/ へ取り込む（オブジェクトも親へコピー） */
export function publishToParentRefs(
    mainRepoPath: string,
    mainBranch: string,
    log?: (message: string, level?: 'INFO' | 'WARN' | 'ERROR') => void,
): void {
    const bare = bareGitDirPath(mainRepoPath, mainBranch);
    if (!fs.existsSync(bare)) { return; }

    const parentGit = path.join(mainRepoPath, '.git');
    const prefix = parentMicroRefPrefix(mainBranch);

    if (tryGitDir(bare, ['rev-parse', '--verify', 'refs/heads/micro-history']) === undefined) {
        return;
    }

    runGitDir(bare, [
        'push',
        '--force',
        parentGit,
        `refs/heads/micro-history:${prefix}/micro-history`,
    ]);

    const tags = (tryGitDir(bare, ['tag', '-l', 'mb-*']) ?? '')
        .trim()
        .split('\n')
        .filter(Boolean);
    for (const tag of tags) {
        if (!/^mb-\d+$/.test(tag)) { continue; }
        try {
            runGitDir(bare, [
                'push',
                '--force',
                parentGit,
                `refs/tags/${tag}:${prefix}/tags/${tag}`,
            ]);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            log?.(`親 refs へタグ ${tag} の publish に失敗: ${message}`, 'WARN');
        }
    }
    log?.(`親 refs へ publish: ${prefix}/*`);
}

/** 親の refs/microgit/<branch>/ から bare へ取り込む（pull 後の他デバイス復元用） */
export function importFromParentRefs(
    mainRepoPath: string,
    mainBranch: string,
    log?: (message: string, level?: 'INFO' | 'WARN' | 'ERROR') => void,
): void {
    const bare = bareGitDirPath(mainRepoPath, mainBranch);
    const workTree = shadowWorkTreePath(mainRepoPath);
    ensureShadowRepoForBranch(mainRepoPath, mainBranch, log);

    const parentGit = path.join(mainRepoPath, '.git');
    const prefix = parentMicroRefPrefix(mainBranch);

    const tip = tryRunParent(mainRepoPath, ['rev-parse', '--verify', `${prefix}/micro-history`]);
    if (!tip) {
        log?.(`親に ${prefix}/micro-history がありません（未共有または未 publish）`);
        return;
    }

    try {
        runGitDir(bare, [
            'fetch',
            parentGit,
            `+${prefix}/micro-history:refs/heads/micro-history`,
        ]);
        // タグ
        const tagOut = tryRunParent(mainRepoPath, [
            'for-each-ref',
            '--format=%(refname:strip=3)',
            `${prefix}/tags`,
        ]) ?? '';
        for (const tag of tagOut.trim().split('\n').filter(Boolean)) {
            if (!/^mb-\d+$/.test(tag)) { continue; }
            try {
                runGitDir(bare, [
                    'fetch',
                    parentGit,
                    `+${prefix}/tags/${tag}:refs/tags/${tag}`,
                ]);
            } catch { /* ignore single tag */ }
        }
        runGitDir(bare, ['symbolic-ref', 'HEAD', 'refs/heads/micro-history']);
        // 作業ツリーを tip に合わせる（ファイルが空でもよい）
        tryGitDir(bare, ['checkout', '-f', 'micro-history'], workTree);
        log?.(`親 refs から import: ${prefix}/* → bare`);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log?.(`親 refs からの import に失敗: ${message}`, 'ERROR');
    }
}

function tryRunParent(mainRepoPath: string, args: string[]): string | undefined {
    try {
        return execFileSync('git', args, {
            cwd: mainRepoPath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        }).toString();
    } catch {
        return undefined;
    }
}

/** origin があるとき refs/microgit/* を push（MicroGit 導入済み同士の companion 同期） */
export function pushMicrogitRefsToOrigin(
    mainRepoPath: string,
    log?: (message: string, level?: 'INFO' | 'WARN' | 'ERROR') => void,
): boolean {
    const origin = tryRunParent(mainRepoPath, ['config', '--get', 'remote.origin.url']);
    if (!origin?.trim()) {
        log?.('origin が無いため remote push をスキップ');
        return false;
    }
    try {
        execFileSync('git', ['push', 'origin', 'refs/microgit/*'], {
            cwd: mainRepoPath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        log?.('origin へ refs/microgit/* を push しました');
        return true;
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log?.(`origin への microgit refs push に失敗: ${message}`, 'WARN');
        return false;
    }
}

/** origin から refs/microgit/* を fetch */
export function fetchMicrogitRefsFromOrigin(
    mainRepoPath: string,
    log?: (message: string, level?: 'INFO' | 'WARN' | 'ERROR') => void,
): boolean {
    const origin = tryRunParent(mainRepoPath, ['config', '--get', 'remote.origin.url']);
    if (!origin?.trim()) {
        log?.('origin が無いため remote fetch をスキップ');
        return false;
    }
    try {
        execFileSync('git', ['fetch', 'origin', '+refs/microgit/*:refs/microgit/*'], {
            cwd: mainRepoPath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        log?.('origin から refs/microgit/* を fetch しました');
        return true;
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log?.(`origin からの microgit refs fetch に失敗: ${message}`, 'WARN');
        return false;
    }
}
