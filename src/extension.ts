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
 * @param context - VS Codeの拡張機能コンテキスト。コマンドの登録やライフサイクル管理に使用する。
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
        
        // 2. 【最優先修正】Show graphを待たずに、その場で .microgit_logs を自動生成！
        await generateMicroGitFileLog(rootPath, document.fileName);

        await ExtensionLogger.exportLogFile(rootPath);
    });


    /**
 * 保存されたファイル名に応じて動的に .microgit_logs を自動生成する
 */
async function generateMicroGitFileLog(rootPath: string, savedFilePath: string): Promise<void> {
    const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
    const fileName = path.basename(savedFilePath);
    const logFilePath = path.join(rootPath, '.microgit_logs');

    try {
        if (!fs.existsSync(shadowRepoPath)) { return; }

        // 壁打ちメモにあった「git log --graph --all」をここで実行し、Gitが認識するすべての分岐を回収する
        const logOutput = runGitCommandAbsolute(shadowRepoPath, [
            'log',
            '--graph',
            '--all',
            '--oneline',
            '--decorate',
            '--date=short'
        ]);

        const logContent = `[MicroGit タイムライン履歴 - ${fileName}]\n同期時刻: ${new Date().toLocaleString()}\n現在のタグ: ${currentMicroBranchTag}\n\n${logOutput}`;
        
        // フォルダがなければ作成して書き込み
        if (!fs.existsSync(path.dirname(logFilePath))) {
            fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
        }
        fs.writeFileSync(logFilePath, logContent, 'utf8');
        ExtensionLogger.log(`.microgit_logs を自動更新しました (${fileName})`);
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
     * 手動タイムトラベルコマンド（コマンドパレット用）
     */
    const jumpCommand = vscode.commands.registerCommand('microgit.jumpToCommit', async () => {
        const target = await vscode.window.showInputBox({
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

        const graphData = getMicroGraphData(shadowRepoPath);
        panel.webview.html = getWebviewContent(graphData);

        panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'jump':
                        await sharedTimeTravel(message.target, rootPath);
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
 * 指定したコミット（またはタグ）の時点へワークスペースのファイルを一発復元する関数
 * @param target - 復元先のコミットハッシュ、またはタグ名（例: 'mb-2'）
 * @param rootPath - 現在開いているワークスペースのルートディレクトリパス
 * @returns 非同期処理の完了を表すPromise
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
 * 分岐時にはコミットツリーを正しく配管し、真の歴史ツリーを形成します。
 */
async function runShadowCommit(mainRepoPath: string, savedFilePath: string): Promise<void> {
    const shadowRepoPath = path.join(mainRepoPath, '.microgit_shadow');
    const relativeFilePath = path.relative(mainRepoPath, savedFilePath);
    const shadowFilePath = path.join(shadowRepoPath, relativeFilePath);

    // シャドウリポジトリが存在しない場合の初期化処理
    if (!fs.existsSync(shadowRepoPath)) {
        fs.mkdirSync(shadowRepoPath, { recursive: true });
        try { execSync('git init -b micro-history', { cwd: shadowRepoPath, stdio: 'ignore' }); } catch {}
        try { fs.appendFileSync(path.join(mainRepoPath, '.gitignore'), '\n.microgit_shadow/\n.microgit_logs/\n'); } catch {}
    }

    if (!fs.existsSync(path.dirname(shadowFilePath))) { fs.mkdirSync(path.dirname(shadowFilePath), { recursive: true }); }

    // 保存された最新状態のファイルをシャドウ領域にコピー
    try { fs.copyFileSync(savedFilePath, shadowFilePath); } catch { return; }

    // 現在のHEADのハッシュを取得（初回コミット時は空になる）
    let headHash = '';
    let isForwarding = false;
    try {
        headHash = execSync('git rev-parse HEAD', { cwd: shadowRepoPath }).toString().trim();
        const tagHash = execSync(`git rev-parse ${currentMicroBranchTag}`, { cwd: shadowRepoPath }).toString().trim();
        if (headHash === tagHash) { isForwarding = true; }
    } catch {}

    const timestamp = new Date().toISOString();
    const commitMessage = `micro: saved ${relativeFilePath} at ${timestamp}`;

    try {
        // ファイルをインデックスに追加
        execSync(`git add "${relativeFilePath}"`, { cwd: shadowRepoPath });

        // 💡 【核心の修正】通常の git commit を使わず、コミットオブジェクトを手動構築する
        // これにより、過去のどの地点からでも綺麗な「分岐（マルチペアレント・マルチブランチ）」が可能になります
        const treeHash = execSync('git write-tree', { cwd: shadowRepoPath }).toString().trim();
        
        let commitHash = '';
        if (!headHash) {
            // 初回コミット（親なし）
            commitHash = execSync(`git commit-tree ${treeHash} -m "${commitMessage}"`, { cwd: shadowRepoPath }).toString().trim();
        } else {
            // 親コミット（headHash）を明示的に指定してコミットツリーを作成
            commitHash = execSync(`git commit-tree ${treeHash} -p ${headHash} -m "${commitMessage}"`, { cwd: shadowRepoPath }).toString().trim();
        }

        // HEADポインタをこの新しいコミットに移動（デタッチド状態の維持・制御）
        execSync(`git update-ref HEAD ${commitHash}`, { cwd: shadowRepoPath });

        if (isForwarding) {
            // 直列前進：既存のタグを新しいコミットへ付け替える
            execSync(`git tag -f ${currentMicroBranchTag} ${commitHash}`, { cwd: shadowRepoPath });
        } else {
            // 分岐：新しい連番のタグを生成して付与する
            const nextTag = getNextTagCode(shadowRepoPath);
            execSync(`git tag ${nextTag} ${commitHash}`, { cwd: shadowRepoPath });
            currentMicroBranchTag = nextTag;
        }

        // 💡 micro-history ブランチ自体も常に現在の最新コミット（または全てのタグ）を指すように安全に更新
        execSync(`git update-ref refs/heads/micro-history ${commitHash}`, { cwd: shadowRepoPath });

        // 大元リポジトリのoriginを読み取り、自動プッシュを試みる
        try {
            const remoteUrl = execSync('git config --get remote.origin.url', { cwd: mainRepoPath }).toString().trim();
            if (remoteUrl) {
                // 分岐履歴がすべてリモートに届くよう、ブランチだけでなく--tagsを付与して安全にプッシュ
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
 * @param shadowRepoPath - シャドウリポジトリのパス
 * @returns 次のタグ名となる文字列
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
 * @param shadowRepoPath - シャドウリポジトリのパス
 * @returns 検出されたタグ名、存在しない場合は 'mb-1'
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

    /**
     * ロガーを初期化し、VS Codeの「出力」パネルに専用チャンネルを作成する
     * @param channelName - 出力パネルに表示される名前
     */
    public static initialize(channelName: string) { this.outputChannel = vscode.window.createOutputChannel(channelName); }

    /**
     * メッセージをログとして記録する
     * @param message - 記録するメッセージの内容
     * @param level - ログの重要度（デフォルトは 'INFO'）
     */
    public static log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
        const timestamp = new Date().toISOString();
        if (this.outputChannel) { this.outputChannel.appendLine(`[${timestamp}] [${level}] ${message}`); }
        this.logRecords.push({ timestamp, level, message });
    }

    /**
     * 蓄積されたログをワークスペース内のJSONファイルとしてエクスポートする
     * @param workspaceRoot - ワークスペースのルートパス
     */
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
 * @param shadowRepoPath - シャドウリポジトリのパス
 * @returns コミット情報の配列
 */
function getMicroGraphData(shadowRepoPath: string): any[] {
    try {
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
 * @param graphData - `getMicroGraphData` で抽出したコミット情報の配列
 * @returns Webview用の完全なHTML文字列
 */
function getWebviewContent(graphData: any[]): string {
    if (!graphData || graphData.length === 0) {
        return `<html><body style="background-color:#1e1e1e;color:#fff;padding:20px;"><h3>⏱️ MicroGit</h3>履歴がまだありません。</body></html>`;
    }

    const commitsForGraph = [...graphData].reverse();
    const currentActiveTag = currentMicroBranchTag;

    return `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <script src="https://cdn.jsdelivr.net/npm/@gitgraph/js"></script>
        <style>
            body { background-color: #1e1e1e; color: #d4d4d4; font-family: sans-serif; padding: 10px; margin: 0; display: flex; height: 100vh; overflow: hidden; }
            #left-layout { flex: 1; overflow-y: auto; padding: 10px; }
            #right-layout { width: 340px; border-left: 1px solid #333; background-color: #252526; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; }
            h3 { color: #61afef; margin-top: 0; margin-bottom: 5px; font-size: 16px; }
            .subtitle { color: #888; font-size: 11px; margin-bottom: 15px; }
            .commit-card { background: #1e1e1e; border: 1px solid #444; border-radius: 4px; padding: 10px; margin-bottom: 10px; font-size: 12px; position: relative; }
            .commit-card.active { border-color: #61afef; background-color: #1c2c3a; }
            .commit-header { display: flex; justify-content: space-between; margin-bottom: 5px; }
            .commit-hash { color: #da70d6; font-family: monospace; font-weight: bold; }
            .commit-tag { background: #98c379; color: #1e1e1e; padding: 1px 5px; border-radius: 3px; font-weight: bold; font-size: 10px; }
            .commit-msg { color: #e5c07b; margin-bottom: 8px; word-break: break-all; font-family: monospace; }
            .jump-btn { width: 100%; background: #4b5263; color: white; border: none; padding: 6px; border-radius: 3px; cursor: pointer; font-weight: bold; transition: background 0.2s; }
            .jump-btn:hover { background: #61afef; }
            .active-badge { position: absolute; top: -8px; right: 10px; background: #61afef; color: #1e1e1e; font-size: 9px; padding: 1px 4px; border-radius: 3px; font-weight: bold; }
        </style>
    </head>
    <body>
        <div id="left-layout">
            <h3>⏱️ MicroGit タイムライングラフ</h3>
            <div id="graph-container"></div>
        </div>
        <div id="right-layout">
            <h3>🛠️ 操作・履歴一覧</h3>
            <div class="subtitle">現在地: <b>${currentActiveTag}</b></div>
            <div id="control-panel"></div>
        </div>
        <script>
            const vscode = acquireVsCodeApi();
            const rawCommits = ${JSON.stringify(commitsForGraph)};
            const activeTag = "${currentActiveTag}";
            const container = document.getElementById("graph-container");
            const gitgraph = GitgraphJS.createGitgraph(container, { orientation: "vertical", template: "metro" });
            const branches = { "main": gitgraph.branch("root") };
            const commitToBranch = {};

            rawCommits.forEach((commit, index) => {
                let currentBranch = branches["main"];
                if (index === 0) {
                    currentBranch.commit({ hash: commit.hash.substring(0, 7), subject: commit.subject });
                    commitToBranch[commit.hash] = currentBranch;
                } else {
                    const parentHash = commit.parents[0];
                    if (parentHash && commitToBranch[parentHash]) {
                        const parentBranch = commitToBranch[parentHash];
                        const isBranching = rawCommits.slice(0, index).some(c => c.parents.includes(parentHash));
                        if (isBranching || commit.tags.length > 0) {
                            const branchName = commit.tags[0] || "branch-" + commit.hash.substring(0, 4);
                            if (!branches[branchName]) { branches[branchName] = parentBranch.branch(branchName); }
                            currentBranch = branches[branchName];
                        } else { currentBranch = parentBranch; }
                    }
                    currentBranch.commit({ hash: commit.hash.substring(0, 7), subject: commit.subject + (commit.tags.length ? " [" + commit.tags.join(",") + "]" : "") });
                    commitToBranch[commit.hash] = currentBranch;
                }
            });

            const panel = document.getElementById("control-panel");
            [...rawCommits].reverse().forEach(commit => {
                const isActive = commit.tags.includes(activeTag);
                const card = document.createElement("div");
                card.className = "commit-card" + (isActive ? " active" : "");
                const tagSpan = commit.tags.length ? \`<span class="commit-tag">\${commit.tags.join(", ")}</span>\` : "";
                const activeBadge = isActive ? \`<span class="active-badge">現在地</span>\` : "";
                card.innerHTML = \`
                    \${activeBadge}
                    <div class="commit-header">
                        <span class="commit-hash">\${commit.hash.substring(0, 7)}</span>
                        \${tagSpan}
                    </div>
                    <div class="commit-msg">\${commit.subject}</div>
                    <button class="jump-btn" onclick="timeTravel('\${commit.hash}')">この時点に一発復元</button>
                \`;
                panel.appendChild(card);
            });
            function timeTravel(hashOrTag) { vscode.postMessage({ command: 'jump', target: hashOrTag }); }
        </script>
    </body>
    </html>
    `;
}

/**
 * 拡張機能が無効化される際に呼び出されるライフサイクル関数
 */
export function deactivate() {}