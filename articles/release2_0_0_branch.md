---
title: "Ctrl+Zで『さっきのコード』を消滅させないために、保存で歴史が分岐するVS Code拡張を作った"
emoji: "⏱️"
type: "tech" # tech: 技術記事 / idea: アイデア
topics: ["vscode", "git", "typescript", "svg", "webview"]
published: true
---

# 「保存」を歴史の分岐へ。Ctrl+Zの限界を超えてタイムトラベルできるVS Code拡張機能を作った話

プログラミングをしていて、一番絶望する瞬間はいつでしょうか？
それは**「Ctrl + Z」を連連打して過去のコードに戻し、その状態で新しいコードを書き始めた瞬間**かもしれません。

一度戻った状態から別のアイデアを試し始めたら最後、先ほどまで書いていた「さっきのコード（未来の履歴）」は、エディタのバッファ（Undoスタック）から完全に消滅し、もう二度と元には戻せなくなります。

「Gitでコミットするほどではないけれど、消すにはあまりにも惜しい、数分間の試行錯誤のプロセス」
この**「Ctrl + Z」で戻った後に変更すると前の変更が消える問題**を根本から解決し、すべての保存を非破壊的なタイムラインとして可視化するVS Code拡張機能「MicroGit」を作りました。

---

## 💡 解決したかった課題：Ctrl+Zの悲劇からの解放

一般的な開発フローでは、以下のような「あるある」が発生します。

1. アイデアAを試すためにコードを10行書く（上書き保存）
2. 「うーん、やっぱりイマイチだな」と思い、**Ctrl + Zを連打して元に戻す**
3. 別のアイデアBを試すために1行書き換えて**保存**する
4. **結果：アイデアAの10行は宇宙の彼方に消滅する**

Gitで細かくブランチを切れば防げますが、数分単位のちょっとした実験のために手動でブランチを作るのはあまりにも面倒です。
そこで、**「ファイル保存をトリガーに、裏側で自動的に歴史を枝分かれ（フォーク）させる」**仕組みを実装しました。

---

## 🛠 技術的なアプローチ：Shadow Repositoryと非線形コミット

この拡張機能は、メインプロジェクトの `.git` とは完全に独立した、独自の隠しシャドウリポジトリ（`.microgit_shadow`）を裏側で管理しています。

最大の特徴は、通常の `git commit` コマンドを一切使わず、**Gitの低レベル配管コマンドである `git commit-tree` を直接叩いている点**です。これにより、現在のHEADポインタ（過去に戻っているならその時点）を明示的に親（`-p`）として指定し、完全に非線形な「歴史の枝分かれ」をコード保存と同時に自動生成しています。

### 核心となるシャドウコミット処理（TypeScript）

```typescript
// ファイル保存時に裏側で自動的に歴史を構築する
async function runShadowCommit(mainRepoPath: string, savedFilePath: string): Promise<void> {
    // ...（シャドウ領域へのファイル同期などの前処理）

    // 💡 通常の git commit は使わない！
    // 過去の特定地点（headHash）を明示的に親に指定してコミットオブジェクトを手動構築
    const treeHash = execSync('git write-tree', { cwd: shadowRepoPath }).toString().trim();
    let commitHash = '';
    
    if (!headHash) {
        commitHash = execSync(`git commit-tree ${treeHash} -m "${commitMessage}"`, { cwd: shadowRepoPath }).toString().trim();
    } else {
        // ここで過去の任意のコミットを親（-p）に結びつけることで、Ctrl+Zで戻った後の分岐を可能にする
        commitHash = execSync(`git commit-tree ${treeHash} -p ${headHash} -m "${commitMessage}"`, { cwd: shadowRepoPath }).toString().trim();
    }

    // HEADポインタをこの新しいコミットに移動
    execSync(`git update-ref HEAD ${commitHash}`, { cwd: shadowRepoPath });

    // 直列前進なら既存タグを移動、過去からの分岐なら新しい連番タグ（mb-2など）を生成
    if (isForwarding) {
        execSync(`git tag -f ${currentMicroBranchTag} ${commitHash}`, { cwd: shadowRepoPath });
    } else {
        const nextTag = getNextTagCode(shadowRepoPath);
        execSync(`git tag ${nextTag} ${commitHash}`, { cwd: shadowRepoPath });
        currentMicroBranchTag = nextTag;
    }
}
```

### 🎨 可視化：SVGで描くインタラクティブなGitグラフ

歴史が自動で分岐するようになっても、CLIの文字列だけでは自分が今どの世界線にいるのか分からなくなります。そこで、VS CodeのWebviewを使い、親子関係を自動で解析して結線するSVGグラフビューアを実装しました。

Webview側の動的線画ロジック（JavaScript）
バックエンドから送られてきた parents（親ハッシュの配列）のデータを元に、子ノードから親ノードへ向かって動的にSVGの <line> 要素を引いています。

```javascript
// 各コミットの親子関係をループで回してSVGの線を引く
commits.forEach((c) => {
    const childPos = nodeMap.get(c.hash);
    c.parents.forEach(pHash => {
        const parentPos = nodeMap.get(pHash);
        if (parentPos) {
            const line = document.createElementNS("[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)", "line");
            line.setAttribute("x1", childPos.x);
            line.setAttribute("y1", childPos.y);
            line.setAttribute("x2", parentPos.x);
            line.setAttribute("y2", parentPos.y);
            line.setAttribute("class", "line"); // CSSで太さや色を調整
            svg.appendChild(line);
        }
    });
});
```

## 🚀 タイムトラベル開発が生み出す圧倒的な安心感

完成した拡張機能の動作がこちらです。

ファイルを何回か保存すると、Webview上にノードが縦に並び、線で繋がります。

グラフ上の「丸（ノード）」をポチッとクリックすると、フロントからバックエンドへメッセージが飛び、一瞬でその瞬間のコードがエディタに復元されます。

過去に戻った状態でコードを書き換えて保存すると、古いノードから新しい線がパッと枝分かれして伸びていきます。

これによって、「あっちの書き方も試したいけれど、今のコードが消えるのは嫌だな」という迷いが一切消え去りました。Ctrl + Zによるバッファ消滅を恐れる必要はもうありません。すべての試行錯誤がログとして美しく残るからです。

## 🏁 まとめとこれからの野望

「保存」という、これまでは上書きでしかなかった行為を「新しい世界線の作成」へと昇華させることで、開発の実験効率が劇的に向上しました。

今後は、分岐した歴史同士の差分（diff）をVS Code標準の差分ビューで一発確認できる機能や、この細かいマイクロ履歴をチームメンバー間で自動同期して「隣の席の人が2分前にやっていた試行錯誤」すら覗き見れるように拡張していきたいと考えています。

「Ctrl+Zの限界に怯えない開発環境」に興味が湧いた方は、ぜひ拡張機能開発で git commit-tree を弄ってみてください！