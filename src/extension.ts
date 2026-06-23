import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

let currentMicroBranchTag: string = 'mb-1';

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

    // ファイル保存イベントの監視
    vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (!workspaceFolders) { return; }
        const rootPath = workspaceFolders[0].uri.fsPath;

        if (document.fileName.includes('.microgit_shadow') || document.fileName.includes('.microgit_logs')) { return; }

        ExtensionLogger.log(`ファイル保存イベントを検知しました: ${document.fileName}`);
        
        const gitPath = path.join(rootPath, '.git');
        const isTestFile = document.fileName.endsWith('test_dummy.py');
        
        if (!fs.existsSync(gitPath) && !isTestFile) {
            ExtensionLogger.log('Git管理外のフォルダのため、処理をスキップしました。', 'WARN');
            await ExtensionLogger.exportLogFile(rootPath);
            return; 
        }

        await runShadowCommit(rootPath, document.fileName);
        await ExtensionLogger.exportLogFile(rootPath);
    });

    // タイムトラベルコマンド
    const jumpCommand = vscode.commands.registerCommand('microgit.jumpToCommit', async () => {
        const target = await vscode.window.showInputBox({
            prompt: '戻りたいコミットハッシュ、またはマイクロブランチのタグ名（例: mb-1）を入力してください',
            placeHolder: 'mb-1 または コミットハッシュ'
        });
        if (!target || !workspaceFolders) { return; }
        const rootPath = workspaceFolders[0].uri.fsPath;
        await sharedTimeTravel(target, rootPath);
    });

    context.subscriptions.push(jumpCommand);

    // 履歴消去コマンド
    const clearHistoryCommand = vscode.commands.registerCommand('microgit.clearHistory', async () => {
        const confirm = await vscode.window.showWarningMessage(
            '本当にMicroGitのすべての履歴を完全に削除しますか？（現在のファイルは影響を受けません）',
            { modal: true },
            'はい、削除します'
        );
        if (confirm !== 'はい、削除します' || !workspaceFolders) { return; }
        const rootPath = workspaceFolders[0].uri.fsPath;
        const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
        const logFolderPath = path.join(rootPath, '.microgit_logs');
        try {
            if (fs.existsSync(shadowRepoPath)) { fs.rmSync(shadowRepoPath, { recursive: true, force: true }); }
            if (fs.existsSync(logFolderPath)) { fs.rmSync(logFolderPath, { recursive: true, force: true }); }
            currentMicroBranchTag = 'mb-1';
            vscode.window.showInformationMessage('[MicroGit] すべての履歴を完全に消去しました。');
        } catch (err: any) {
            vscode.window.showErrorMessage(`履歴の削除に失敗しました: ${err.message}`);
        }
    });

    context.subscriptions.push(clearHistoryCommand);

    // グラフビューアコマンド
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
            'MicroGit 本頑丈グラフ',
            vscode.ViewColumn.Two,
            { enableScripts: true, localResourceRoots: [] }
        );

        // 安全に拡張機能側でHTMLをビルドして渡す
        const graphData = getMicroGraphData(shadowRepoPath);
        panel.webview.html = getWebviewContent(graphData, currentMicroBranchTag);

        panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'jump':
                        await sharedTimeTravel(message.target, rootPath);
                        const updatedData = getMicroGraphData(shadowRepoPath);
                        panel.webview.html = getWebviewContent(updatedData, currentMicroBranchTag);
                        return;
                }
            },
            undefined,
            context.subscriptions
        );
    });

    context.subscriptions.push(showGraphCommand);
}

async function sharedTimeTravel(target: string, rootPath: string) {
    const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        vscode.window.showWarningMessage('対象のファイルをエディタで開いた状態で実行してください。');
        return;
    }
    const relativeFilePath = path.relative(rootPath, activeEditor.document.fileName);
    try {
        execSync(`git checkout ${target}`, { cwd: shadowRepoPath, stdio: 'ignore' });
        const fileContent = execSync(`git show HEAD:"${relativeFilePath}"`, { cwd: shadowRepoPath });
        fs.writeFileSync(activeEditor.document.fileName, fileContent);

        if (target.startsWith('mb-')) {
            currentMicroBranchTag = target;
        } else {
            try {
                const attachedTag = execSync('git tag --points-at HEAD -l "mb-*"', { cwd: shadowRepoPath }).toString().trim();
                if (attachedTag) { currentMicroBranchTag = attachedTag.split('\n')[0]; }
            } catch {}
        }
        vscode.window.showInformationMessage(`[MicroGit] ${target} の状態にタイムトラベルしました！`);
        await ExtensionLogger.exportLogFile(rootPath);
    } catch (err: any) {
        vscode.window.showErrorMessage(`タイムトラベルに失敗しました: ${err.message}`);
    }
}

async function runShadowCommit(mainRepoPath: string, savedFilePath: string) {
    const shadowRepoPath = path.join(mainRepoPath, '.microgit_shadow');
    const relativeFilePath = path.relative(mainRepoPath, savedFilePath);
    const shadowFilePath = path.join(shadowRepoPath, relativeFilePath);

    if (!fs.existsSync(shadowRepoPath)) {
        fs.mkdirSync(shadowRepoPath, { recursive: true });
        try { execSync('git init -b micro-history', { cwd: shadowRepoPath, stdio: 'ignore' }); } catch {}
        try { fs.appendFileSync(path.join(mainRepoPath, '.gitignore'), '\n.microgit_shadow/\n.microgit_logs/\n'); } catch {}
    }

    if (!fs.existsSync(path.dirname(shadowFilePath))) {
        fs.mkdirSync(path.dirname(shadowFilePath), { recursive: true });
    }

    try { fs.copyFileSync(savedFilePath, shadowFilePath); } catch { return; }

    let isForwarding = false;
    try {
        const headHash = execSync('git rev-parse HEAD', { cwd: shadowRepoPath }).toString().trim();
        const tagHash = execSync(`git rev-parse ${currentMicroBranchTag}`, { cwd: shadowRepoPath }).toString().trim();
        if (headHash === tagHash) { isForwarding = true; }
    } catch {}

    const timestamp = new Date().toISOString();
    const commitMessage = `micro: saved ${relativeFilePath} at ${timestamp}`;

    try {
        execSync(`git add "${relativeFilePath}"`, { cwd: shadowRepoPath });
        execSync(`git -c user.name="MicroBot" -c user.email="bot@micro.internal" commit -m "${commitMessage}"`, { cwd: shadowRepoPath });

        if (isForwarding) {
            execSync(`git tag -f ${currentMicroBranchTag}`, { cwd: shadowRepoPath });
        } else {
            const nextTag = getNextTagCode(shadowRepoPath);
            execSync(`git tag ${nextTag}`, { cwd: shadowRepoPath });
            currentMicroBranchTag = nextTag;
        }
        vscode.window.setStatusBarMessage(`[MicroGit] コミット完了 (${currentMicroBranchTag})`, 3000);
    } catch {
        // 変更がない場合はここに来るが、現在のブランチ位置を維持するためにHEADが指すタグを再同期
        try {
            const attachedTag = execSync('git tag --points-at HEAD -l "mb-*"', { cwd: shadowRepoPath }).toString().trim();
            if (attachedTag) { currentMicroBranchTag = attachedTag.split('\n')[0]; }
        } catch {}
    }
}

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

function detectCurrentTag(shadowRepoPath: string): string {
    try {
        const stdout = execSync('git for-each-ref --sort=-committerdate --format="%(refname:short)" refs/tags/mb-*', { cwd: shadowRepoPath }).toString().trim();
        const tags = stdout.split('\n').filter(Boolean);
        return tags.length > 0 ? tags[0] : 'mb-1';
    } catch { return 'mb-1'; }
}

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

function getMicroGraphData(shadowRepoPath: string): any[] {
    try {
        const stdout = execSync('git log --all --topo-order --pretty=format:"%H|%P|%d|%s|%ct"', { cwd: shadowRepoPath }).toString();
        return stdout.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('|');
            const hash = parts[0] || '';
            const decorations = parts[2] || '';
            const timestampStr = parts[parts.length - 1] || '0';
            const subject = parts.slice(3, parts.length - 1).join('|') || parts[3] || '';
            let tags: string[] = [];
            const tagMatch = decorations.match(/tag:\s*([a-zA-Z0-9_-]+)/g);
            if (tagMatch) { tags = tagMatch.map((t: string) => t.replace('tag: ', '')); }
            return {
                hash: hash,
                tags: tags,
                subject: subject,
                timestamp: new Date(parseInt(timestampStr, 10) * 1000).toLocaleString()
            };
        });
    } catch { return []; }
}

function escapeHtml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// 💡 完全にスタンドアロン（外部通信なし）で動くHTML生成ロジック
function getWebviewContent(graphData: any[], currentActiveTag: string): string {
    let leftTimelineHtml = '';
    let rightControlHtml = '';

    graphData.forEach(commit => {
        const isActive = commit.tags.includes(currentActiveTag);
        const tagBadges = commit.tags.map((t: string) => `<span class="commit-tag">${t}</span>`).join(' ');
        const activeBadge = isActive ? `<span class="active-badge">現在地</span>` : '';
        const activeClass = isActive ? 'active' : '';

        // 左側：HTML/CSSによる縦型タイムライン
        leftTimelineHtml += `
            <div class="timeline-item ${activeClass}">
                <div class="timeline-dot"></div>
                <div class="timeline-content">
                    <div class="commit-header-row">
                        <span class="commit-hash">${commit.hash.substring(0, 7)}</span>
                        ${tagBadges}
                    </div>
                    <div class="commit-msg">${escapeHtml(commit.subject)}</div>
                    <div class="commit-date">${commit.timestamp}</div>
                </div>
            </div>
        `;

        // 右側：操作パネル
        rightControlHtml += `
            <div class="commit-card ${activeClass}">
                ${activeBadge}
                <div class="commit-header">
                    <span class="commit-hash">${commit.hash.substring(0, 7)}</span>
                    ${commit.tags.length ? `<span class="commit-tag">${commit.tags.join(', ')}</span>` : ''}
                </div>
                <div class="commit-msg" style="font-size:11px; color:#aaa;">${escapeHtml(commit.subject)}</div>
                <button class="jump-btn" onclick="timeTravel('${commit.hash}')">この時点に戻る</button>
            </div>
        `;
    });

    return `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <style>
            body { background-color: #1e1e1e; color: #d4d4d4; font-family: sans-serif; padding: 10px; margin: 0; display: flex; height: 100vh; overflow: hidden; }
            #left-layout { flex: 1; overflow-y: auto; padding: 10px; position: relative; }
            #right-layout { width: 320px; border-left: 1px solid #333; background-color: #252526; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; }
            h3 { color: #61afef; margin-top: 0; margin-bottom: 5px; font-size: 15px; }
            .subtitle { color: #888; font-size: 11px; margin-bottom: 15px; }
            
            /* 頑丈なピュアCSSタイムライン構造 */
            .timeline-container { position: relative; padding-left: 25px; margin-top: 20px; }
            .timeline-container::before { content: ''; position: absolute; left: 5px; top: 5px; bottom: 5px; width: 2px; background: #444; }
            .timeline-item { position: relative; margin-bottom: 15px; }
            .timeline-dot { position: absolute; left: -24px; top: 6px; width: 10px; height: 10px; border-radius: 50%; background: #555; border: 2px solid #1e1e1e; }
            .timeline-item.active .timeline-dot { background: #61afef; box-shadow: 0 0 8px #61afef; width: 12px; height: 12px; left: -25px; }
            .timeline-content { background: #252526; padding: 8px 12px; border-radius: 4px; border: 1px solid #333; font-size: 12px; }
            .timeline-item.active .timeline-content { border-color: #61afef; background-color: #1a2633; }
            
            .commit-header-row { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
            .commit-hash { color: #da70d6; font-family: monospace; font-weight: bold; }
            .commit-tag { background: #98c379; color: #1e1e1e; padding: 1px 4px; border-radius: 3px; font-weight: bold; font-size: 10px; }
            .commit-msg { color: #e5c07b; font-family: monospace; word-break: break-all; }
            .commit-date { color: #777; font-size: 10px; margin-top: 4px; }

            /* 右側カード用 */
            .commit-card { background: #1e1e1e; border: 1px solid #444; border-radius: 4px; padding: 10px; margin-bottom: 10px; font-size: 12px; position: relative; }
            .commit-card.active { border-color: #61afef; background-color: #1c2c3a; }
            .commit-header { display: flex; justify-content: space-between; margin-bottom: 5px; }
            .jump-btn { width: 100%; background: #4b5263; color: white; border: none; padding: 6px; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px; margin-top: 5px; }
            .jump-btn:hover { background: #61afef; }
            .active-badge { position: absolute; top: -8px; right: 10px; background: #61afef; color: #1e1e1e; font-size: 9px; padding: 1px 4px; border-radius: 3px; font-weight: bold; }
        </style>
    </head>
    <body>
        <div id="left-layout">
            <h3>⏱️ MicroGit タイムライン</h3>
            <div class="timeline-container">${leftTimelineHtml}</div>
        </div>
        <div id="right-layout">
            <h3>🛠️ 操作パネル</h3>
            <div class="subtitle">現在アクティブ: <b>${currentActiveTag}</b></div>
            <div id="control-panel">${rightControlHtml}</div>
        </div>
        <script>
            const vscode = acquireVsCodeApi();
            function timeTravel(hash) {
                vscode.postMessage({ command: 'jump', target: hash });
            }
        </script>
    </body>
    </html>
    `;
}

export function deactivate() {}