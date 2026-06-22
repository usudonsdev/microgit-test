import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

suite('MicroGit Extension Test Suite', function () {
    this.timeout(10000);

    test('ファイル保存時にシャドウコミット処理が走るかテスト', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const rootPath = workspaceFolders ? workspaceFolders[0].uri.fsPath : path.resolve(__dirname, '../../../');
        const testFilePath = path.join(rootPath, 'test_dummy.py');

        if (fs.existsSync(testFilePath)) { fs.unlinkSync(testFilePath); }

        // 1. 初期ファイル書き込み
        fs.writeFileSync(testFilePath, '# Test code\n', 'utf8');

        // 2. エディタで開く
        const document = await vscode.workspace.openTextDocument(testFilePath);
        const editor = await vscode.window.showTextDocument(document);

        // 3. エディタを編集
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(1, 0), 'print("Hello Test")\n');
        });

        // 4. 保存
        const success = await document.save();
        assert.strictEqual(success, true, 'ファイルの保存に失敗しました');

        // 5. シャドウコミットの完了を待つ（少し長めに3秒待ってみます）
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 🔍 【デバッグ用】もしログ書き出し用コマンドがあるなら、ここで強制実行してみる
        try {
            await vscode.commands.executeCommand('extension.exportLogs'); // あなたが登録したExportコマンド名に合わせてください（なければスキップでOK）
        } catch(e) {}

        // 🔍 【超重要】直近に吐き出された拡張機能の生のログファイルを読み込んでターミナルに表示させる
        const logDirPath = path.join(rootPath, '.microgit_logs');
        if (fs.existsSync(logDirPath)) {
            const files = fs.readdirSync(logDirPath).sort();
            if (files.length > 0) {
                const latestLogFile = path.join(logDirPath, files[files.length - 1]);
                const logContent = fs.readFileSync(latestLogFile, 'utf8');
                console.log('\n====== 拡張機能の実行ログ（デバッグ用） ======');
                console.log(logContent);
                console.log('============================================\n');
            }
        } else {
            console.log('\n⚠️ .microgit_logs フォルダ自体が生成されていません。\n');
        }

        // 6. 検証
        const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
        const isShadowExist = fs.existsSync(shadowRepoPath);

        // 後片付け
        if (fs.existsSync(testFilePath)) { fs.unlinkSync(testFilePath); }

        assert.strictEqual(isShadowExist, true, '.microgit_shadow フォルダが生成されていません');
    });
});