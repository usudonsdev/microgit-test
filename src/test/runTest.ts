import { runTests } from '@vscode/test-electron';
import * as path from 'path';

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        // テスト用VS Codeに、このプロジェクトのルートフォルダを直接引数として渡す
        await runTests({
            extensionDevelopmentPath: extensionDevelopmentPath,
            extensionTestsPath: extensionTestsPath,
            // 👇 配列ではなく、このように直接フォルダパスを含めて引数を渡します
            launchArgs: [
                extensionDevelopmentPath,
                '--disable-extensions' // 他の不要な拡張機能を無効化してテストを安定させる
            ]
        });
    } catch (err) {
        console.error('Failed to run tests');
        process.exit(1);
    }
}

main();