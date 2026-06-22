import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// 💡 現在ユーザーがどのタイムライン（マイクロブランチ）の延長線上にいるかを保持する変数
let currentMicroBranchTag: string = 'mb-1';

export function activate(context: vscode.ExtensionContext) {
    // 1. ロガーを初期化して、起動ログを記録
    ExtensionLogger.initialize('MicroGit Output');
    ExtensionLogger.log('MicroGit 拡張機能が完全に目覚めました！');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        const rootPath = workspaceFolders[0].uri.fsPath;
        ExtensionLogger.exportLogFile(rootPath);

        // 💡 起動時に、シャドウリポジトリから直近で使われていたアクティブタグを自動検出して引き継ぐ
        const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
        if (fs.existsSync(shadowRepoPath)) {
            currentMicroBranchTag = detectCurrentTag(shadowRepoPath);
            ExtensionLogger.log(`前回のアクティブマイクロブランチを引き継ぎました: ${currentMicroBranchTag}`);
        }
    }

    // 2. ファイル保存イベントの監視
    vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (!workspaceFolders) { return; }
        const rootPath = workspaceFolders[0].uri.fsPath;

        // 💡【追加】シャドウ領域やログフォルダ自体の保存イベントは完全に無視する
        if (document.fileName.includes('.microgit_shadow') || document.fileName.includes('.microgit_logs')) { return; }

        ExtensionLogger.log(`ファイル保存イベントを検知しました: ${document.fileName}`);
        await ExtensionLogger.exportLogFile(rootPath);

        // 💡【新対策】エディタが開いてから、VS Codeの内部システムが安定するまで1秒待つ

        await new Promise(resolve => setTimeout(resolve, 1000));

        ExtensionLogger.log(`ファイル保存イベントを検知しました: ${document.fileName}`);
        await ExtensionLogger.exportLogFile(rootPath);

        const gitPath = path.join(rootPath, '.git');
        const isTestFile = document.fileName.endsWith('test_dummy.py');
        
        if (!fs.existsSync(gitPath) && !isTestFile) {
            ExtensionLogger.log('Git管理外のフォルダのため、処理をスキップしました。', 'WARN');
            await ExtensionLogger.exportLogFile(rootPath);
            return; 
        }

        // シャドウコミットを実行（内部でタグの自動前進・自動分岐が行われます）
        await runShadowCommit(rootPath, document.fileName);

        // 最終的な結果を書き出す
        await ExtensionLogger.exportLogFile(rootPath);
    });

    // 💡 3. 【試用用】過去のコミットやタグの時点にタイムトラベルするコマンド
    const jumpCommand = vscode.commands.registerCommand('microgit.jumpToCommit', async () => {
        const target = await vscode.window.showInputBox({
            prompt: '戻りたいコミットハッシュ、またはマイクロブランチのタグ名（例: mb-1）を入力してください',
            placeHolder: 'mb-1 または コミットハッシュ'
        });
        if (!target || !workspaceFolders) { return; }

        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showWarningMessage('内容を復元するため、対象のファイルをエディタで開いた状態で実行してください。');
            return;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
        const relativeFilePath = path.relative(rootPath, activeEditor.document.fileName);

        try {
            // ① シャドウ側でHEADを移動（Detached HEAD状態にする）
            execSync(`git checkout ${target}`, { cwd: shadowRepoPath, stdio: 'ignore' });

            // ② 移動先のコミットからファイル内容を抽出し、メインワークスペースのファイルを上書き復元
            const fileContent = execSync(`git show HEAD:"${relativeFilePath}"`, { cwd: shadowRepoPath });
            fs.writeFileSync(activeEditor.document.fileName, fileContent);

            // ③ 現在アクティブなタグ変数を更新
            if (target.startsWith('mb-')) {
                currentMicroBranchTag = target;
            } else {
                // ハッシュ直指定で戻った場合、そのコミットに既存の mb-* タグがあればそれをアクティブにする
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
    });

    context.subscriptions.push(jumpCommand);


    const showGraphCommand = vscode.commands.registerCommand('microgit.showGraph', async () => {
        if (!workspaceFolders) { return; }
        const rootPath = workspaceFolders[0].uri.fsPath;
        const shadowRepoPath = path.join(rootPath, '.microgit_shadow');

        if (!fs.existsSync(shadowRepoPath)) {
            vscode.window.showWarningMessage('シャドウリポジトリがまだ存在しません。ファイルを保存して履歴を作ってください。');
            return;
        }

        // 1. Webviewパネルをエディタの右側（ViewColumn.Two）に作成
        const panel = vscode.window.createWebviewPanel(
            'microgitGraph',               // 識別用のキー
            'MicroGit Graph ビューア',      // タブのタイトル
            vscode.ViewColumn.Two,          // 表示する位置（2列目）
            {
                enableScripts: true,        // Webview内でのJavaScript実行を許可
                localResourceRoots: []
            }
        );

        // 2. シャドウリポジトリから最新のツリーデータ（JSON）を取得
        const graphData = getMicroGraphData(shadowRepoPath);

        // 3. WebviewにHTMLを注入（データを一緒に渡す）
        panel.webview.html = getWebviewContent(graphData);
    });

    context.subscriptions.push(showGraphCommand);
}

/**
 * 裏側（シャドウ領域）で自動コミットおよびタグの制御を行う関数
 */
async function runShadowCommit(mainRepoPath: string, savedFilePath: string) {
    const shadowRepoPath = path.join(mainRepoPath, '.microgit_shadow');
    const relativeFilePath = path.relative(mainRepoPath, savedFilePath);
    const shadowFilePath = path.join(shadowRepoPath, relativeFilePath);

    // シャドウリポジトリの初期化
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

    // 💡 コミットを打つ前に、現在のHEADとアクティブタグのハッシュが一致しているか（＝最前線にいるか）を判定する
    let isForwarding = false;
    try {
        const headHash = execSync('git rev-parse HEAD', { cwd: shadowRepoPath }).toString().trim();
        const tagHash = execSync(`git rev-parse ${currentMicroBranchTag}`, { cwd: shadowRepoPath }).toString().trim();
        if (headHash === tagHash) {
            isForwarding = true; // 最前線にいるので、現在のタグをそのまま進めるモード
        }
    } catch {
        // 初回コミット時やタグがまだ存在しない場合は、一致しない（isForwarding = false）として新規作成へ流す
    }

    const timestamp = new Date().toISOString();
    const commitMessage = `micro: saved ${relativeFilePath} at ${timestamp}`;

    try {
        execSync(`git add "${relativeFilePath}"`, { cwd: shadowRepoPath });
        execSync(`git -c user.name="MicroBot" -c user.email="bot@micro.internal" commit -m "${commitMessage}"`, { cwd: shadowRepoPath });

        // 💡 【タグ制御のコアロジック】
        if (isForwarding) {
            // A. 通常の前進：古い位置のタグを引っぺがして、今作った最新コミットに強制移動（上書き）する
            execSync(`git tag -f ${currentMicroBranchTag}`, { cwd: shadowRepoPath });
            ExtensionLogger.log(`マイクロブランチを前進させました: ${currentMicroBranchTag}`);
        } else {
            // B. 過去からの新規分岐（または初回）：古いタグは過去の遺産として残し、新しい連番タグを発行する
            const nextTag = getNextTagCode(shadowRepoPath);
            execSync(`git tag ${nextTag}`, { cwd: shadowRepoPath });
            currentMicroBranchTag = nextTag; // 現在のアクティブタグを新ブランチに切り替え
            ExtensionLogger.log(`過去から新しいマイクロブランチが分岐しました: ${currentMicroBranchTag}`);
        }

        vscode.window.setStatusBarMessage(`[MicroGit] 保存コミット完了 (${currentMicroBranchTag}): ${timestamp}`, 3000);
        ExtensionLogger.log(`シャドウコミット成功: ${relativeFilePath} (Tag: ${currentMicroBranchTag})`);

        // 現在のツリー状態をキャプチャしてログに出力
        const graphData = getMicroGraphData(shadowRepoPath);
        ExtensionLogger.log(`【現在のツリー状態】\n${JSON.stringify(graphData, null, 2)}`);

    } catch {
        ExtensionLogger.log(`変更がないためコミットをスキップしました: ${relativeFilePath}`);
    }
}

/**
 * 💡 既存の「mb-*」タグの中で最大の数値を探し、次の連番タグ名を生成するヘルパー関数
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
    } catch {
        return 'mb-1';
    }
}

/**
 * 💡 起動時に最も新しく更新された「mb-*」タグを検出するヘルパー関数
 */
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

/**
 * ログ管理クラス
 */
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

/**
 * 💡 【修正版】シャドウリポジトリから、可視化に必要な全履歴データを安全に取得する関数
 */
function getMicroGraphData(shadowRepoPath: string): any[] {
    try {
        // Windows/Mac共通で100%安全なパイプ(|)区切りテキスト方式
        const stdout = execSync('git log --all --topo-order --pretty=format:"%H|%P|%d|%s|%ct"', { cwd: shadowRepoPath }).toString();
        const lines = stdout.trim().split('\n').filter(Boolean);

        return lines.map(line => {
            const parts = line.split('|');
            const hash = parts[0] || '';
            const parents = parts[1] ? parts[1].split(' ').filter(Boolean) : [];
            const decorations = parts[2] || '';
            
            // コミットメッセージに万が一「|」が含まれていた場合を考慮した安全な切り分け
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
        ExtensionLogger.log(`履歴データの取得に失敗しました: ${err}`, 'ERROR');
        return [];
    }
}

/**
 * 💡 【修正版】Webview内に表示するHTMLと@gitgraph/jsの描画ロジックを生成する
 */
function getWebviewContent(graphData: any[]): string {
    // 履歴データがまだ空の場合の安全弁
    if (!graphData || graphData.length === 0) {
        return `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"></head>
        <body style="background-color: #1e1e1e; color: #d4d4d4; font-family: sans-serif; padding: 20px;">
            <h3>⏱️ MicroGit タイムライングラフ</h3>
            <p>履歴データがまだありません。ファイルを変更して保存（コミット）してください。</p>
        </body>
        </html>
        `;
    }

    // データを古い順（コミットされた順）に並び替える
    const commitsForGraph = [...graphData].reverse();

    return `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <title>MicroGit Graph</title>
        <script src="https://cdn.jsdelivr.net/npm/@gitgraph/js"></script>
        <style>
            body {
                background-color: #1e1e1e;
                color: #d4d4d4;
                font-family: sans-serif;
                padding: 20px;
            }
            h3 { color: #61afef; margin-bottom: 20px; }
            #graph-container {
                max-width: 100%;
                overflow-x: auto;
            }
        </style>
    </head>
    <body>
        <h3>⏱️ MicroGit タイムライングラフ</h3>
        
        <div id="graph-container"></div>

        <script>
            const rawCommits = ${JSON.stringify(commitsForGraph)};
            const container = document.getElementById("graph-container");

            // Gitgraph の初期化 (SourceTree風に上から下へ伸びる設定)
            const gitgraph = GitgraphJS.createGitgraph(container, {
                orientation: "vertical",
                template: "metro" 
            });

            const branches = {};
            const commitToBranch = {};

            // 最初のメインブランチを作成
            branches["main"] = gitgraph.branch("root");

            // 全てのコミットを古い順に処理してグラフを組み立てる
            rawCommits.forEach((commit, index) => {
                let currentBranch = branches["main"];

                if (index === 0) {
                    currentBranch.commit({
                        hash: commit.hash.substring(0, 7),
                        subject: commit.subject + " " + (commit.tags.length ? "[" + commit.tags.join(",") + "]" : "")
                    });
                    commitToBranch[commit.hash] = currentBranch;
                } else {
                    const parentHash = commit.parents[0];

                    if (parentHash && commitToBranch[parentHash]) {
                        const parentBranch = commitToBranch[parentHash];
                        const isBranching = rawCommits.slice(0, index).some(c => c.parents.includes(parentHash));
                        
                        if (isBranching || commit.tags.length > 0) {
                            const branchName = commit.tags[0] || "branch-" + commit.hash.substring(0, 4);
                            if (!branches[branchName]) {
                                branches[branchName] = parentBranch.branch(branchName);
                            }
                            currentBranch = branches[branchName];
                        } else {
                            currentBranch = parentBranch;
                        }
                    }

                    currentBranch.commit({
                        hash: commit.hash.substring(0, 7),
                        subject: commit.subject + (commit.tags.length ? " 🏷️ [" + commit.tags.join(",") + "]" : "")
                    });

                    commitToBranch[commit.hash] = currentBranch;
                }
            });
        </script>
    </body>
    </html>
    `;
}

export function deactivate() {}