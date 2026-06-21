import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
    console.log('Git Micro-History Tracker が起動しました。');

    // ファイル保存（Ctrl+Sなど）をトリガーにする
    let disposable = vscode.workspace.onDidSaveTextDocument(async (document: vscode.TextDocument) => {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) return;

        const mainRepoPath = workspaceFolder.uri.fsPath; // 本来の作業ディレクトリ
        const savedFilePath = document.uri.fsPath;       // 保存されたファイルの絶対パス

        // .git フォルダがない（Git管理下でない）場合はスキップ
        if (!fs.existsSync(path.join(mainRepoPath, '.git'))) return;

        try {
            // シャドウ・コミット処理を実行
            await runShadowCommit(mainRepoPath, savedFilePath);
        } catch (error) {
            console.error('マイクロコミット失敗:', error);
        }
    });

    context.subscriptions.push(disposable);
}

/**
 * 裏側（シャドウ領域）で自動コミットを行う関数（Windowsセキュリティ対応版）
 */
async function runShadowCommit(mainRepoPath: string, savedFilePath: string) {
    // 1. シャドウ（隠し）リポジトリの配置場所（.git の外の独立した隠しフォルダにする）
    const shadowRepoPath = path.join(mainRepoPath, '.microgit_shadow');
    const relativeFilePath = path.relative(mainRepoPath, savedFilePath);
    const shadowFilePath = path.join(shadowRepoPath, relativeFilePath);

    // 2. 初回のみ：シャドウリポジトリの初期化 (git init を直接叩く)
    if (!fs.existsSync(shadowRepoPath)) {
        fs.mkdirSync(shadowRepoPath, { recursive: true });
        
        // 新規にGitリポジトリを初期化し、初期コミットのブランチ名を micro-history にする
        execSync(`git init -b micro-history`, { cwd: shadowRepoPath, stdio: 'ignore' });
        
        // .microgit_shadow フォルダ自体が本家Gitの管理対象に入らないように、本家の.gitignoreに追記
        const gitignorePath = path.join(mainRepoPath, '.gitignore');
        try {
            fs.appendFileSync(gitignorePath, '\n.microgit_shadow/\n');
        } catch (e) {
            // .gitignoreがなくても処理は続行
        }
    }

    // 3. 保存されたファイルを、シャドウリポジトリの対応する場所に上書きコピー
    const shadowFileDir = path.dirname(shadowFilePath);
    if (!fs.existsSync(shadowFileDir)) {
        fs.mkdirSync(shadowFileDir, { recursive: true });
    }
    fs.copyFileSync(savedFilePath, shadowFilePath);

    // 4. シャドウリポジトリ側で Git Add & Commit を実行
    const timestamp = new Date().toISOString();
    const commitMessage = `micro: saved ${relativeFilePath} at ${timestamp}`;

    try {
        execSync(`git add "${relativeFilePath}"`, { cwd: shadowRepoPath });
        // Windowsの環境変数制約を回避するため、設定を直接インラインで渡してコミット
        execSync(`git -c user.name="MicroBot" -c user.email="bot@micro.internal" commit -m "${commitMessage}"`, { cwd: shadowRepoPath });
        vscode.window.setStatusBarMessage(`[MicroGit] 自動保存コミット完了: ${timestamp}`, 3000);
    } catch (e) {
        // 変更がない場合はここに来るのでスルー
        console.log('変更がないためスキップしました。');
    }
}

export function deactivate() {}