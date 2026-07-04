import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const STATE_ENABLED = 'microgit.enabled';
const STATE_TARGET_BRANCH = 'microgit.targetBranch';
const ARTIFACT_DIRS = ['.microgit_shadow', '.microgit_logs'] as const;

/** 現在ユーザーがどのタイムライン（マイクロブランチ）の延長線上にいるか */
let currentMicroBranchTag: string = 'mb-1';

let extensionContext: vscode.ExtensionContext | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let saveChain: Promise<void> = Promise.resolve();

/**
 * 拡張機能がアクティブになった際に呼び出されるエントリポイント
 */
export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    ExtensionLogger.initialize('MicroGit Output');
    ExtensionLogger.log('MicroGit 拡張機能が起動しました');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'microgit.toggle';
    statusBarItem.tooltip = 'MicroGit の有効 / 無効を切り替え';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        const rootPath = workspaceFolders[0].uri.fsPath;
        syncBranchPolicy(rootPath);
        if (isActiveOnCurrentBranch(rootPath)) {
            const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
            if (fs.existsSync(shadowRepoPath)) {
                currentMicroBranchTag = detectCurrentTag(shadowRepoPath);
                ExtensionLogger.log(`前回のアクティブマイクロブランチを引き継ぎました: ${currentMicroBranchTag}`);
            }
        }
        void ExtensionLogger.exportLogFile(rootPath);
    } else {
        updateStatusBar(undefined);
    }

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            enqueueSave(async () => {
                if (!workspaceFolders) { return; }
                const rootPath = workspaceFolders[0].uri.fsPath;

                if (isMicroGitArtifactPath(document.fileName, rootPath)) { return; }
                if (!isPathInsideRoot(document.fileName, rootPath)) { return; }

                if (!syncBranchPolicy(rootPath)) {
                    return;
                }

                ExtensionLogger.log(`ファイル保存イベントを検知しました: ${document.fileName}`);

                const gitPath = path.join(rootPath, '.git');
                const isTestFile = document.fileName.endsWith('test_dummy.py');

                if (!fs.existsSync(gitPath) && !isTestFile) {
                    ExtensionLogger.log('Git管理外のフォルダのため、処理をスキップしました。', 'WARN');
                    await ExtensionLogger.exportLogFile(rootPath);
                    return;
                }

                await runShadowCommit(rootPath, document.fileName);
                await generateMicroGitFileLog(rootPath, document.fileName);
                await ExtensionLogger.exportLogFile(rootPath);
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.toggle', async () => {
            if (!workspaceFolders) {
                vscode.window.showWarningMessage('ワークスペースを開いてから MicroGit を切り替えてください。');
                return;
            }
            const rootPath = workspaceFolders[0].uri.fsPath;
            if (isEnabled()) {
                await setEnabled(false);
                syncBranchPolicy(rootPath);
                vscode.window.showInformationMessage('[MicroGit] 無効にしました。自動記録を停止します（対象ブランチ設定は保持）。');
                ExtensionLogger.log('MicroGit を無効化しました');
            } else {
                const branch = getCurrentBranch(rootPath);
                if (!branch || branch === 'HEAD') {
                    vscode.window.showErrorMessage('有効なブランチ上でのみ MicroGit を有効化できます（detached HEAD 不可）。');
                    return;
                }
                await setEnabled(true, branch);
                syncBranchPolicy(rootPath);
                vscode.window.showInformationMessage(`[MicroGit] 有効化しました（対象ブランチ: ${branch}）`);
                ExtensionLogger.log(`MicroGit を有効化しました。対象ブランチ: ${branch}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.enable', async () => {
            if (!workspaceFolders) { return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            if (isEnabled()) {
                vscode.window.showInformationMessage(`[MicroGit] 既に有効です（対象ブランチ: ${getTargetBranch() ?? '未設定'}）`);
                updateStatusBar(rootPath);
                return;
            }
            await vscode.commands.executeCommand('microgit.toggle');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.disable', async () => {
            if (!workspaceFolders) { return; }
            if (!isEnabled()) {
                vscode.window.showInformationMessage('[MicroGit] 既に無効です');
                updateStatusBar(workspaceFolders[0].uri.fsPath);
                return;
            }
            await vscode.commands.executeCommand('microgit.toggle');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.jumpToCommit', async (explicitTarget?: string) => {
            if (!workspaceFolders) { return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            if (!syncBranchPolicy(rootPath)) {
                vscode.window.showWarningMessage('MicroGit が無効、または対象ブランチ以外のためタイムトラベルできません。');
                return;
            }
            const target = explicitTarget || await vscode.window.showInputBox({
                prompt: '戻りたいコミットハッシュ、またはタグ名を入力',
                placeHolder: 'mb-1'
            });
            if (!target) { return; }
            await sharedTimeTravel(target.trim(), rootPath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.pullHistory', async () => {
            if (!workspaceFolders) { return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            if (!syncBranchPolicy(rootPath)) {
                vscode.window.showWarningMessage('MicroGit が無効、または対象ブランチ以外のため履歴取得できません。');
                return;
            }
            const shadowRepoPath = path.join(rootPath, '.microgit_shadow');

            if (!fs.existsSync(shadowRepoPath)) {
                vscode.window.showWarningMessage('シャドウリポジトリがありません。一度ファイルを保存してください。');
                return;
            }

            try {
                vscode.window.setStatusBarMessage('[MicroGit] チームの履歴を取得中...', 3000);
                const remoteUrl = runGit(rootPath, ['config', '--get', 'remote.origin.url']).trim();
                if (!remoteUrl || !isSafeRemoteUrl(remoteUrl)) {
                    vscode.window.showErrorMessage('安全に利用できる origin URL が設定されていません。');
                    return;
                }
                runGit(shadowRepoPath, ['fetch', remoteUrl, 'micro-history:micro-history', '--tags', '-f']);
                currentMicroBranchTag = detectCurrentTag(shadowRepoPath);
                vscode.window.showInformationMessage('[MicroGit] チームの最新マイクロ履歴を同期しました！');
            } catch {
                vscode.window.showErrorMessage('履歴の取得に失敗しました（大元に origin が設定されていない可能性があります）');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.exportLogs', async () => {
            if (!workspaceFolders) { return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            syncBranchPolicy(rootPath);
            if (!isOnTargetBranch(rootPath)) {
                vscode.window.showWarningMessage('対象ブランチ上でのみログをエクスポートできます。');
                return;
            }
            try {
                await ExtensionLogger.exportLogFile(rootPath);
                vscode.window.showInformationMessage('[MicroGit] ログファイルを正常にエクスポートしました！');
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`ログのエクスポートに失敗しました: ${message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.showGraph', async () => {
            if (!workspaceFolders) { return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            if (!syncBranchPolicy(rootPath)) {
                vscode.window.showWarningMessage('MicroGit が無効、または対象ブランチ以外のためグラフを表示できません。');
                return;
            }
            const shadowRepoPath = path.join(rootPath, '.microgit_shadow');

            if (!fs.existsSync(shadowRepoPath)) {
                vscode.window.showWarningMessage('シャドウリポジトリがまだ存在しません。ファイルを保存して履歴を作ってください。');
                return;
            }

            const panel = vscode.window.createWebviewPanel(
                'microgitGraph',
                'MicroGit Graph ビューア',
                vscode.ViewColumn.One,
                { enableScripts: true, localResourceRoots: [] }
            );

            const graphData = getMicroGraphData(shadowRepoPath);
            panel.webview.html = getWebviewContent(graphData);

            panel.webview.onDidReceiveMessage(
                async (message) => {
                    if (message?.command !== 'jumpToCommit') { return; }
                    if (typeof message.hash !== 'string' || !isSafeGitRef(message.hash)) {
                        vscode.window.showErrorMessage('不正なコミット参照です。');
                        return;
                    }
                    await vscode.commands.executeCommand('microgit.jumpToCommit', message.hash);
                    if (!fs.existsSync(shadowRepoPath)) { return; }
                    const updatedData = getMicroGraphData(shadowRepoPath);
                    panel.webview.html = getWebviewContent(updatedData);
                },
                undefined,
                context.subscriptions
            );
        })
    );

    watchGitBranchChanges(context, () => {
        if (!workspaceFolders) { return; }
        syncBranchPolicy(workspaceFolders[0].uri.fsPath);
    });
}

function enqueueSave(task: () => Promise<void>): void {
    saveChain = saveChain.then(task, task);
}

function isEnabled(): boolean {
    return extensionContext?.workspaceState.get<boolean>(STATE_ENABLED, false) ?? false;
}

function getTargetBranch(): string | undefined {
    return extensionContext?.workspaceState.get<string>(STATE_TARGET_BRANCH);
}

async function setEnabled(enabled: boolean, targetBranch?: string): Promise<void> {
    if (!extensionContext) { return; }
    await extensionContext.workspaceState.update(STATE_ENABLED, enabled);
    // 無効化しても対象ブランチは保持し、他ブランチへ切り替えたときの自動削除を継続する
    if (targetBranch) {
        await extensionContext.workspaceState.update(STATE_TARGET_BRANCH, targetBranch);
    }
}

/**
 * 対象ブランチ以外ではシャドウ成果物を削除する。
 * 戻り値は「自動記録してよい状態」（有効かつ対象ブランチ上）のときのみ true。
 */
function syncBranchPolicy(rootPath: string): boolean {
    const targetBranch = getTargetBranch();
    const currentBranch = getCurrentBranch(rootPath);

    if (targetBranch && currentBranch && currentBranch !== 'HEAD' && currentBranch !== targetBranch) {
        removeMicroGitArtifacts(rootPath);
        ExtensionLogger.log(
            `対象ブランチ以外のためシャドウを削除しました（対象: ${targetBranch}, 現在: ${currentBranch}）`,
            'WARN'
        );
        updateStatusBar(rootPath);
        return false;
    }

    updateStatusBar(rootPath);
    return Boolean(isEnabled() && targetBranch && currentBranch && currentBranch === targetBranch);
}

function isOnTargetBranch(rootPath: string): boolean {
    const targetBranch = getTargetBranch();
    const currentBranch = getCurrentBranch(rootPath);
    return Boolean(targetBranch && currentBranch && currentBranch === targetBranch);
}

function isActiveOnCurrentBranch(rootPath: string): boolean {
    return isEnabled() && isOnTargetBranch(rootPath);
}

function removeMicroGitArtifacts(rootPath: string): void {
    for (const dirName of ARTIFACT_DIRS) {
        const artifactPath = path.join(rootPath, dirName);
        if (!fs.existsSync(artifactPath)) { continue; }
        try {
            fs.rmSync(artifactPath, { recursive: true, force: true });
            ExtensionLogger.log(`削除しました: ${dirName}`);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            ExtensionLogger.log(`${dirName} の削除に失敗しました: ${message}`, 'ERROR');
        }
    }
}

function updateStatusBar(rootPath: string | undefined): void {
    if (!statusBarItem) { return; }

    const target = getTargetBranch();
    const current = rootPath ? getCurrentBranch(rootPath) : undefined;
    const onTarget = Boolean(target && current && current === target);

    if (!isEnabled()) {
        statusBarItem.text = target
            ? `$(circle-slash) MicroGit: OFF (${target})`
            : '$(circle-slash) MicroGit: OFF';
        statusBarItem.backgroundColor = undefined;
        return;
    }

    if (onTarget) {
        statusBarItem.text = `$(check) MicroGit: ${target}`;
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = `$(warning) MicroGit: ${target ?? '?'} 以外`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

function getCurrentBranch(repoPath: string): string | undefined {
    try {
        const branch = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
        return branch || undefined;
    } catch {
        return undefined;
    }
}

function watchGitBranchChanges(context: vscode.ExtensionContext, onChange: () => void): void {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) { return; }

    const attach = (api: { repositories: Array<{ state: { onDidChange: (listener: () => void) => vscode.Disposable } }>; onDidOpenRepository: (listener: (repo: { state: { onDidChange: (listener: () => void) => vscode.Disposable } }) => void) => vscode.Disposable }) => {
        for (const repo of api.repositories) {
            context.subscriptions.push(repo.state.onDidChange(onChange));
        }
        context.subscriptions.push(api.onDidOpenRepository((repo) => {
            context.subscriptions.push(repo.state.onDidChange(onChange));
        }));
    };

    const tryAttach = (): boolean => {
        try {
            if (!gitExtension.isActive) { return false; }
            const api = gitExtension.exports?.getAPI?.(1);
            if (!api) { return false; }
            attach(api);
            return true;
        } catch {
            return false;
        }
    };

    if (!tryAttach()) {
        void gitExtension.activate().then(() => {
            tryAttach();
            onChange();
        });
    }
}

/**
 * 引数配列で git を実行し、シェルインジェクションを避ける
 */
function runGit(
    cwd: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv }
): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: options?.env ?? process.env,
    }).toString();
}

function tryRunGit(cwd: string, args: string[]): string | undefined {
    try {
        return runGit(cwd, args);
    } catch {
        return undefined;
    }
}

/** コミットハッシュまたは mb-* タグのみ許可 */
function isSafeGitRef(ref: string): boolean {
    return /^[0-9a-f]{4,40}$/i.test(ref) || /^mb-\d+$/.test(ref);
}

function isSafeRemoteUrl(url: string): boolean {
    if (url.length > 2048 || /[\r\n\0]/.test(url)) { return false; }
    return /^(https:\/\/|git@|ssh:\/\/|git:\/\/|[A-Za-z]:\\)/.test(url)
        || /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(url);
}

function toPosixRelative(rootPath: string, absolutePath: string): string | undefined {
    if (!isPathInsideRoot(absolutePath, rootPath)) { return undefined; }
    const relative = path.relative(rootPath, absolutePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { return undefined; }
    return relative.split(path.sep).join('/');
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedRoot = path.resolve(rootPath);
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

function isSafeRepoRelativePath(relPath: string, rootPath: string): boolean {
    if (!relPath || path.isAbsolute(relPath)) { return false; }
    const normalized = path.normalize(relPath);
    if (normalized.split(path.sep).includes('..')) { return false; }
    return isPathInsideRoot(path.resolve(rootPath, normalized), rootPath);
}

function isMicroGitArtifactPath(filePath: string, rootPath: string): boolean {
    const resolved = path.resolve(filePath);
    return ARTIFACT_DIRS.some((dirName) => {
        const artifactRoot = path.join(rootPath, dirName);
        return resolved === artifactRoot || resolved.startsWith(artifactRoot + path.sep);
    });
}

async function generateMicroGitFileLog(rootPath: string, savedFilePath: string): Promise<void> {
    const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
    const fileName = path.basename(savedFilePath);
    const logFolderPath = path.join(rootPath, '.microgit_logs');
    const logFilePath = path.join(logFolderPath, 'timeline.log');

    try {
        if (!fs.existsSync(shadowRepoPath)) { return; }

        const logOutput = runGit(shadowRepoPath, [
            'log',
            '--graph',
            '--all',
            '--oneline',
            '--decorate',
            '--date=short'
        ]);

        const logContent = `[MicroGit タイムライン履歴 - ${fileName}]\n同期時刻: ${new Date().toLocaleString()}\n現在のタグ: ${currentMicroBranchTag}\n\n${logOutput}`;

        if (!fs.existsSync(logFolderPath)) {
            fs.mkdirSync(logFolderPath, { recursive: true });
        }

        fs.writeFileSync(logFilePath, logContent, 'utf8');
        ExtensionLogger.log(`.microgit_logs/timeline.log を自動更新しました (${fileName})`);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ExtensionLogger.log(`ログ生成に失敗しました: ${message}`, 'ERROR');
    }
}

async function sharedTimeTravel(target: string, rootPath: string): Promise<void> {
    const shadowRepoPath = path.join(rootPath, '.microgit_shadow');

    if (!isSafeGitRef(target)) {
        vscode.window.showErrorMessage('不正なコミット参照です。ハッシュまたは mb-* タグのみ指定できます。');
        return;
    }

    if (!fs.existsSync(shadowRepoPath)) {
        vscode.window.showWarningMessage('シャドウリポジトリがありません。');
        return;
    }

    try {
        runGit(shadowRepoPath, ['checkout', target]);

        const affectedFilesStr = runGit(shadowRepoPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim();
        const affectedFiles = affectedFilesStr.split('\n').filter(Boolean);

        if (affectedFiles.length === 0) {
            const allFilesStr = runGit(shadowRepoPath, ['ls-tree', '--name-only', '-r', 'HEAD']).trim();
            affectedFiles.push(...allFilesStr.split('\n').filter(Boolean));
        }

        for (const relPath of affectedFiles) {
            if (!isSafeRepoRelativePath(relPath, rootPath)) {
                ExtensionLogger.log(`不正なパスをスキップしました: ${relPath}`, 'WARN');
                continue;
            }
            const targetWorkspacePath = path.join(rootPath, relPath);
            try {
                const fileContent = execFileSync('git', ['show', `HEAD:${relPath}`], {
                    cwd: shadowRepoPath,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                });
                if (!fs.existsSync(path.dirname(targetWorkspacePath))) {
                    fs.mkdirSync(path.dirname(targetWorkspacePath), { recursive: true });
                }
                fs.writeFileSync(targetWorkspacePath, fileContent);
            } catch {
                if (fs.existsSync(targetWorkspacePath)) {
                    fs.unlinkSync(targetWorkspacePath);
                }
            }
        }

        if (target.startsWith('mb-')) {
            currentMicroBranchTag = target;
        } else {
            const attachedTag = tryRunGit(shadowRepoPath, ['tag', '--points-at', 'HEAD', '-l', 'mb-*'])?.trim();
            if (attachedTag) {
                currentMicroBranchTag = attachedTag.split('\n')[0];
            }
        }

        vscode.window.showInformationMessage(`[MicroGit] ${target} の状態に一発復元しました！`);
        ExtensionLogger.log(`[タイムトラベル] ${target} の時点に復元。現在のアクティブタグ: ${currentMicroBranchTag}`);
        await ExtensionLogger.exportLogFile(rootPath);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`タイムトラベルに失敗しました: ${message}`);
    }
}

async function runShadowCommit(mainRepoPath: string, savedFilePath: string): Promise<void> {
    const relativeFilePath = toPosixRelative(mainRepoPath, savedFilePath);
    if (!relativeFilePath) {
        ExtensionLogger.log(`ワークスペース外のファイルのためスキップ: ${savedFilePath}`, 'WARN');
        return;
    }

    const shadowRepoPath = path.join(mainRepoPath, '.microgit_shadow');
    const shadowFilePath = path.join(shadowRepoPath, ...relativeFilePath.split('/'));

    if (!isPathInsideRoot(shadowFilePath, shadowRepoPath)) {
        ExtensionLogger.log(`不正なシャドウパスのためスキップ: ${relativeFilePath}`, 'WARN');
        return;
    }

    if (!fs.existsSync(shadowRepoPath)) {
        fs.mkdirSync(shadowRepoPath, { recursive: true });
        runGit(shadowRepoPath, ['init', '-b', 'micro-history']);
    }
    if (!fs.existsSync(path.dirname(shadowFilePath))) {
        fs.mkdirSync(path.dirname(shadowFilePath), { recursive: true });
    }
    try {
        fs.copyFileSync(savedFilePath, shadowFilePath);
    } catch {
        return;
    }

    try {
        runGit(shadowRepoPath, ['add', '--', relativeFilePath]);
        const currentTreeHash = runGit(shadowRepoPath, ['write-tree']).trim();
        if (!/^[0-9a-f]{40}$/i.test(currentTreeHash)) {
            throw new Error('不正な tree ハッシュです');
        }

        let hasCommits = false;
        if (tryRunGit(shadowRepoPath, ['rev-parse', '--verify', 'HEAD']) !== undefined) {
            hasCommits = true;
        }

        let currentHead = '';
        if (hasCommits) {
            currentHead = runGit(shadowRepoPath, ['rev-parse', 'HEAD']).trim();
        }

        let matchingCommit = '';
        if (hasCommits) {
            const logOutput = runGit(shadowRepoPath, ['log', '--all', '--format=%H %T']).trim().split('\n');
            for (const line of logOutput) {
                const [cHash, tHash] = line.split(' ');
                if (tHash === currentTreeHash && isSafeGitRef(cHash)) {
                    matchingCommit = cHash;
                    break;
                }
            }
        }

        if (matchingCommit && currentHead !== matchingCommit) {
            runGit(shadowRepoPath, ['checkout', matchingCommit]);
            const attachedTag = tryRunGit(shadowRepoPath, ['tag', '--points-at', 'HEAD', '-l', 'mb-*'])?.trim();
            if (attachedTag) {
                currentMicroBranchTag = attachedTag.split('\n')[0];
            }
            ExtensionLogger.log(`[Ctrl+Z検知] 過去の状態へ戻りました: ${matchingCommit.substring(0, 7)}`);
            return;
        }
        if (matchingCommit && currentHead === matchingCommit) {
            return;
        }

        const timestamp = new Date().toISOString();
        const commitMessage = `micro: saved ${relativeFilePath} at ${timestamp}`;
        const commitTreeArgs = ['commit-tree', currentTreeHash];
        if (currentHead) {
            if (!isSafeGitRef(currentHead)) {
                throw new Error('不正な parent ハッシュです');
            }
            commitTreeArgs.push('-p', currentHead);
        }
        commitTreeArgs.push('-m', commitMessage);

        const commitHash = runGit(shadowRepoPath, commitTreeArgs, {
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 'MicroGit',
                GIT_AUTHOR_EMAIL: 'microgit@local',
                GIT_COMMITTER_NAME: 'MicroGit',
                GIT_COMMITTER_EMAIL: 'microgit@local',
            },
        }).trim();

        if (!isSafeGitRef(commitHash)) {
            throw new Error('不正な commit ハッシュです');
        }

        runGit(shadowRepoPath, ['update-ref', 'HEAD', commitHash]);

        const tipOfCurrentTag = tryRunGit(shadowRepoPath, ['rev-parse', currentMicroBranchTag])?.trim();
        if (currentHead && tipOfCurrentTag && currentHead !== tipOfCurrentTag) {
            const nextTag = getNextTagCode(shadowRepoPath);
            runGit(shadowRepoPath, ['tag', nextTag, commitHash]);
            currentMicroBranchTag = nextTag;
        } else {
            if (!isSafeGitRef(currentMicroBranchTag)) {
                currentMicroBranchTag = 'mb-1';
            }
            runGit(shadowRepoPath, ['tag', '-f', currentMicroBranchTag, commitHash]);
            runGit(shadowRepoPath, ['update-ref', 'refs/heads/micro-history', commitHash]);
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ExtensionLogger.log(`シャドウコミットに失敗しました: ${message}`, 'ERROR');
    }
}

function getNextTagCode(shadowRepoPath: string): string {
    try {
        const stdout = runGit(shadowRepoPath, ['tag', '-l', 'mb-*']);
        const tags = stdout.trim().split('\n').filter(Boolean);
        let maxNum = 0;
        for (const tag of tags) {
            const match = tag.match(/^mb-(\d+)$/);
            if (match) {
                const num = parseInt(match[1], 10);
                if (num > maxNum) { maxNum = num; }
            }
        }
        return `mb-${maxNum + 1}`;
    } catch {
        return 'mb-1';
    }
}

function detectCurrentTag(shadowRepoPath: string): string {
    try {
        const attached = runGit(shadowRepoPath, ['tag', '--points-at', 'HEAD', '-l', 'mb-*']).trim();
        if (attached) {
            return attached.split('\n')[0];
        }
    } catch { /* fall through */ }
    return 'mb-1';
}

class ExtensionLogger {
    private static outputChannel: vscode.OutputChannel;
    private static logRecords: Array<{ timestamp: string; level: string; message: string }> = [];
    private static readonly maxRecords = 2000;

    public static initialize(channelName: string) {
        this.outputChannel = vscode.window.createOutputChannel(channelName);
    }

    public static log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
        const timestamp = new Date().toISOString();
        if (this.outputChannel) {
            this.outputChannel.appendLine(`[${timestamp}] [${level}] ${message}`);
        }
        this.logRecords.push({ timestamp, level, message });
        if (this.logRecords.length > this.maxRecords) {
            this.logRecords.splice(0, this.logRecords.length - this.maxRecords);
        }
    }

    public static async exportLogFile(workspaceRoot: string) {
        // 対象ブランチ以外では成果物を作らない（他ブランチへの混入防止）
        if (!isOnTargetBranch(workspaceRoot)) { return; }
        try {
            const logFolder = path.join(workspaceRoot, '.microgit_logs');
            if (!fs.existsSync(logFolder)) {
                fs.mkdirSync(logFolder);
            }
            fs.writeFileSync(path.join(logFolder, 'log_latest.json'), JSON.stringify(this.logRecords, null, 2), 'utf8');
        } catch { /* ignore export errors */ }
    }
}

function getMicroGraphData(shadowRepoPath: string): Array<{
    hash: string;
    parents: string[];
    tags: string[];
    subject: string;
    timestamp: string;
}> {
    try {
        const hasCommits = tryRunGit(shadowRepoPath, ['rev-parse', '--verify', 'HEAD']);
        if (!hasCommits) { return []; }

        const stdout = runGit(shadowRepoPath, ['log', '--all', '--topo-order', '--pretty=format:%H|%P|%d|%s|%ct']);
        const lines = stdout.trim().split('\n').filter(Boolean);
        return lines.map(line => {
            const parts = line.split('|');
            const hash = parts[0] || '';
            const parents = parts[1] ? parts[1].split(' ').filter(Boolean) : [];
            const decorations = parts[2] || '';
            const timestampStr = parts[parts.length - 1] || '0';
            const subject = parts.slice(3, parts.length - 1).join('|') || parts[3] || '';
            let tags: string[] = [];
            const tagMatch = decorations.match(/tag:\s*([a-zA-Z0-9_-]+)/g);
            if (tagMatch) {
                tags = tagMatch.map((t: string) => t.replace('tag: ', ''));
            }
            return {
                hash,
                parents,
                tags,
                subject,
                timestamp: new Date(parseInt(timestampStr, 10) * 1000).toLocaleString()
            };
        });
    } catch {
        return [];
    }
}

function getWebviewContent(graphData: Array<{
    hash: string;
    parents: string[];
    tags: string[];
    subject: string;
    timestamp: string;
}>): string {
    if (!graphData || graphData.length === 0) {
        return `<html><body style="background-color:#1e1e1e;color:#fff;padding:20px;"><h3>MicroGit</h3>履歴がまだありません。</body></html>`;
    }

    const commits = [...graphData].reverse();
    const jsonCommits = JSON.stringify(commits);

    return `<!DOCTYPE html>
<html lang="ja">
<head>
    <style>
        body { font-family: sans-serif; background: #1e1e1e; color: #fff; padding: 20px; }
        h3 { color: #888; }
        .node { cursor: pointer; fill: #007acc; transition: 0.2s; }
        .node:hover { fill: #fff; r: 10; }
        .line { stroke: #555; stroke-width: 3px; fill: none; }
        .text { fill: #ccc; font-size: 13px; pointer-events: none; }
        .tag-text { fill: #007acc; font-size: 11px; font-weight: bold; }
    </style>
</head>
<body>
    <h3>MicroGit タイムライン履歴</h3>
    <svg id="graph-area" width="100%" height="${commits.length * 60 + 50}px"></svg>

    <script>
        const vscode = acquireVsCodeApi();
        const commits = ${jsonCommits};
        const svg = document.getElementById('graph-area');

        const nodeMap = new Map();
        const yInterval = 60;
        const branchLanes = new Map();
        let currentMaxLane = 0;

        commits.forEach((c, i) => {
            let lane = 0;
            if (i > 0) {
                const prevCommit = commits[i - 1];
                if (!c.parents.includes(prevCommit.hash)) {
                    currentMaxLane++;
                    lane = currentMaxLane;
                } else {
                    lane = branchLanes.get(prevCommit.hash) || 0;
                }
            }
            branchLanes.set(c.hash, lane);

            const xPosition = 40 + (lane * 35);
            nodeMap.set(c.hash, { x: xPosition, y: i * yInterval + 30 });
        });

        commits.forEach((c) => {
            const childPos = nodeMap.get(c.hash);
            c.parents.forEach(pHash => {
                const parentPos = nodeMap.get(pHash);
                if (parentPos) {
                    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
                    line.setAttribute("x1", childPos.x);
                    line.setAttribute("y1", childPos.y);
                    line.setAttribute("x2", parentPos.x);
                    line.setAttribute("y2", parentPos.y);
                    line.setAttribute("class", "line");
                    svg.appendChild(line);
                }
            });
        });

        commits.forEach((commit) => {
            const pos = nodeMap.get(commit.hash);

            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            circle.setAttribute("cx", pos.x);
            circle.setAttribute("cy", pos.y);
            circle.setAttribute("r", "8");
            circle.setAttribute("class", "node");
            circle.onclick = () => {
                vscode.postMessage({ command: 'jumpToCommit', hash: commit.hash });
            };
            svg.appendChild(circle);

            const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
            text.setAttribute("x", pos.x + 20);
            text.setAttribute("y", pos.y + 5);
            text.setAttribute("class", "text");
            text.textContent = commit.hash.substring(0, 7) + " - " + commit.subject;
            svg.appendChild(text);

            if (commit.tags.length > 0) {
                const tagText = document.createElementNS("http://www.w3.org/2000/svg", "text");
                tagText.setAttribute("x", pos.x + 20);
                tagText.setAttribute("y", pos.y + 20);
                tagText.setAttribute("class", "tag-text");
                tagText.textContent = "[" + commit.tags.join(", ") + "]";
                svg.appendChild(tagText);
            }
        });
    </script>
</body>
</html>`;
}

export function deactivate() {}
