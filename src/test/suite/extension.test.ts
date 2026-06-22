import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

suite('MicroGit Extension Test Suite', function () {
    this.timeout(10000);

    test('ファイル保存時にシャドウコミット処理が走るかテスト', async () => {
        // テストファイルの位置から確実にプロジェクトルートの絶対パスを計算
        const rootPath = path.resolve(__dirname, '../../../');
        const testFilePath = path.join(rootPath, 'test_dummy.py');

        if (fs.existsSync(testFilePath)) { fs.unlinkSync(testFilePath); }

        // 1. 初期ファイル書き込み
        fs.writeFileSync(testFilePath, '# Test code\n', 'utf8');

        // 2. エディタで開く
        const document = await vscode.workspace.openTextDocument(testFilePath);
        await vscode.window.showTextDocument(document);

        // 💡 【新対策】エディタが開いてから、VS Codeの内部システムが安定するまで1秒待つ
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 3. エディタを編集
        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'アクティブなエディタが見つかりません');
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(1, 0), 'print("Hello Test")\n');
        });

        // 4. 保存
        const success = await document.save();
        assert.strictEqual(success, true, 'ファイルの保存に失敗しました');

        // 5. シャドウコミットの完了を待つ
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 🔍 ディスクに書き出された本物のログファイルの中身を表示してデバッグする
        const logFilePath = path.join(rootPath, '.microgit_logs', 'log_latest.json');
        if (fs.existsSync(logFilePath)) {
            const logContent = fs.readFileSync(logFilePath, 'utf8');
            console.log('\n====== 🤖 拡張機能のリアルタイム内部ログ ======');
            console.log(logContent);
            console.log('============================================\n');
        } else {
            console.log('\n⚠️ 警告: 拡張機能の起動ログファイルがディスクに生成されていません。\n');
        }

        // 6. 検証
        const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
        const isShadowExist = fs.existsSync(shadowRepoPath);

        if (fs.existsSync(testFilePath)) { fs.unlinkSync(testFilePath); }

        assert.strictEqual(isShadowExist, true, '.microgit_shadow フォルダが生成されていません');
    });
});