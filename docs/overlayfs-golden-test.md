# OverlayFS ゴールデンテスト

| 項目 | 内容 |
|---|---|
| Issue | #10（Epic #8、Phase 0 の最初の成果物） |
| 版 | 初版（2026-09-25）：マージ済みビューの比較のみ |
| 関連 | [要件定義書](./microgit-kernel-feature-portability-requirements.md) FR-1・FR-2・NFR-5、[補足](./microgit-kernel-feature-portability-supplement.md) S-4・S-13、[NodeOverlay.md](./NodeOverlay.md) |

## 1. 目的

Linux カーネルの OverlayFS の挙動を正解として記録し、全バックエンドの受け入れ基準をそれに揃える。
FR-1（全ホストで同一の挙動）、FR-2（既存テストが新実装でも通る）、NFR-5（フォールバック維持）の受け入れ基準はどれも「同一テスト」に依存しているのに、そのテストが未定義だった（補足 S-13）。

今回の版で比べるのは **各コミット時点のマージ済みビュー**（FR-2 の `view`）だけ。upper の中身（whiteout の表現、opaque の xattr、redirect）は比べない。Node 実装のレイヤ形式はカーネルと意図的に違う（`.wh.*` ファイル）ので、層そのものを比べても意味がないため。

## 2. 仕組み

```
scripts/golden/overlayfs-scenarios.mjs   シナリオ（正本。両側がこれを読む）
scripts/golden/record-kernel.mjs         カーネルで期待値を記録 → test/golden/overlayfs/*.golden, meta.json
scripts/golden/check-node.mjs            Node 実装で流して照合  → test/golden/overlayfs/node-known-diffs.txt と比較
```

### 2.1 シナリオ

コミットの列。各コミットは親（省略時は直前）と操作（`write` / `rm` / `rmdir` / `mkdir` / `mv`）を持つ。同じ親を持つコミットを置くと枝分かれになる。書式はシナリオファイル冒頭のコメントを参照。

### 2.2 カーネル側（record-kernel.mjs）

- `unshare -Urm` で非特権のユーザー／mount 名前空間に入り、その中で mount する。Windows では `wsl.exe` 経由で同じことをする
- コミット i ＝ 祖先の層を `lowerdir` に積み、空の `upperdir` に操作を書いて unmount したもの。凍結した upper が次のコミットの lower になる（FR-2 の初期案そのまま。補足 S-5 の遅延 mount やバッチ凍結は #12 で決める）
- 期待値 ＝ 祖先＋自分の層だけを `lowerdir` にした読み取り専用 mount の中身
- 出力形式：1 行 1 エントリ、`種別<TAB>パス[<TAB>詳細]`、パスのバイト順。種別は `d`（ディレクトリ）、`f`（ファイル、詳細は sha256）、`l`（シンボリックリンク、詳細はリンク先）、`o`（その他）

**罠：** ユーザー名前空間で mount すると、workdir の中に名前空間の root 所有・パーミッション 000 の `work` ディレクトリが残る。名前空間の外からは消せないので、後片付けは名前空間の中（スクリプトの `trap`）でやる。

### 2.3 Node 側（check-node.mjs）

MicroGit の保存経路と同じ道を通す。操作を shadow Git の作業ツリーに当ててコミットし、`exportCommitLayer` → `ensureExpandedView` で得たビューを 2 通り比べる。

| モード | 中身 |
|---|---|
| saved | 保存時に `expandViewAfterExport` が親ビューから伸ばしたビュー |
| rebuilt | `views/` を消して、レイヤだけから組み直したビュー |

コミットの作者と日時は固定して、コミットハッシュを毎回・どの OS でも同じにしている。Node 側の壊れ方（§4 の N-3）で、ツリーの `git show` 出力がファイルに書かれ、その中にハッシュが混ざるため。

例外はエラーの種類を残さず `! error` とだけ記録する。同じ失敗でも OS でコードが変わるため（ディレクトリの `unlink` は Windows で `EPERM`、Linux で `EISDIR`）。種類は `--verbose` で見られる。

### 2.4 既知の食い違いの一覧

Node 実装がカーネルと食い違う点は `node-known-diffs.txt` にそのまま記録してある。照合結果がこの一覧と **違えば失敗** する。新しい食い違いが出たときも、既知の食い違いが直ったときも気づけるようにするため。直したら `--update-known` で一覧を書き直す。

## 3. 使い方

```bash
npm run golden:check                       # どの OS でも可。CI でも実行する
npm run golden:check -- --update-known     # 既知の一覧を今の結果で書き直す
npm run golden:record                      # 期待値を取り直す。Linux か、WSL2 のある Windows で
```

シナリオを足したら `golden:record` → `golden:check -- --update-known` の順に流し、一覧に増えた行を §4 に分類して書く。

## 4. 現行 Node 実装との食い違い（2026-09-25 時点、12 シナリオ中 16 ビュー）

Windows（Node 25）と WSL2 上の Linux（Node 22）の両方で同じ一覧になることを確認した。

| # | シナリオ | 食い違い | 原因 | 分類 |
|---|---|---|---|---|
| N-1 | delete-dir、rename-dir | ディレクトリを中身ごと消す・名前を変えると、Node のビューには空になった元のディレクトリ（`d`、`d/sub`）が残る | Git はディレクトリを記録しないので、`exportCommitLayer` はファイル単位の whiteout しか書けない。`applyLayerOntoMerge` はファイルを消すだけで、空になった親は残す | **Git を正本にする限り避けられない** |
| N-2 | empty-dir | 空ディレクトリが Node のビューに出ない | Git は空ディレクトリを記録しない | **同上** |
| N-3 | file-to-dir | 保存時に `exportCommitLayer` が例外で止まる。レイヤにはファイル `p` として `git show <commit>:p`（ツリーの一覧）が書かれ、組み直したビューにその壊れたファイルが出る | `git show <commit>:<path>` が成功すればファイルとみなしている。`p` がツリーになっても成功するため一覧を書き、続く `p/q.txt` の mkdir が失敗する | **現行 MicroGit の不具合** |
| N-4 | dir-to-file | 保存時に例外。組み直すときも例外 | 保存時：消えた `p/q.txt` の whiteout を、ファイルになった `p` の下に作ろうとする。組み直し時：既存のディレクトリ `p` を `unlinkSync` で消そうとする | **現行 MicroGit の不具合** |
| N-5 | whiteout-lookalike-name | `.wh.` で始まる普通のファイルが消える。`d/.wh.x` しか持たない `d` はディレクトリごと出ない | Node 実装は whiteout を「`.wh.<名前>` という空ファイル」で表す（AUFS 方式）ので、普通のファイルと区別できない。カーネルの whiteout は 0/0 のキャラクタデバイス | **現行 MicroGit の不具合**（名前の衝突） |

### 4.1 分類から言えること

- **N-1・N-2 は O-10（正本の定義、#11）の判断材料。** カーネルは「ファイルを 1 つずつ消した」（`delete-file` の commit 3 ではディレクトリが残る）と「ディレクトリごと消した」（`delete-dir` ではディレクトリも消える）を区別するが、Git からはこの 2 つを区別できない。したがって Git を正本にして層を Git から組み直す設計にすると、**カーネルのバックエンドでも組み直した時点で同じ差が出る**。「空になったディレクトリは消す」という対処は、今度は `delete-file` と食い違う
- **N-3〜N-5 は Node 実装側で直せる。** カーネル移植とは関係なく、今の MicroGit の利用者にも起きうる（ファイルとディレクトリの置き換え、`.wh.` で始まるファイル名）。別 Issue で扱う
- FR-1 の対象にフォールバックを含めるかどうか（補足 S-4）は、N-3〜N-5 を直した後の残り（N-1・N-2）を見て決めるのがよい

## 5. 記録した環境（meta.json）

| 項目 | 値 |
|---|---|
| カーネル | 6.6.87.2-microsoft-standard-WSL2（WSL2 / Ubuntu 24.04） |
| 明示した mount オプション | `userxattr`（非特権 mount に必須） |
| 書き込み mount の実際のオプション | `rw,relatime,redirect_dir=nofollow,uuid=on,userxattr` |
| view mount の実際のオプション | `ro,relatime,redirect_dir=nofollow,userxattr` |

確定した事実：
- WSL2 のカーネルでは、Ubuntu 24.04 でも非特権ユーザー名前空間での overlay mount が通る。補足 S-3 の「Ubuntu 23.10 以降は AppArmor が非特権ユーザー名前空間を制限する」は、WSL2 のカーネルでは効いていない
- `userxattr` 付きの非特権 mount では、`redirect_dir` を指定しないと `nofollow` になった（root での mount とは比べていない）

推測（未確認）：
- `redirect_dir=nofollow` なので、下の層にあるディレクトリの rename は `EXDEV` になり、`mv` はコピーと削除で代わりにやっているはず。ビューは一致するが、upper にはディレクトリ全体のコピーが入る。大きなディレクトリの rename が遅くなる可能性があり、#12（O-13）と性能要件（NFR-2）に関わる。upper の中身は今回見ていない

期待値は **このカーネルとオプションでの結果** であり、#12 で固定する mount オプションと最低カーネルバージョンが決まったら取り直す（`record-kernel.mjs` の `MOUNT_OPTS`）。

## 6. まだ比べていないもの（次の版）

| 項目 | 関連 |
|---|---|
| ホストへの反映後の一致（`syncMergeToWorkspace` の結果）。大文字小文字だけ違う名前、Windows の予約名、実行ビット、Unicode の正規化差 | 補足 S-4、#16（O-14） |
| シンボリックリンク、実行ビット、ハードリンク、xattr | FR-1 |
| upper の中身（whiteout・opaque・redirect の表現）とコピーアップの挙動 | #12 |
| 複数のカーネルバージョンでの記録。GitHub Actions の ubuntu-latest では AppArmor の制限で非特権 mount が通らない見込みなので、`sudo` で記録するか別の手段が要る（未確認） | 補足 S-3・S-4、#12（O-13） |
| 性能（レイテンシ・スループット） | #14、NFR-2 |
