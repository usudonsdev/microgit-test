import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// 💡 現在ユーザーがどのタイムライン（マイクロブランチ）の延長線上にいるかを保持する変数
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

        // シャドウ領域やログフォルダ自体の保存イベントは完全に無視する（安全装置）
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

    // タイムトラベルコマンド（コマンドパレット用）
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

    // 💡 グラフビューアコマンド（GUI表示 ＆ ボタン連動）
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
            vscode.ViewColumn.Two,
            {
                enableScripts: true, // JavaScriptの実行を許可
                localResourceRoots: []
            }
        );

        // 初回描画
        const graphData = getMicroGraphData(shadowRepoPath);
        panel.webview.html = getWebviewContent(graphData);

        // 💡 GUI（Webview）側からの「この時点に戻る」ボタンのクリック信号を受け取るリスナー
        panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'jump':
                        // タイムトラベルを実行
                        await sharedTimeTravel(message.target, rootPath);
                        // 実行後、最新のタグ状態を反映して画面を自動リフレッシュ
                        const updatedData = getMicroGraphData(shadowRepoPath);
                        panel.webview.html = getWebviewContent(updatedData);
                        return;
                }
            },
            undefined,
            context.subscriptions
        );
    });

    context.subscriptions.push(showGraphCommand);
}

/**
 * 💡 タイムトラベル（復元）の共通処理
 */
async function sharedTimeTravel(target: string, rootPath: string) {
    const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        vscode.window.showWarningMessage('内容を復元するため、対象のファイルをエディタで開いた状態で実行してください。');
        return;
    }

    const relativeFilePath = path.relative(rootPath, activeEditor.document.fileName);

    try {
        // ① シャドウ側でHEADを移動
        execSync(`git checkout ${target}`, { cwd: shadowRepoPath, stdio: 'ignore' });

        // ② 移動先のコミットからファイル内容を抽出し、メインのファイルを上書き復元
        const fileContent = execSync(`git show HEAD:"${relativeFilePath}"`, { cwd: shadowRepoPath });
        fs.writeFileSync(activeEditor.document.fileName, fileContent);

        // ③ 現在アクティブなタグ変数を更新
        if (target.startsWith('mb-')) {
            currentMicroBranchTag = target;
        } else {
            try {
                const attachedTag = execSync('git tag --points-at HEAD -l "mb-*"', { cwd: shadowRepoPath }).toString().trim();
                if (attachedTag) {
                    currentMicroBranchTag = attachedTag.split('\n')[0];
                }
            } catch {}
        }

        vscode.window.showInformationMessage(`[MicroGit] ${target} の状態にタイムトラベルしました！`);
        ExtensionLogger.log(`[タイムトラベル] ${relativeFilePath} を ${target} の時点に復元。現在のアクティブタグ: ${currentMicroBranchTag}`);
        await ExtensionLogger.exportLogFile(rootPath);
    } catch (err: any) {
        vscode.window.showErrorMessage(`タイムトラベルに失敗しました: ${err.message}`);
    }
}

/**
 * 裏側（シャドウ領域）で自動コミットおよびタグの制御を行う関数
 */
async function runShadowCommit(mainRepoPath: string, savedFilePath: string) {
    const shadowRepoPath = path.join(mainRepoPath, '.microgit_shadow');
    const relativeFilePath = path.relative(mainRepoPath, savedFilePath);
    const shadowFilePath = path.join(shadowRepoPath, relativeFilePath);

    if (!fs.existsSync(shadowRepoPath)) {
        fs.mkdirSync(shadowRepoPath, { recursive: true });
        try {
            execSync('git init -b micro-history', { cwd: shadowRepoPath, stdio: 'ignore' });
            ExtensionLogger.log(`シャドウリポジトリを初期化しました: ${shadowRepoPath}`);
        } catch (err: any) {
            ExtensionLogger.log(`git init に失敗しました: ${err.message}`, 'ERROR');
        }

        const gitignorePath = path.join(mainRepoPath, '.gitignore');
        try {
            fs.appendFileSync(gitignorePath, '\n.microgit_shadow/\n');
        } catch {}
    }

    const shadowFileDir = path.dirname(shadowFilePath);
    if (!fs.existsSync(shadowFileDir)) {
        fs.mkdirSync(shadowFileDir, { recursive: true });
    }

    try {
        fs.copyFileSync(savedFilePath, shadowFilePath);
    } catch (err: any) {
        ExtensionLogger.log(`ファイルのコピーに失敗しました: ${err.message}`, 'ERROR');
        return;
    }

    let isForwarding = false;
    try {
        const headHash = execSync('git rev-parse HEAD', { cwd: shadowRepoPath }).toString().trim();
        const tagHash = execSync(`git rev-parse ${currentMicroBranchTag}`, { cwd: shadowRepoPath }).toString().trim();
        if (headHash === tagHash) {
            isForwarding = true;
        }
    } catch {}

    const timestamp = new Date().toISOString();
    const commitMessage = `micro: saved ${relativeFilePath} at ${timestamp}`;

    try {
        execSync(`git add "${relativeFilePath}"`, { cwd: shadowRepoPath });
        execSync(`git -c user.name="MicroBot" -c user.email="bot@micro.internal" commit -m "${commitMessage}"`, { cwd: shadowRepoPath });

        if (isForwarding) {
            execSync(`git tag -f ${currentMicroBranchTag}`, { cwd: shadowRepoPath });
            ExtensionLogger.log(`マイクロブランチを前進させました: ${currentMicroBranchTag}`);
        } else {
            const nextTag = getNextTagCode(shadowRepoPath);
            execSync(`git tag ${nextTag}`, { cwd: shadowRepoPath });
            currentMicroBranchTag = nextTag;
            ExtensionLogger.log(`過去から新しいマイクロブランチが分岐しました: ${currentMicroBranchTag}`);
        }

        vscode.window.setStatusBarMessage(`[MicroGit] 保存コミット完了 (${currentMicroBranchTag}): ${timestamp}`, 3000);
        ExtensionLogger.log(`シャドウコミット成功: ${relativeFilePath} (Tag: ${currentMicroBranchTag})`);

        const graphData = getMicroGraphData(shadowRepoPath);
        ExtensionLogger.log(`【現在のツリー状態】\n${JSON.stringify(graphData, null, 2)}`);

    } catch {
        ExtensionLogger.log(`変更がないためコミットをスキップしました: ${relativeFilePath}`);
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
    } catch {
        return 'mb-1';
    }
}

function detectCurrentTag(shadowRepoPath: string): string {
    try {
        const stdout = execSync(
            'git for-each-ref --sort=-committerdate --format="%(refname:short)" refs/tags/mb-*',
            { cwd: shadowRepoPath }
        ).toString().trim();
        const tags = stdout.split('\n').filter(Boolean);
        return tags.length > 0 ? tags[0] : 'mb-1';
    } catch {
        return 'mb-1';
    }
}

class ExtensionLogger {
    private static outputChannel: vscode.OutputChannel;
    private static logRecords: Array<{ timestamp: string; level: string; message: string }> = [];

    public static initialize(channelName: string) {
        this.outputChannel = vscode.window.createOutputChannel(channelName);
    }

    public static log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
        const timestamp = new Date().toISOString();
        const formattedMessage = `[${timestamp}] [${level}] ${message}`;
        if (this.outputChannel) {
            this.outputChannel.appendLine(formattedMessage);
        }
        this.logRecords.push({ timestamp, level, message });
    }

    public static async exportLogFile(workspaceRoot: string) {
        try {
            const logFolder = path.join(workspaceRoot, '.microgit_logs');
            if (!fs.existsSync(logFolder)) {
                fs.mkdirSync(logFolder);
            }
            const filePath = path.join(logFolder, `log_latest.json`);
            fs.writeFileSync(filePath, JSON.stringify(this.logRecords, null, 2), 'utf8');
        } catch (error: any) {
            if (this.outputChannel) {
                this.outputChannel.appendLine(`ログ出力失敗: ${error.message}`);
            }
        }
    }
}

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
            if (tagMatch) {
                tags = tagMatch.map((t: string) => t.replace('tag: ', ''));
            }

            return {
                hash: hash,
                parents: parents,
                tags: tags,
                subject: subject,
                timestamp: new Date(parseInt(timestampStr, 10) * 1000).toLocaleString()
            };
        });
    } catch (err) {
        return [];
    }
}

function getWebviewContent(graphData: any[]): string {
    if (!graphData || graphData.length === 0) {
        return `<html><body style="background-color:#1e1e1e;color:#fff;padding:20px;"><h3>⏱️ MicroGit</h3>履歴がまだありません。</body></html>`;
    }

    const commitsForGraph = [...graphData].reverse();

    // 💡 ユーザーがいまどこのブランチ(タグ)にいるか視覚化するための、現在のアクティブタグ情報を渡す
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
            <div class="subtitle">現在アクティブ: <b>${currentActiveTag}</b></div>
            <div id="control-panel"></div>
        </div>

        <script>
            // VS Codeのメッセージ通信APIを取得
            const vscode = acquireVsCodeApi();
            const rawCommits = ${JSON.stringify(commitsForGraph)};
            const activeTag = "${currentActiveTag}";

            // 1. Gitgraphの描画
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

            // 2. 右側操作カードの動的生成（新しいコミットを上にするために再度逆転）
            const panel = document.getElementById("control-panel");
            [...rawCommits].reverse().forEach(commit => {
                const isActive = commit.tags.includes(activeTag);
                const card = document.createElement("div");
                card.className = "commit-card" + (isActive ? " active" : "");
                
                // タグがあればバッジにする
                const tagSpan = commit.tags.length ? \`<span class="commit-tag">\${commit.tags.join(", ")}</span>\` : "";
                const activeBadge = isActive ? \`<span class="active-badge">現在地</span>\` : "";

                card.innerHTML = \`
                    \${activeBadge}
                    <div class="commit-header">
                        <span class="commit-hash">\${commit.hash.substring(0, 7)}</span>
                        \${tagSpan}
                    </div>
                    <div class="commit-msg">\${commit.subject}</div>
                    <button class="jump-btn" onclick="timeTravel('\${commit.hash}')">この時点に戻る</button>
                \`;
                panel.appendChild(card);
            });

            // ボタンを押した時にVS Code本体へ信号を送る
            function timeTravel(hashOrTag) {
                vscode.postMessage({ command: 'jump', target: hashOrTag });
            }
        </script>
    </body>
    </html>
    `;
}

export function deactivate() {}