import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';


export function activate(context: vscode.ExtensionContext) {
    // 1. ロガーの初期化（VS Codeの出力タブに「MicroGit Logs」チャンネルを作ります）
    ExtensionLogger.initialize('MicroGit Logs');
    ExtensionLogger.log('Git Micro-History Tracker が起動しました。');

    // 2. ログ書き出しコマンドの登録 (Ctrl+Shift+P から "MicroGit: Export Logs" で実行可能)
    const exportCommand = vscode.commands.registerCommand('microgit.exportLogs', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            await ExtensionLogger.exportLogFile(workspaceFolders[0].uri.fsPath);
            vscode.window.showInformationMessage('蓄積された実行ログをファイルに書き出しました！');
        } else {
            vscode.window.showErrorMessage('ワークスペースが開かれていないため、ログを書き出せません。');
        }
    });
    context.subscriptions.push(exportCommand);

    // 3. ファイル保存イベントの監視
    const disposable = vscode.workspace.onDidSaveTextDocument(async (document: vscode.TextDocument) => {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) {
            return;
        }

        const mainRepoPath = workspaceFolder.uri.fsPath;
        const savedFilePath = document.uri.fsPath;

        // .git フォルダがない場合はスキップ（これもログに残すと調査に便利です）
        if (!fs.existsSync(path.join(mainRepoPath, '.git'))) {
            ExtensionLogger.log(`Git管理外のワークスペースのためスキップ: ${mainRepoPath}`, 'WARN');
            return;
        }

        try {
            ExtensionLogger.log(`ファイルの保存を検知しました: ${path.basename(savedFilePath)}`);

            // シャドウ・コミット処理を実行
            await runShadowCommit(mainRepoPath, savedFilePath);

            ExtensionLogger.log(`シャドウコミットが正常に完了しました。`);
        } catch (error: any) {
            // エラーも一元管理
            ExtensionLogger.log(`マイクロコミット失敗: ${error.message || error}`, 'ERROR');
        }
    });

    context.subscriptions.push(disposable);
}

/**
裏側（シャドウ領域）で自動コミットを行う関数（Windowsセキュリティ対応版）
*/
async function runShadowCommit(mainRepoPath: string, savedFilePath: string) {
	// 1. シャドウ（隠し）リポジトリの配置場所（.git の外の独立した隠しフォルダにする）
	const shadowRepoPath = path.join(mainRepoPath, '.microgit_shadow');
	const relativeFilePath = path.relative(mainRepoPath, savedFilePath);
	const shadowFilePath = path.join(shadowRepoPath, relativeFilePath);

	// 2. 初回のみ：シャドウリポジトリの初期化 (git init を直接叩く)
	if (!fs.existsSync(shadowRepoPath)) {
		fs.mkdirSync(shadowRepoPath, {recursive: true});

		// 新規にGitリポジトリを初期化し、初期コミットのブランチ名を micro-history にする
		execSync('git init -b micro-history', {cwd: shadowRepoPath, stdio: 'ignore'});

		// .microgit_shadow フォルダ自体が本家Gitの管理対象に入らないように、本家の.gitignoreに追記
		const gitignorePath = path.join(mainRepoPath, '.gitignore');
		try {
			fs.appendFileSync(gitignorePath, '\n.microgit_shadow/\n');
		} catch {
			// .gitignoreがなくても処理は続行
		}
	}

	// 3. 保存されたファイルを、シャドウリポジトリの対応する場所に上書きコピー
	const shadowFileDir = path.dirname(shadowFilePath);
	if (!fs.existsSync(shadowFileDir)) {
		fs.mkdirSync(shadowFileDir, {recursive: true});
	}

	fs.copyFileSync(savedFilePath, shadowFilePath);

	// 4. シャドウリポジトリ側で Git Add & Commit を実行
	const timestamp = new Date().toISOString();
	const commitMessage = `micro: saved ${relativeFilePath} at ${timestamp}`;

	try {
		execSync(`git add "${relativeFilePath}"`, {cwd: shadowRepoPath});
		// Windowsの環境変数制約を回避するため、設定を直接インラインで渡してコミット
		execSync(`git -c user.name="MicroBot" -c user.email="bot@micro.internal" commit -m "${commitMessage}"`, {cwd: shadowRepoPath});
		vscode.window.setStatusBarMessage(`[MicroGit] 自動保存コミット完了: ${timestamp}`, 3000);
	} catch {
		// 変更がない場合はここに来るのでスルー
		console.log('変更がないためスキップしました。');
	}
}


class ExtensionLogger {
    private static outputChannel: vscode.OutputChannel;
    // メモリ上にログを溜めておく配列（後でまとめて分析するため）
    private static logRecords: Array<{ timestamp: string; level: string; message: string }> = [];

    public static initialize(channelName: string) {
        this.outputChannel = vscode.window.createOutputChannel(channelName);
    }

    /**
     * ログを記録するメインメソッド
     */
    public static log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
        const timestamp = new Date().toISOString();
        const formattedMessage = `[${timestamp}] [${level}] ${message}`;

        // 1. VS Codeの出力ウインドウ（Output）にリアルタイム表示
        if (this.outputChannel) {
            this.outputChannel.appendLine(formattedMessage);
        }

        // 2. メモリ上の配列に蓄積
        this.logRecords.push({ timestamp, level, message });
    }

    /**
     * 溜まったログ（配列）をすべて取得する
     */
    public static getRecords() {
        return this.logRecords;
    }

    /**
     * 調査用に、蓄積されたログをJSONファイルとして作業スペースに書き出す
     */
    public static async exportLogFile(workspaceRoot: string) {
        try {
            const logFolder = path.join(workspaceRoot, '.microgit_logs');
            if (!fs.existsSync(logFolder)) {
                fs.mkdirSync(logFolder);
            }
            const filePath = path.join(logFolder, `log_${Date.now()}.json`);
            fs.writeFileSync(filePath, JSON.stringify(this.logRecords, null, 2), 'utf8');
            this.log(`ログファイルをエクスポートしました: ${filePath}`, 'INFO');
        } catch (error: any) {
            this.outputChannel.appendLine(`ログ出力失敗: ${error.message}`);
        }
    }
}



export function deactivate() {}
