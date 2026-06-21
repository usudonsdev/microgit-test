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
 * 裏側（シャドウ領域）で自動コミットを行う関数
 */
async function runShadowCommit(mainRepoPath: string, savedFilePath: string) {
    // 1. シャドウ（隠し）リポジトリの配置場所を決める（.gitの中の隠しフォルダ）
    const shadowRepoPath = path.join(mainRepoPath, '.git', 'micro_shadow');
    const relativeFilePath = path.relative(mainRepoPath, savedFilePath);
    const shadowFilePath = path.join(shadowRepoPath, relativeFilePath);

    // 2. 初回のみ：シャドウリポジトリの初期化（ローカルクローン）
    if (!fs.existsSync(shadowRepoPath)) {
        // メインのリポジトリを、作業コピーを持たない形で別フォルダにクローン
        execSync(`git clone "${mainRepoPath}" "${shadowRepoPath}"`, { stdio: 'ignore' });
        
        // マイクロ履歴専用の「隠しブランチ（micro-history）」を作成
        execSync(`git checkout -b micro-history`, { cwd: shadowRepoPath, stdio: 'ignore' });
    }

    // 3. 保存されたファイルを、シャドウリポジトリの対応する場所に上書きコピー
    const shadowFileDir = path.dirname(shadowFilePath);
    if (!fs.existsSync(shadowFileDir)) {
        fs.mkdirSync(shadowFileDir, { recursive: true });
    }
    fs.copyFileSync(savedFilePath, shadowFilePath);

    // 4. シャドウリポジトリ側で Git Add & Commit を実行
    // 開発者の名前や設定に影響を与えないよう、一時的なユーザー名でコミット
    const timestamp = new Date().toISOString();
    const commitMessage = `micro: saved ${relativeFilePath} at ${timestamp}`;

    execSync(`git add "${relativeFilePath}"`, { cwd: shadowRepoPath });
    
    // 差分がない場合は例外を吐くので、try-catchで囲むか、allow-emptyフラグをつける
    try {
        execSync(`git -c user.name="MicroBot" -c user.email="bot@micro.internal" commit -m "${commitMessage}"`, { cwd: shadowRepoPath });
        vscode.window.setStatusBarMessage(`[MicroGit] 自動保存コミット完了: ${timestamp}`, 3000);
    } catch (e) {
        // 変更が本当になかった場合はここに来るので、無視してOK
        console.log('変更がないため、マイクロコミットをスキップしました。');
    }
}

export function deactivate() {}