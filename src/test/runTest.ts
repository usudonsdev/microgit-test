import { runTests } from '@vscode/test-electron';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * テスト用の VS Code を起動して、拡張機能テスト（out/test/suite）を流す。
 *
 * ワークスペースは、毎回作る一時的な Git リポジトリ（ブランチ main、最初のコミット 1 つ）。
 * 以前はこのリポジトリそのものを開いていたので、テストのたびに開発中のリポジトリに .microgit_shadow や
 * .git/microgit が残った。MicroGit を有効にして保存・過去に戻る操作まで試すテスト（overlayBackend.test.ts）を
 * 足したので、使い捨てのワークスペースにした（#14）。
 */
async function main() {
    // VS Code（や Electron のアプリ）の中からこのスクリプトを動かすと ELECTRON_RUN_AS_NODE=1 が引き継がれ、
    // テスト用の VS Code が普通の Node として起動して、ワークスペースのパスを JavaScript として読もうとする
    delete process.env.ELECTRON_RUN_AS_NODE;
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-vscode-test-'));
    try {
        const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
        git('init', '-q', '-b', 'main');
        git('config', 'core.autocrlf', 'false');
        fs.writeFileSync(path.join(workspace, 'README.md'), '# MicroGit extension test workspace\n');
        git('add', '-A');
        git('-c', 'user.name=MicroGit Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'init');

        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                workspace,
                '--disable-extensions', // 他の不要な拡張機能を無効化してテストを安定させる
                // 組み込みの Git 拡張機能も止める。ワークスペースの中の Git リポジトリ（.microgit_shadow など）を
                // 見つけて開き、Windows でフォルダを掴んで消せなくする（EPERM）ことがある
                '--disable-extension', 'vscode.git',
            ],
        });
    } catch (err) {
        console.error('Failed to run tests', err);
        process.exitCode = 1;
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

main();
