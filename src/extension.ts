import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    // 1. ロガーを初期化して、起動ログを記録
    ExtensionLogger.initialize('MicroGit Output');
    ExtensionLogger.log('MicroGit 拡張機能が完全に目覚めました！');

    // 💡 【根本解決のキモ】起動した瞬間に、ディスクに物理ログファイルを強制的に書き出す
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        ExtensionLogger.exportLogFile(workspaceFolders[0].uri.fsPath);
    }

    vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (!workspaceFolders) { return; }
        const rootPath = workspaceFolders[0].uri.fsPath;

        // 保存イベントが届いたことを即座に記録してディスクに書き出す
        ExtensionLogger.log(`ファイル保存イベントを検知しました: ${document.fileName}`);
        await ExtensionLogger.exportLogFile(rootPath);

        const gitPath = path.join(rootPath, '.git');
        const isTestFile = document.fileName.endsWith('test_dummy.py');
        
        if (!fs.existsSync(gitPath) && !isTestFile) {
            ExtensionLogger.log('Git管理外のフォルダのため、処理をスキップしました。', 'WARN');
            await ExtensionLogger.exportLogFile(rootPath);
            return; 
        }

        // 引数を正しく渡してシャドウコミットを実行
        await runShadowCommit(rootPath, document.fileName);

        // 最終的な結果を書き出す
        await ExtensionLogger.exportLogFile(rootPath);
    });
}

/**
 * 裏側（シャドウ領域）で自動コミットを行う関数
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

    const timestamp = new Date().toISOString();
    const commitMessage = `micro: saved ${relativeFilePath} at ${timestamp}`;

    try {
        execSync(`git add "${relativeFilePath}"`, { cwd: shadowRepoPath });
        execSync(`git -c user.name="MicroBot" -c user.email="bot@micro.internal" commit -m "${commitMessage}"`, { cwd: shadowRepoPath });
        vscode.window.setStatusBarMessage(`[MicroGit] 自動保存コミット完了: ${timestamp}`, 3000);
        ExtensionLogger.log(`シャドウコミット成功: ${relativeFilePath}`);
    } catch {
        ExtensionLogger.log(`変更がないためコミットをスキップしました: ${relativeFilePath}`);
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

export function deactivate() {}