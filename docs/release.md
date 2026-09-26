# MicroGit 5 の公開の手順と、同梱する部品の扱い

| 項目 | 内容 |
|---|---|
| 関係する Issue | #19（MicroGit の内部機能として Marketplace に公開する） |
| 版 | 初版（2026-09-26）。公開はまだしていない |
| 仕組み | [.github/workflows/package.yml](../.github/workflows/package.yml)、[scripts/package-vsix.mjs](../scripts/package-vsix.mjs)、[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) |
| 学習用 | [learning/10-packaging-and-licenses.md](./learning/10-packaging-and-licenses.md) |

---

## 1. 配るもの

プラットフォーム別の VSIX（`vsce package --target`）を 4 つ作る。Marketplace は、VS Code を動かしている環境に合う VSIX を配り、合うものが無い環境には `--target` を付けずに作った VSIX（universal）を配る（vsce の文書「Platform-specific extensions」）。

| VSIX | 入っている部品 | 大きさ（5.0.0、2026-09-27） | 配られる環境 |
|---|---|---|---|
| win32-x64 | 同梱の QEMU（#18）、x86_64 の最小ゲスト（カーネル＋agent） | 9,444,838 バイト | Windows x64 |
| linux-x64 | x86_64 の agent | 1,429,451 バイト | Linux x64 |
| linux-arm64 | arm64 の agent | 1,303,172 バイト | Linux arm64 |
| universal | 無し（Node.js 版だけ） | 82,763 バイト | macOS、Windows on Arm、Linux armhf、Alpine など |

- **macOS**：Mac の実機で確かめるまで（#17）、カーネル版の部品を入れない。`--targets darwin-arm64` を明示すれば作れる
- **Alpine（musl）**：agent は静的リンクなので動く見込みだが、確かめていない。今は universal が配られる
- 中身の確認：`package-vsix.mjs` は、できた VSIX の中身を「入ってよいものの一覧」と照らし、同梱の部品を除いた中身が 1 MB を超えたら止める。最初は「入っていてはいけないもの」の一覧で確かめていて、CI で成果物を落としたフォルダ（`artifacts/`、GCC のソース RPM など）が VSIX に入り、142〜150 MB になったのを見逃した
- 実行ビット：VSIX は Linux で作る（Windows で作ると実行ビットが落ちる）。拡張機能も、起動の前に実行ビットを確かめて無ければ付ける（`src/kernel/executable.ts`）

## 2. どう確かめているか

`package.yml` は、ゲスト（guest.yml）と QEMU（qemu-windows.yml）を同じ実行の中でビルド・テストし、VSIX を作ってから、次の 5 つの環境で **VS Code の CLI（`--install-extension`）で入れた拡張機能** に対して拡張機能テストを流す。

| 環境 | VSIX | 期待するバックエンド | 確かめること |
|---|---|---|---|
| windows-latest | win32-x64 | kernel | 同梱の QEMU とゲストで動く |
| ubuntu-22.04 | linux-x64 | kernel | 同梱の agent が実行ビット付きで入り、`unshare -Urm` で動く |
| ubuntu-24.04 | linux-x64 | nodejs | 非特権のユーザー名前空間が止められた環境で、公開版でも Node.js 版になる（NFR-5、補足 S-3） |
| ubuntu-24.04-arm | linux-arm64 | kernel | arm64 の agent（止めている設定を外して試す） |
| macos-14 | universal | nodejs | カーネル版の部品が無い VSIX |

手元（Windows 11）でも、`MICROGIT_TEST_VSIX=<VSIX> MICROGIT_TEST_EXPECT_BACKEND=kernel node out/test/runTest.js` で同じことができる。

## 3. 公開の手順

**公開（Marketplace への `vsce publish`）と、`feature/kernel-portability` から `master` へのマージは、元に戻せない（Marketplace の版は取り消しても同じ版番号を使い直せない）。利用者が §4 を決めてから行う。**

1. `feature/kernel-portability` を `master` にマージする（PR を作り、CI がすべて通ることを確かめる）
2. `master` で `v5.0.0` のタグを打って push する → `package.yml` が走り、VSIX の作成と 5 つの環境での確認のあと、GitHub Release の **下書き** を作る（VSIX、`vsix.json`、`third-party-sources-v5.0.0.tar`）
3. 下書きの VSIX を手元の VS Code に入れて、`MicroGit: Overlay Status` で `active=kernel` を確かめる（Windows・Linux）
4. Marketplace に公開する。プラットフォームごとに VSIX を渡す：
   ```
   npx vsce publish --packagePath microgit-5.0.0-win32-x64.vsix microgit-5.0.0-linux-x64.vsix microgit-5.0.0-linux-arm64.vsix microgit-5.0.0-universal.vsix
   ```
   （発行者 `usudonsdev` の Personal Access Token が要る。CI からの自動公開は、トークンを Secrets に置く判断が要るので、今は手で行う）
5. GitHub Release の下書きを公開する（GPL・LGPL の部品のソースを誰でも取れるようにする。§5）
6. `CHANGELOG.md` の `[5.0.0]` に公開日を入れる

## 4. 公開の前に利用者が決めること

| # | 事項 | 今の状態 | 選択肢 |
|---|---|---|---|
| 1 | package.json の `repository` | `https://github.com/usudonsdev/microgit` を指しているが、このリポジトリは存在しない（2026-09-26 に確認）。Marketplace のページのリンクが切れる | `usudonsdev/microgit-test` にする／リポジトリの名前を `microgit` に変える／新しく作る |
| 2 | `LICENCE.md` の著作権者 | `Copyright (c) 2026 YourName`（雛形のまま） | 利用者の名前かハンドル |
| 3 | O-5：OverlayFS 部品（agent など自作のコード）のライセンス | MicroGit 本体と同じ MIT で配っている | MIT のまま／Apache-2.0（特許の許諾が明示される）。Phase 4 で別のリポジトリにするときに決めてもよい |
| 4 | GPL のソースの渡し方 | リリースごとに GitHub Release にソースを置く（§5） | このまま／「書面による申し出」（3 年間、求めがあればソースを渡す）も THIRD_PARTY_NOTICES.md に書く（連絡先が要る） |
| 5 | Windows のコード署名 | 同梱の QEMU（と DLL）は署名していない | 署名しない（Smart App Control が有効な PC では Node.js 版になる。§6）／署名する（費用がかかる） |
| 6 | OverlayFS 部品を別のリポジトリにするか（NFR-7、Phase 4） | しない（MicroGit の中） | Phase 4 で決める |

## 5. ライセンスとソース（NFR-7）

- 同梱する部品とライセンスは [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。ライセンスの文書は VSIX の `resources/kernel/licenses/` と `resources/kernel/win32-x64/qemu/licenses/` に入る
- DLL（GLib など）は Fedora 44 の MinGW のパッケージのもの。どの DLL がどのパッケージから来たか、その版・ライセンス・ソース RPM は、ビルドのときに `rpm` に聞いて `packages.tsv` に書く（`windows/qemu/build.sh`）。ソース RPM も同じコンテナで取る（あとで取り直すと版がずれる）
- ソース一式（カーネルと QEMU の tarball、DLL のソース RPM、ビルドの設定と手順、`SHA256SUMS`）は `package.yml` の成果物 `third-party-sources` と、タグのときは GitHub Release の `third-party-sources-<tag>.tar`
- GPLv2 の第 3 節は、実行形式を配るときに、ソースを一緒に渡すか、書面で申し出るかを求める。ダウンロードの場所で配るなら「同じ場所から」ソースを取れるようにすることでもよい。Marketplace（VSIX の置き場所）と GitHub Release（ソースの置き場所）は別の場所なので、厳密さを求めるなら §4 の 4 で書面による申し出を足す

## 6. Windows のセキュリティ機能と、同梱の QEMU

- **SmartScreen**：インターネットから取ってきた印（Mark of the Web）の付いたファイルを、エクスプローラーなどから開くときに確かめる。MicroGit は VS Code が自分で展開した VSIX の中の QEMU を子プロセスとして起動するので、ふつうは出ない（手元の Windows 11 で、VSIX を VS Code の CLI で入れて起動し、警告は出なかった）
- **Smart App Control**（Windows 11）：有効にしていると、クラウドでの評判が無く、有効な署名も無い実行ファイルと DLL を、子プロセスとして起動しても止める。自前でビルドした QEMU は評判が無いので、止められる見込みが高い。MicroGit は QEMU を起動したあと agent の「準備完了」の応答を待つので、止められれば起動の失敗として扱い、Node.js 版に切り替わる（機能は失われない）。避けるには Authenticode のコード署名が要る（§4 の 5）。Smart App Control が有効な PC での確認はしていない
- **ウイルス対策ソフト**：QEMU そのものは広く使われているが、見慣れない場所から仮想マシンを起動する動きを止める製品がありうる。その場合も Node.js 版に切り替わる
- **仮想化機能の有無**：WHPX（Windows ハイパーバイザー プラットフォーム）が無効なら TCG（CPU のエミュレーション）で動く。管理者権限は要らない

## 7. セキュリティの境界（TCG）

QEMU のセキュリティの方針では、TCG（CPU のエミュレーション）で動かす使い方は「仮想化の使い方ではない」とされ、TCG の不具合はセキュリティの不具合として扱われない（ゲストの隔離を当てにしてはいけない）。仮想化の使い方として挙がっているのは KVM や HVF のようなハードウェアの仮想化で、マシンの種類では x86_64 の `q35` がその対象に入っている。

MicroGit では：

- ゲストに入るのは MicroGit が作ったカーネルと agent だけで、外から届くのは **利用者のワークスペースのファイルの名前と中身** だけ。ゲストの OverlayFS はファイルの中身を解釈しない（バイト列として置くだけ）
- ゲストから返ってくるものは、ホストの Boundary Guard が検証してから反映する（ADR-0009）。ゲストが乗っ取られても、ワークスペースに書かれるのは検証を通ったものだけ
- ただし、WHPX が無効で TCG で動いている PC では、「ゲストのカーネルが乗っ取られても QEMU の外には出られない」とは言えない。要件定義書 §7.3 が「ゲストカーネルの更新頻度」を緩められる理由に挙げた「侵害されても VM 内に閉じる」は、TCG では弱まる（要件定義書 §7.5）。心配な利用者は `microgit.kernel.accel` を `whpx` にする（WHPX が使えなければ Node.js 版になる）か、`microgit.overlayBackend` を `nodejs` にする

## 8. 同梱する部品の更新方針（O-6）

| 部品 | 追う系列 | 定期の更新 | 臨時の更新 | 更新の確かめ方 |
|---|---|---|---|---|
| Linux カーネル | kernel.org の長期サポート版（今は 6.18.y） | MicroGit のマイナー版を出すたびに、その系列の最新に上げる | 有効にしている機能（OverlayFS、tmpfs、virtio-console・virtio-pci、agent が使うシステムコール）に関わる脆弱性が出たとき。`CONFIG_NET` を無効にしているので、ネットワークの脆弱性は関係ない | `guest/kernel/version.env` を kernel.org の `sha256sums.asc` の値で更新 → guest.yml（ゴールデンテスト、差分テスト、再現可能なビルド）→ package.yml |
| QEMU | 安定版の最新のパッチ版 | 同上 | `q35`、virtio-serial、WHPX に関わるセキュリティの勧告が出たとき（TCG はセキュリティの対象外、§7） | `windows/qemu/version.env` → qemu-windows.yml → package.yml |
| DLL（GLib など） | Fedora の MinGW のパッケージ | QEMU を作り直すたびに、そのときの最新が入る | GLib などに脆弱性が出たとき、QEMU を作り直す | `packages.tsv` の版を前の版と比べる |
| Go（agent） | Go のサポート中の版（新しい 2 つ） | 同上 | agent が使う標準ライブラリ（os、syscall、encoding/json、bufio など）に関わるセキュリティのリリースが出たとき | `guest/kernel/version.env` の `GO_VERSION` → guest.yml |

- 系列を変えるとき（6.18 から次の長期サポート版へ、など）は、ゴールデンテストをそのカーネルで取り直して、期待値が変わらないことを確かめる（変われば ADR を書く）
- 新しい版が出たかを自動で知らせる仕組み（kernel.org の `releases.json` などを定期的に見て Issue を立てるワークフロー）はまだ無い
