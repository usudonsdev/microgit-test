import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * 現在ユーザーがどのタイムライン（マイクロブランチ）の延長線上にいるかを保持するグローバル状態
 * @default 'mb-1'
 */
let currentMicroBranchTag: string = 'mb-1';

/**
 * 拡張機能がアクティブになった際に呼び出されるエントリポイント
 * @param context - VS Codeの拡張機能コンテキスト。
 */
export function activate(context: vscode.ExtensionContext) {
    ExtensionLogger.initialize('MicroGit Output');
    ExtensionLogger.log('MicroGit 拡張機能が完全に目覚めました！');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        const rootPath = workspaceFolders[0].uri.fsPath;
        ExtensionLogger.exportLogFile(rootPath);

        const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
        if (fs.existsSync(shadowRepoPath)) {
            currentMicroBranchTag = detectCurrentTag(shadowRepoPath);
            ExtensionLogger.log(`前回のアクティブマイクロブランチを引き継ぎました: ${currentMicroBranchTag}`);
        }
    }

    /**
     * ファイル保存イベントのリスナー
     * ファイルが保存されるたびに裏側でシャドウコミットを実行する。
     */
    vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (!workspaceFolders) { return; }
        const rootPath = workspaceFolders[0].uri.fsPath;

        // シャドウ領域やログフォルダ自体の保存イベントは完全に無視する（無限ループ・エラー防止）
        if (document.fileName.includes('.microgit_shadow') || document.fileName.includes('.microgit_logs')) { return; }

        ExtensionLogger.log(`ファイル保存イベントを検知しました: ${document.fileName}`);
        
        const gitPath = path.join(rootPath, '.git');
        const isTestFile = document.fileName.endsWith('test_dummy.py');
        
        if (!fs.existsSync(gitPath) && !isTestFile) {
            ExtensionLogger.log('Git管理外のフォルダのため、処理をスキップしました。', 'WARN');
            await ExtensionLogger.exportLogFile(rootPath);
            return; 
        }

        // 1. シャドウコミットを実行
        await runShadowCommit(rootPath, document.fileName);
        
        // 2. その場で .microgit_logs を自動生成！
        await generateMicroGitFileLog(rootPath, document.fileName);

        await ExtensionLogger.exportLogFile(rootPath);
    });

    /**
     * 手動タイムトラベルコマンド（コマンドパレット用）
     */
    const jumpCommand = vscode.commands.registerCommand('microgit.jumpToCommit', async (explicitTarget?: string) => {
        const target = explicitTarget || await vscode.window.showInputBox({
            prompt: '戻りたいコミットハッシュ、またはタグ名を入力',
            placeHolder: 'mb-1'
        });
        if (!target || !workspaceFolders) { return; }
        await sharedTimeTravel(target, workspaceFolders[0].uri.fsPath);
    });

    /**
     * チームの最新履歴を大元リポジトリから取得する（Pull）コマンド
     */
    const pullHistoryCommand = vscode.commands.registerCommand('microgit.pullHistory', async () => {
        if (!workspaceFolders) { return; }
        const rootPath = workspaceFolders[0].uri.fsPath;
        const shadowRepoPath = path.join(rootPath, '.microgit_shadow');

        if (!fs.existsSync(shadowRepoPath)) {
            vscode.window.showWarningMessage('シャドウリポジトリがありません。一度ファイルを保存してください。');
            return;
        }

        try {
            vscode.window.setStatusBarMessage(`[MicroGit] チームの履歴を取得中...`, 3000);
            const remoteUrl = execSync('git config --get remote.origin.url', { cwd: rootPath }).toString().trim();
            if (remoteUrl) {
                execSync(`git fetch "${remoteUrl}" micro-history:micro-history --tags -f`, { cwd: shadowRepoPath });
                currentMicroBranchTag = detectCurrentTag(shadowRepoPath);
                vscode.window.showInformationMessage(`[MicroGit] チームの最新マイクロ履歴を同期しました！`);
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`履歴の取得に失敗しました（大元にoriginが設定されていない可能性があります）`);
        }
    });

    /**
     * GUI（グラフビューア）を表示するコマンド
     */
    const showGraphCommand = vscode.commands.registerCommand('microgit.showGraph', async () => {
        if (!workspaceFolders) { return; }
        const rootPath = workspaceFolders[0].uri.fsPath;
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

        // 初回ロード時の描画データを取得してHTMLを流し込む
        const graphData = getMicroGraphData(shadowRepoPath);
        panel.webview.html = getWebviewContent(graphData);

        // Webviewから送られてくるメッセージ（ジャンプ命令）を待ち受ける
        panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'jumpToCommit':
                        // フロントエンドのボタンから届いたハッシュをそのままタイムトラベル処理へ回す
                        await vscode.commands.executeCommand('microgit.jumpToCommit', message.hash);
                        
                        // タイムトラベル完了後、最新の履歴データとアクティブタグをWebviewにプッシュして再描画
                        const updatedData = getMicroGraphData(shadowRepoPath);
                        panel.webview.html = getWebviewContent(updatedData);
                        return;
                }
            },
            undefined,
            context.subscriptions
        );
    });

    context.subscriptions.push(jumpCommand);
    context.subscriptions.push(pullHistoryCommand);
    context.subscriptions.push(showGraphCommand);
}

/**
 * 保存されたファイル名に応じて動的に .microgit_logs を自動生成する
 */
async function generateMicroGitFileLog(rootPath: string, savedFilePath: string): Promise<void> {
    const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
    const fileName = path.basename(savedFilePath);
    const logFolderPath = path.join(rootPath, '.microgit_logs');
    const logFilePath = path.join(logFolderPath, 'timeline.log');

    try {
        if (!fs.existsSync(shadowRepoPath)) { return; }

        const logOutput = runGitCommandAbsolute(shadowRepoPath, [
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
    } catch (err: any) {
        ExtensionLogger.log(`ログ生成に失敗しました: ${err.message}`, 'ERROR');
    }
}

/**
 * 安全に絶対パスを保証してGitコマンドを実行するヘルパー
 */
function runGitCommandAbsolute(repoPath: string, args: string[]): string {
    const safePath = `"${repoPath.replace(/"/g, '\\"')}"`;
    const command = `git -C ${safePath} ${args.join(' ')}`;
    return execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).toString();
}

/**
 * 指定したコミット（またはタグ）の時点へワークスペースのファイルを一発復元する関数
 */
async function sharedTimeTravel(target: string, rootPath: string): Promise<void> {
    const shadowRepoPath = path.join(rootPath, '.microgit_shadow');

    try {
        // シャドウリポジトリのHEADを指定のターゲットへ移動
        execSync(`git checkout ${target}`, { cwd: shadowRepoPath, stdio: 'ignore' });
        
        // ターゲットのコミットで変更されたファイルの一覧を取得
        const affectedFilesStr = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { cwd: shadowRepoPath }).toString().trim();
        const affectedFiles = affectedFilesStr.split('\n').filter(Boolean);

        // 最初のコミットなど、diffが出ない場合はツリー全体からファイルを取得
        if (affectedFiles.length === 0) {
            const allFilesStr = execSync('git ls-tree --name-only -r HEAD', { cwd: shadowRepoPath }).toString().trim();
            affectedFiles.push(...allFilesStr.split('\n').filter(Boolean));
        }

        // 該当ファイルを実際のワークスペースに上書き復元する
        for (const relPath of affectedFiles) {
            const targetWorkspacePath = path.join(rootPath, relPath);
            try {
                const fileContent = execSync(`git show HEAD:"${relPath}"`, { cwd: shadowRepoPath });
                if (!fs.existsSync(path.dirname(targetWorkspacePath))) {
                    fs.mkdirSync(path.dirname(targetWorkspacePath), { recursive: true });
                }
                fs.writeFileSync(targetWorkspacePath, fileContent);
            } catch (fileErr) {
                // ファイルが過去の時点に存在しない（削除されている）場合は、ワークスペースからも削除する
                if (fs.existsSync(targetWorkspacePath)) {
                    fs.unlinkSync(targetWorkspacePath);
                }
            }
        }

        // 現在アクティブなタグを更新
        if (target.startsWith('mb-')) {
            currentMicroBranchTag = target;
        } else {
            try {
                const attachedTag = execSync('git tag --points-at HEAD -l "mb-*"', { cwd: shadowRepoPath }).toString().trim();
                if (attachedTag) { currentMicroBranchTag = attachedTag.split('\n')[0]; }
            } catch {}
        }

        vscode.window.showInformationMessage(`[MicroGit] ${target} の状態に一発復元しました！`);
        ExtensionLogger.log(`[タイムトラベル] ${target} の時点に復元。現在のアクティブタグ: ${currentMicroBranchTag}`);
        await ExtensionLogger.exportLogFile(rootPath);
    } catch (err: any) {
        vscode.window.showErrorMessage(`タイムトラベルに失敗しました: ${err.message}`);
    }
}

/**
 * ファイル保存時に裏側（シャドウ領域）で自動コミットおよびタグの制御を行う関数
 */
async function runShadowCommit(mainRepoPath: string, savedFilePath: string): Promise<void> {
    const shadowRepoPath = path.join(mainRepoPath, '.microgit_shadow');
    const relativeFilePath = path.relative(mainRepoPath, savedFilePath);
    const shadowFilePath = path.join(shadowRepoPath, relativeFilePath);

    if (!fs.existsSync(shadowRepoPath)) {
        fs.mkdirSync(shadowRepoPath, { recursive: true });
        try { execSync('git init -b micro-history', { cwd: shadowRepoPath, stdio: 'ignore' }); } catch {}
        try { fs.appendFileSync(path.join(mainRepoPath, '.gitignore'), '\n.microgit_shadow/\n.microgit_logs/\n'); } catch {}
    }

    if (!fs.existsSync(path.dirname(shadowFilePath))) { fs.mkdirSync(path.dirname(shadowFilePath), { recursive: true }); }

    try { fs.copyFileSync(savedFilePath, shadowFilePath); } catch { return; }

    let headHash = '';
    let isForwarding = false;
    try {
        const hasCommits = execSync('git rev-parse --verify HEAD', { cwd: shadowRepoPath, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
        if (hasCommits) {
            headHash = execSync('git rev-parse HEAD', { cwd: shadowRepoPath }).toString().trim();
            const tagHash = execSync(`git rev-parse ${currentMicroBranchTag}`, { cwd: shadowRepoPath }).toString().trim();
            if (headHash === tagHash) { isForwarding = true; }
        }
    } catch {
        // 初回コミット時は安全に次へ
    }

    const timestamp = new Date().toISOString();
    const commitMessage = `micro: saved ${relativeFilePath} at ${timestamp}`;

    try {
        execSync(`git add "${relativeFilePath}"`, { cwd: shadowRepoPath });

        const treeHash = execSync('git write-tree', { cwd: shadowRepoPath }).toString().trim();
        
        let commitHash = '';
        if (!headHash) {
            commitHash = execSync(`git commit-tree ${treeHash} -m "${commitMessage}"`, { cwd: shadowRepoPath }).toString().trim();
        } else {
            commitHash = execSync(`git commit-tree ${treeHash} -p ${headHash} -m "${commitMessage}"`, { cwd: shadowRepoPath }).toString().trim();
        }

        execSync(`git update-ref HEAD ${commitHash}`, { cwd: shadowRepoPath });

        if (isForwarding) {
            execSync(`git tag -f ${currentMicroBranchTag} ${commitHash}`, { cwd: shadowRepoPath });
        } else {
            const nextTag = getNextTagCode(shadowRepoPath);
            execSync(`git tag ${nextTag} ${commitHash}`, { cwd: shadowRepoPath });
            currentMicroBranchTag = nextTag;
        }

        execSync(`git update-ref refs/heads/micro-history ${commitHash}`, { cwd: shadowRepoPath });

        try {
            const remoteUrl = execSync('git config --get remote.origin.url', { cwd: mainRepoPath }).toString().trim();
            if (remoteUrl) {
                execSync(`git push "${remoteUrl}" micro-history --tags -f`, { cwd: shadowRepoPath, stdio: 'ignore' });
                vscode.window.setStatusBarMessage(`[MicroGit] 大元リモートへ同期完了 (${currentMicroBranchTag})`, 4000);
            } else {
                vscode.window.setStatusBarMessage(`[MicroGit] 保存完了 (${currentMicroBranchTag})`, 3000);
            }
        } catch (pushErr) {
            vscode.window.setStatusBarMessage(`[MicroGit] 保存完了 (リモート未同期)`, 3000);
        }

        const graphData = getMicroGraphData(shadowRepoPath);
        ExtensionLogger.log(`【現在のツリー状態】\n${JSON.stringify(graphData, null, 2)}`);

    } catch (err: any) {
        ExtensionLogger.log(`シャドウコミットに失敗しました: ${err.message}`, 'ERROR');
    }
}

/**
 * 次に付与すべき新しいマイクロブランチタグ（例: mb-2）を計算して返す
 */
function getNextTagCode(shadowRepoPath: string): string {
    try {
        const stdout = execSync('git tag -l "mb-*"', { cwd: shadowRepoPath }).toString();
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
    } catch { return 'mb-1'; }
}

/**
 * 現在チェックアウトされているコミットに紐づいているタグを検出する
 */
function detectCurrentTag(shadowRepoPath: string): string {
    try {
        const stdout = execSync('git for-each-ref --sort=-committerdate --format="%(refname:short)" refs/tags/mb-*', { cwd: shadowRepoPath }).toString().trim();
        const tags = stdout.split('\n').filter(Boolean);
        return tags.length > 0 ? tags[0] : 'mb-1';
    } catch { return 'mb-1'; }
}

/**
 * 拡張機能の内部動作を記録・出力するロガークラス
 */
class ExtensionLogger {
    private static outputChannel: vscode.OutputChannel;
    private static logRecords: Array<{ timestamp: string; level: string; message: string }> = [];

    public static initialize(channelName: string) { this.outputChannel = vscode.window.createOutputChannel(channelName); }

    public static log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
        const timestamp = new Date().toISOString();
        if (this.outputChannel) { this.outputChannel.appendLine(`[${timestamp}] [${level}] ${message}`); }
        this.logRecords.push({ timestamp, level, message });
    }

    public static async exportLogFile(workspaceRoot: string) {
        try {
            const logFolder = path.join(workspaceRoot, '.microgit_logs');
            if (!fs.existsSync(logFolder)) { fs.mkdirSync(logFolder); }
            fs.writeFileSync(path.join(logFolder, `log_latest.json`), JSON.stringify(this.logRecords, null, 2), 'utf8');
        } catch {}
    }
}

/**
 * シャドウリポジトリからコミット履歴を抽出し、グラフ描画用のデータ構造に変換する
 */
function getMicroGraphData(shadowRepoPath: string): any[] {
    try {
        const hasCommits = execSync('git rev-parse --verify HEAD', { cwd: shadowRepoPath, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
        if (!hasCommits) { return []; }

        const stdout = execSync('git log --all --topo-order --pretty=format:"%H|%P|%d|%s|%ct"', { cwd: shadowRepoPath }).toString();
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
            if (tagMatch) { tags = tagMatch.map((t: string) => t.replace('tag: ', '')); }
            return {
                hash: hash,
                parents: parents,
                tags: tags,
                subject: subject,
                timestamp: new Date(parseInt(timestampStr, 10) * 1000).toLocaleString()
            };
        });
    } catch (err) { return []; }
}

/**
 * Webviewに表示するHTMLコンテンツを生成する
 */
function getWebviewContent(graphData: any[]): string {
    if (!graphData || graphData.length === 0) {
        return `<html><body style="background-color:#1e1e1e;color:#fff;padding:20px;"><h3>⏱️ MicroGit</h3>履歴がまだありません。</body></html>`;
    }

    const currentActiveTag = currentMicroBranchTag;

    // Webview上のJavaScript側にデータを安全に渡すため、JSON文字列化
    const jsonCommits = JSON.stringify(graphData);

    return `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: sans-serif; padding: 10px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
        h3 { margin-bottom: 15px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 5px; }
        .commit-node { 
            padding: 10px; margin: 8px 0; 
            border: 1px solid var(--vscode-widget-border); 
            border-radius: 4px; background: var(--vscode-sideBar-background);
            display: flex; justify-content: space-between; align-items: center;
            transition: all 0.2s ease;
        }
        .commit-node:hover { border-color: var(--vscode-button-background); }
        .active-head { border-left: 6px solid #28a745; background: rgba(40, 167, 69, 0.1); }
        .tag-badge { background: #007acc; color: white; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: bold; margin-left: 5px; }
        .jump-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer; font-weight: 500; }
        .jump-btn:hover { background: var(--vscode-button-hoverBackground); }
        .meta-text { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
    </style>
</head>
<body>
    <h3>MicroGit タイムライン履歴</h3>
    <div id="timeline"></div>

    <script>
        const vscode = acquireVsCodeApi();
        const commits = ${jsonCommits};
        const currentTag = "${currentActiveTag}";
        
        const container = document.getElementById('timeline');
        container.innerHTML = ''; 

        commits.forEach(commit => {
            const isCurrent = commit.tags.includes(currentTag);
            const node = document.createElement('div');
            node.className = \`commit-node \${isCurrent ? 'active-head' : ''}\`;
            
            const tagsHtml = commit.tags.map(t => \`<span class="tag-badge">\${t}</span>\`).join(' ');

            node.innerHTML = \`
                <div>
                    <strong>\${commit.hash.substring(0, 7)}</strong> \${tagsHtml}
                    <div class="meta-text">\${commit.subject}</div>
                    <div class="meta-text" style="font-size:10px; opacity:0.7;">🕒 \${commit.timestamp}</div>
                </div>
                <div>
                    <button class="jump-btn" onclick="jump('\${commit.hash}')">ジャンプ</button>
                </div>
            \`;
            container.appendChild(node);
        });

        function jump(hash) {
            vscode.postMessage({
                command: 'jumpToCommit',
                hash: hash
            });
        }
    </script>
</body>
</html>
    `;
}

/**
 * 拡張機能が無効化される際に呼び出されるライフサイクル関数
 */
export function deactivate() {}