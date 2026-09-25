# Phase 1：最小ゲストと macOS バックエンド

| 項目 | 内容 |
|---|---|
| Issue | #15（最小ゲスト）、#17（macOS バックエンド）、#13（agent の言語）。Epic #8 |
| 版 | 初版（2026-09-26）：ゲストのビルドと QEMU での確認まで済み。Mac での起動は未確認 |
| 関連 | [要件定義書](./microgit-kernel-feature-portability-requirements.md) AD-5・AD-7・NFR-3・NFR-4、[ゴールデンテスト](./overlayfs-golden-test.md) |

## 1. 全体の形

```
Mac（ホスト）                                   ゲスト（最小 VM）
node scripts/golden/check-guest.mjs             Linux 6.18.53（virtio のみ・ネットワークなし）
   │ stdin/stdout（1 行 1 JSON）                    │
mac/.build/microgit-vm（Swift）  ── virtio-console ──  /init = Go の agent（PID 1）
   Virtualization.framework        ポート "microgit"      OverlayFS の層を /run/microgit（tmpfs）に積む
```

| 置き場所 | 中身 |
|---|---|
| `guest/agent/` | init 兼 agent（Go、標準ライブラリだけ） |
| `guest/kernel/` | 固定したカーネルのバージョン（`version.env`）と設定（`microgit.config`） |
| `guest/build.sh` | カーネルと agent をビルドし、agent を initramfs として埋め込んだ `Image` 1 ファイルを作る |
| `.github/workflows/guest.yml` | arm64 でビルド → QEMU で起動 → ゴールデンテスト → `Image` を成果物として残す |
| `mac/` | Virtualization.framework で `Image` を起動する `microgit-vm` と、Mac で試す `run-golden.sh` |
| `scripts/golden/check-guest.mjs` | stdin/stdout で agent とつながるコマンドを起動し、12 シナリオを照合して計測する |

## 2. 決めたこと

### 2.1 agent の言語：Go（#13、O-4）

| 観点 | Go | 採らなかった案 |
|---|---|---|
| サイズ | 静的バイナリで 2.3 MB（arm64、`-s -w`） | シェル（busybox）も約 1 MB だが、`mount` などのコマンド群と vsock 用の追加ソフトが要る |
| 設計との整合 | ゲストのユーザーランドが agent 1 ファイルで済む（AD-7） | シェルは AD-7「シェルを入れない」に反し、侵入されたときに使える道具が増える |
| システムコール | `syscall` パッケージだけで mount・uname・reboot が書ける。外部依存なし | Rust はより小さくできるが、学習コストが高い |
| クロスビルド | `GOOS=linux GOARCH=arm64` だけで済む | — |

決定：利用者（2026-09-26）。

### 2.2 init と agent を 1 つにした

AD-7 は「最小 init と agent」としていた。PID 1 の仕事は mount 4 つだけなので、agent に含めて 1 ファイルにした。PID 1 が終わるとカーネルがパニックするため、agent は戻らない作りにしてある（致命的なエラーは電源断にする）。

### 2.3 命令の通り道：virtio-console の名前付きポート（O-3 の仮決め）

補足 S-10 は vsock を第一候補としていたが、初版では virtio-console の名前付きポート `microgit` にした。

- QEMU と Virtualization.framework の両方で同じように作れる。ゲストの agent は `/sys/class/virtio-ports/*/name` で名前から探すので、番号の違い（QEMU は `vport0p1`、Mac は `vport1p0` の見込み）を気にしなくてよい
- 命令は要求 1 つに応答 1 つで、順番どおり返す。多重化が要らないので、S-10 が挙げた「多重化を自前で作る」という virtio-console の欠点が今は効かない
- vsock を使わないので `CONFIG_NET` 自体を無効にできる（S-10 の「IP スタックだけ外す」より一段削れる）

並行して複数の命令を流したくなったら、vsock に切り替えるか、要求 ID で多重化する。O-3 の正式な決定は #17 で行う。

### 2.4 層の置き場所：ゲストの tmpfs（O-2 の仮決め）

upper も lower も `/run/microgit`（tmpfs）に置いている。電源を切ると消えるので、今はゴールデンテストと計測のためだけの置き場所である。ワークスペースとの共有方式と合わせて、O-2 は #17 で決める。

`userxattr` で tmpfs を upper にするには tmpfs の `user.*` xattr（6.6 以降）が要るので、`CONFIG_TMPFS_XATTR` を有効にしている。

### 2.5 命令の形（#12 で正式に決めるまでの仮）

1 行 1 JSON。`id` を付けて送ると、同じ `id` で答える。ゲストが準備できると `{"event":"ready",...}` を送ってくる。

| op | 引数 | 答え |
|---|---|---|
| `hello` | — | `kernel`、`agent` |
| `reset` | — | 層をすべて捨てる |
| `commit` | `parent`（-1 で最初）、`ops`（シナリオと同じ形） | `commit`（番号）、`mountOptions`、`exdevRenames` |
| `view` | `commit` | `entries`（ゴールデンテストと同じ 1 行 1 エントリ） |
| `poweroff` | — | 答えてから電源を切る |

どの答えにも、ゲストの中での所要時間 `elapsedUs` が付く。

### 2.6 VM なしのモード

agent を PID 1 以外で起動すると、同じ命令を stdin/stdout で受ける。層は一時ディレクトリに置く。Linux では `unshare -Urm guest/out/<arch>/init` で非特権のまま OverlayFS を使えるので、これが AD-2（Linux ではネイティブ）の経路の原型になる（#14）。

### 2.7 カーネル

| 項目 | 値 | 理由 |
|---|---|---|
| バージョン | 6.18.53（長期サポート版） | 2026-09-26 時点の最新の長期サポート版は 6.18.54 だが、kernel.org の sha256sums にまだ載っていなかったので 1 つ前にした |
| 取得の確認 | `version.env` の sha256 で照合 | sha256sums.asc の PGP 署名はまだ検証していない |
| 設定 | `allnoconfig` に `microgit.config` を重ねる | 頼んだ `=y` が依存関係で落ちたらビルドを止める。`CONFIG_NET=y` になっても止める |
| 起動の形 | initramfs を埋め込んだ `Image` 1 ファイル | VZLinuxBootLoader にカーネルだけ渡せば済む。arm64 は圧縮していない `Image` が要る |

**罠：** `allnoconfig` では FUTEX・EPOLL・EVENTFD が切られていて、Go のランタイムが動かない。`microgit.config` で明示的に有効にしている。

## 3. 結果（2026-09-26）

| 環境 | カーネル | 12 シナリオ | ready まで | commit p50 / p95 | view p50 / p95 |
|---|---|---|---|---|---|
| WSL2、VM なし（`unshare -Urm`、x86_64） | 6.6.87.2-microsoft-standard-WSL2 | 全一致 | 4.2 s ※1 | 7.3 / 9.9 ms | 0.3 / 0.5 ms |
| GitHub Actions、QEMU（TCG、arm64） | 6.18.53 | 全一致 | 0.7 s ※2 | 2.7 / 8.3 ms | 1.7 / 2.8 ms |
| Mac（Virtualization.framework） | 6.18.53 | 未確認 | — | — | — |

※1 wsl.exe の起動時間を含む。※2 CPU を丸ごとエミュレーションした状態での値。

| サイズ（arm64） | バイト |
|---|---|
| Image（カーネル＋initramfs） | 6,950,920 |
| うち agent | 2,293,908 |

確定した事実：
- 期待値を記録した 6.6（WSL2）とゲストの 6.18.53 で、12 シナリオのビューに差はなかった
- 下の層にあるディレクトリの rename は `EXDEV` になる（どちらの環境でも `exdevRenames=1`、`rename-dir` シナリオ）。agent は coreutils の `mv` と同じく、コピーして元を消すことで代わりにやっている
- mount オプションは両環境とも `rw,relatime,redirect_dir=nofollow,uuid=on,userxattr`
- GitHub Actions の Ubuntu 24.04 では非特権ユーザー名前空間が使えない（`kernel.apparmor_restrict_unprivileged_userns = 1`、`unshare -Urm` が `uid_map` の書き込みで失敗）。補足 S-3 の指摘どおり。WSL2 のカーネルでは使える
- commit（mount → 書き込み → unmount）は 1 回あたり数 ms。補足 S-5 の見積もりどおりで、保存のたびに行うと FR-4・NFR-2 と衝突しうる。#12 の判断材料

## 4. Mac で試す

```bash
xcode-select --install          # swiftc と codesign（入っていれば不要）
gh auth login                   # 成果物の Image を取ってくるため（初回だけ）
git switch feature/kernel-portability && git pull
mac/run-golden.sh
```

`run-golden.sh` は、起動ツールをビルドして ad-hoc 署名し、GitHub Actions の最新の成功した実行から `Image` を取ってきて、12 シナリオを流す。結果は `guest/out/arm64/guest-result-mac.json`、カーネルのログは `guest/out/arm64/console-mac.log` に残る。

Mac で確かめること：
- [ ] ad-hoc 署名で Virtualization.framework が使えるか（O-8）
- [ ] allnoconfig ベースのカーネルが Virtualization.framework で起動するか（PCI・GIC・PSCI の構成が QEMU の virt と違う可能性がある）
- [ ] 名前付きポートがゲストで見つかるか
- [ ] 12 シナリオの一致と、起動時間・commit・view の計測値

## 5. まだやっていないこと

| 項目 | Issue |
|---|---|
| Boundary Guard（ゲストから返った差分をホストで検証してから反映する） | #16 |
| ワークスペースとの共有方式と upperdir の置き場所（O-2） | #17 |
| 制御チャネルの正式な決定（O-3）と命令の形の確定 | #17、#12 |
| x86_64 のゲスト（Intel Mac、Windows 用） | #15 |
| ビルドの再現性の確認（同じ入力から同じ `Image` が出るか） | #15 |
| MicroGit 本体（拡張機能）からの利用 | #14 の Backend Selector の後 |
