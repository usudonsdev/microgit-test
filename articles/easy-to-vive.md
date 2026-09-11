---
title: "無料AIエージェントについて考える —— GitHub Copilot完全トークン移行後の無料バイブコーディング"
emoji: "🌊"
type: "tech" # tech: 技術記事 / idea: アイデア
topics: ["vscode", "gemini", "ai", "ペアプログラミング", "個人開発"]
published: false
---

こんにちは、開発者の臼丼（@usudonsdev）です。

昨今のAIによるコーディング支援の進化には目を見張るものがあります。GitHub CopilotやCursorなどを導入し、AIにコンテキストを理解させながら開発を進めるスタイルが定着しつつあります。

しかし、個人開発者や学生にとって、これらの有償ツールには共通の**「壁」**が存在します。

- 月額のサブスクリプション費用
- 大規模なプロジェクトを一気に読み込ませようとした際の**「コンテキストウィンドウ（トークン上限）の制限」**
- 月ごとの高速推論の利用上限

「課金枠の上限を気にしながら恐る恐るAIを使うの、疲れませんか？」
「それなら、**最強のコンテキストウィンドウ（最大200万トークン）を誇る無料版のGemini**に、プロジェクトのコンテキストを丸ごとぶん投げて、無制限にペアプロすればいいのでは？」

今回は、そんな思想から生まれたVS Code拡張機能**「EasyToVibe」**を使い、完全無料で極上の疑似ライブコーディング（バイブコーディング）のワークフローを構築する話を紹介します。

---

## 🚀 すぐに使いたい方はこちら（Marketplaceで公開中！）

「自分で拡張機能を作るのはちょっと面倒、まずは試してみたい！」という方向けに、VS Code Marketplaceに公開しました。

VS Codeの拡張機能タブから **「EasyToVibe」** と検索するか、以下のリンクからインストールして今すぐお使いいただけます。

[👉 EasyToVibe - VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=usudonsdev.easy-to-vibe)

### 使い方
インストール後、ワークスペースを開いた状態で `Ctrl + Shift + P`（Macは `Cmd + Shift + P`）を押し、**「AI用: プロジェクトの全コードをMarkdown化」** を実行するだけです！

---

## 1. 125万行の絶望と、コンテキスト超スリム化へのアプローチ

最初は、単純に「ローカルのプロジェクト内の全ファイルをスキャンして、1つのMarkdownに結合するスクリプト」を作りました。

しかし、いざ個人開発中のVS Code拡張機能プロジェクトで実行してみると、出力されたMarkdownはなんと**125万行**という凄まじいボリュームになってしまいました。原因は明らかで、`node_modules` やビルド生成物（`dist` や `build`）の中身まで全てテキストとしてスキャンしてしまっていたからです。これではいくら太っ腹なGeminiでも処理しきれません。

私たちがAIに渡したいのは、**「自分が書いたコード（ソースコード）」と「全体のディレクトリ構造」だけ**です。

そこで、以下の2つのアプローチを取り入れました。

1. `.gitignore` の除外ルールを自動的にパースし、対象外のファイルは中身を読み込まない。
2. `node_modules` などの特定ディレクトリは、**「構造（ツリー）には場所だけ残すが、中身の走査からは除外する」**。

これにより、125万行あったテキストが**数百〜数千行の「黄金のコンテキスト」へと劇的にスリム化**されました。

---

## 2. VS Code拡張機能「EasyToVibe」のコアロジック

今回マーケットプレイスに公開した `EasyToVibe` の中心となるロジック（`extension.js`）は以下の通りです。`.gitignore` を正確に解釈するために、軽量なパースライブラリ `ignore` を依存関係に含めて処理しています。

```javascript
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const ignore = require('ignore');

// ツリー構造には出すが、中身のソースコード出力からは除外するディレクトリ
const CONTENT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', 'markdowns']);

// テキストとして読み込む対象の拡張子
const VALID_EXTENSIONS = new Set(['.py', '.c', '.h', '.java', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.md', '.yml', '.yaml']);

function getGitignoreFilter(workspaceRoot) {
    const ig = ignore();
    ig.add(['.git', 'markdowns']); 
    
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        try {
            const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
            ig.add(gitignoreContent);
        } catch (e) {
            console.error('.gitignore の読み込みに失敗しました:', e);
        }
    }
    return ig;
}

function generateTree(dirPath, workspaceRoot, ig, prefix = "") {
    let treeStr = "";
    if (!fs.existsSync(dirPath)) return treeStr;

    const files = fs.readdirSync(dirPath).sort();
    const filtered = files.filter(file => {
        const fullPath = path.join(dirPath, file);
        const relativePath = path.relative(workspaceRoot, fullPath);
        const isDir = fs.statSync(fullPath).isDirectory();
        const checkPath = isDir ? `${relativePath}/` : relativePath;
        return !ig.ignores(checkPath);
    });

    filtered.forEach((file, i) => {
        const isLast = i === filtered.length - 1;
        const connector = isLast ? "└── " : "├── ";
        const fullPath = path.join(dirPath, file);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
            treeStr += `${prefix}${connector}${file}/\n`;
            if (CONTENT_SKIP_DIRS.has(file)) {
                treeStr += `${prefix}${isLast ? "    " : "│   "}└── (...contents skipped...)\n`;
            } else {
                const newPrefix = prefix + (isLast ? "    " : "│   ");
                treeStr += generateTree(fullPath, workspaceRoot, ig, newPrefix);
            }
        } else {
            if (VALID_EXTENSIONS.has(path.extname(file))) {
                treeStr += `${prefix}${connector}${file}\n`;
            }
        }
    });
    return treeStr;
}

function bundleCode(workspaceRoot) {
    const rootName = path.basename(workspaceRoot);
    const ig = getGitignoreFilter(workspaceRoot);

    let markdown = `# Project Context: ${rootName}\n\n## Directory Structure\n\`\`\`text\n${rootName}/\n`;
    markdown += generateTree(workspaceRoot, workspaceRoot, ig);
    markdown += `\`\`\`\n\n## Source Code Files\n\n`;

    function walk(currentDir) {
        if (!fs.existsSync(currentDir)) return;
        const files = fs.readdirSync(currentDir);

        files.forEach(file => {
            const fullPath = path.join(currentDir, file);
            const relativePath = path.relative(workspaceRoot, fullPath);
            const stats = fs.statSync(fullPath);
            const isDir = stats.isDirectory();
            const checkPath = isDir ? `${relativePath}/` : relativePath;

            if (ig.ignores(checkPath)) return;

            if (isDir) {
                if (CONTENT_SKIP_DIRS.has(file)) return;
                walk(fullPath);
            } else {
                if (VALID_EXTENSIONS.has(path.extname(file))) {
                    const lang = path.extname(file).slice(1);
                    markdown += `### File: \`${relativePath}\`\n\`\`\`${lang}\n`;
                    try {
                        markdown += fs.readFileSync(fullPath, 'utf-8');
                    } catch (e) {
                        markdown += `// Error reading file: ${e.message}\n`;
                    }
                    markdown += `\n\`\`\`\n\n`;
                }
            }
        });
    }

    walk(workspaceRoot);
    return markdown;
}

function activate(context) {
    let disposable = vscode.commands.registerCommand('easy-to-vibe.copyContext', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('ワークスペースが開かれていません。');
            return;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        vscode.window.showInformationMessage('プロジェクトをスキャン中...');
        
        const markdownResult = bundleCode(rootPath);
        const outputDir = path.join(rootPath, 'markdowns');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const now = new Date();
        const timestamp = now.getFullYear() + 
            String(now.getMonth() + 1).padStart(2, '0') + 
            String(now.getDate()).padStart(2, '0') + '_' + 
            String(now.getHours()).padStart(2, '0') + 
            String(now.getMinutes()).padStart(2, '0') + 
            String(now.getSeconds()).padStart(2, '0');
        
        const outputFileName = `project_context_${timestamp}.md`;
        const outputFilePath = path.join(outputDir, outputFileName);
        
        try {
            fs.writeFileSync(outputFilePath, markdownResult, 'utf-8');
            vscode.window.showInformationMessage(`保存成功: markdowns/${outputFileName}`);
            const document = await vscode.workspace.openTextDocument(outputFilePath);
            await vscode.window.showTextDocument(document);
        } catch (error) {
            vscode.window.showErrorMessage(`保存失敗: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}

module.exports = { activate, deactivate: function(){} };
```

## 3. Geminiの「Gems」で最強の相棒を召喚する

この拡張機能を使って出力したMarkdownファイルを、無料版Gemini（Google AI StudioやGemini AdvancedのGems機能など）にドラッグ＆ドロップして読み込ませます。

その際、AIを「優秀なシニア開発者の相棒」にするためのカスタム指示（システムプロンプト）を設定しておくのが、バイブスを合わせるための重要な秘訣です。

### 🤖 Gems（システムプロンプト）の指示

```plaintext
ユーザーから、プロジェクトのディレクトリ構造とソースコードが統合されたマークダウンファイル（Project Context）が提供されます。
あなたは、優秀で親しみやすく、かつ的確な指摘を行うシニア開発者（ペアプログラミングの相棒）として振る舞い、以下のガイドラインに従って「疑似ライブコーディング」のワークフローを形成してください。

### 1. 基本方針と出力フォーマット
- 返答はすべて「Markdown」形式で、構造的に美しく、パッと見で理解しやすく出力してください。
- ユーザーからコードが渡された直後の最初の返答では、まず「プロジェクト全体の概要（何をしようとしているコードか）」を1〜2行で簡潔に要約し、把握したことを示してください。

### 2. 疑似ライブコーディングの進行
- 一度に大量の修正案を提示してユーザーを圧倒しないでください。
- ライブコーディングのように、「まずはここから直していきましょう」「次は〜を実装しましょう」と、ステップバイステップで対話をリードしてください。
- 修正コードを提示する場合は、変更前後の差分が分かりやすいように、該当ファイル名（例: `### 修正: src/main.c`）を明記し、コードブロックを使ってください。

### 3. 对話の締めくくり（次のステップ）
- 返答の最後には必ず、ユーザーが次に取るべきアクションや、次に議論したいポイントを「1つの明確な質問、または次のステップの提案」として投げかけ、コーディングのグルーヴ（流れ）を止めないようにしてください。
```

## 4. 完成した「無限バイブコーディング」の極上ワークフロー

この環境を構築したことで、開発の流れは劇的に変わりました。

1. **コードを書く**：ローカル環境で通常通りゴリゴリ開発。
2. **コマンドパレット起動**：`Ctrl + Shift + P`（Macは `Cmd + Shift + P`）で「AI用: プロジェクトの全コードをMarkdown化」を実行。
3. **Markdown自動展開**：`markdowns/` フォルダにタイムスタンプ付きのMarkdownが生成され、VS Code上で自動的にパッと開く。
4. **AIへ共有**：そのファイルをGemini（Gems）へドラッグ＆ドロップ。
5. **セッション開始**：

Gemini側は、プロジェクトのファイル依存関係や `.github/workflows/ci.yml` などのCI構成、`.vscode/settings.json` の設定まで完全に頭に入った状態で、次のように語りかけてきます。

> 「〇〇機能の実装ですね！全体構造を見ましたが、`src/extension.ts` のこの関数の部分、ファイル保存時に同期処理が走っていて少し重くなりそうです。まずはここを非同期化するところから一緒にやっていきませんか？」

あとは、「じゃあそこ直して」「次はこの関数を追加したいんだけど、どこに書くのが綺麗？」と、まるで隣にシニアエンジニアが座っているかのような、流れるような対話型ライブコーディングが始まります。

---

## まとめ：無料AIエージェントの未来

高機能なAI課金ツールは非常に魅力的ですし、もちろん素晴らしい体験を提供してくれます。

しかし、**「ローカルでの適切なコンテキスト抽出（.gitignore対応）」×「LLMの巨大なコンテキストウィンドウ（無料Gemini）」** というハックを組み合わせることで、お金を一切かけなくても、それに匹敵する（あるいはトークン上限を気にしない分、それ以上の）最高に気持ちいい開発環境を作ることができます。

ぜひ皆さんも手元で `EasyToVibe` を動かして、激安開発を体感してみてください！
