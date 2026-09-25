# Phase 2：Windows バックエンド（QEMU 同梱）

| 項目 | 内容 |
|---|---|
| Issue | #18（O-1、O-9）。Epic #8 |
| 版 | 初版（2026-09-26）：配布版の QEMU で起動と計測まで。同梱用の小さい QEMU はまだ |
| 関連 | [要件定義書](./microgit-kernel-feature-portability-requirements.md) NFR-1・NFR-3、[補足](./microgit-kernel-feature-portability-supplement.md) S-1・S-2、[Phase 1](./guest-phase1.md) |

## 1. 決めたこと：QEMU を同梱する（O-1）

決定：利用者（2026-09-26）。Phase 1 と同じ最小ゲスト（x86_64 版）を、同梱した QEMU で起動する。

| 案 | 採否 | 理由 |
|---|---|---|
| **A. QEMU を同梱** | **採用** | VM を自作しなくてよい（C-4）。WHPX が無効でも TCG で動く。Mac と同じゲストを使えるので挙動を揃えやすい（FR-1） |
| B. WSL2 を借りる（`wsl --import`） | 不採用 | WSL2 が入っている PC でしか使えない（NFR-1）。カーネルは Microsoft 製でバージョンを固定できない。ただし実装は簡単なので、将来の高速化オプションとしては残せる |
| C. WHP で VM を自作 | 不採用 | virtio のエミュレーションを含む VMM を自前で書くことになり、個人開発には大きすぎる（補足 S-2） |
| D. LKL（O-9） | 保留 | Windows 対応の保守状況が分からない。A で NFR-1 を満たせる見込みが立ったので、急がない |

### 1.1 補足 S-2 への答え

S-2 は「Windows の VM バックエンドは、仮想化機能（仮想マシン プラットフォーム／ハイパーバイザー プラットフォーム）が有効な PC でしか使えず、NFR-1 と両立しない」と指摘した。QEMU は同じゲストを **TCG（CPU のエミュレーション）でも動かせる**。TCG は仮想化機能も管理者権限も要らない。計測では TCG でもコミット 1 回が中央値 2 ms 前後で（§3）、現行の Node.js 実装の代わりとして使える速さに見える。

- 仮想化機能が有効な PC：WHPX で速く動く
- 無効な PC：TCG で動く（遅いが、機能は同じ）
- どちらも同じカーネル・同じ agent なので、挙動は同じ

## 2. 仕組み

```
Windows（ホスト）
  node scripts/golden/check-guest.mjs
     │ stdin/stdout（1 行 1 JSON）
  qemu-system-x86_64.exe -M q35 -accel whpx,kernel-irqchip=off -accel tcg ...
     │ virtio-serial：hvc0（ログ）と名前付きポート "microgit"
  最小ゲスト（guest/out/x86_64/Image = bzImage、agent 込み 3.3 MB）
```

- `-accel` を複数並べると、QEMU は前から順に試す。WHPX が使える PC では WHPX が選ばれた（コミット 0.1 ms で判別）。**WHPX が使えない PC で TCG に切り替わるかは、この PC では確かめられていない**（仮想化機能を無効にしないと試せない）
- `kernel-irqchip=off` は QEMU の WHPX でよく必要になる設定として付けている。外した場合は試していない
- 試すときは `windows/run-golden.ps1`（`-Accel auto|whpx|tcg`）

**罠：** Windows PowerShell 5.1 は BOM の無い UTF-8 のスクリプトを Shift_JIS として読み、日本語のコメントで構文が壊れる。`.ps1` は BOM 付き UTF-8 で保存する。

### 2.1 x86_64 のカーネル設定

`guest/kernel/microgit-x86_64.config`。共通の設定に次を足す。

- `CONFIG_ACPI=y`：電源断に要る。無いと poweroff が停止になり、QEMU が終わらない
- `ARCH=x86_64` で make する。`ARCH=x86` の allnoconfig だと 32 ビットのカーネルになる

## 3. 結果（2026-09-26、x86_64、Linux 6.18.53、12 シナリオはすべて一致）

| 環境 | ready まで | commit p50 / p95 | view p50 / p95 |
|---|---|---|---|
| Windows 11 Home、QEMU 11.1、**WHPX** | 0.63〜0.71 s | 0.10〜0.12 / 0.25 ms | 0.06〜0.07 / 0.10 ms |
| Windows 11 Home、QEMU 11.1、**TCG** | 1.1〜1.2 s | 1.6〜1.9 / 6.3〜6.5 ms | 1.0〜1.2 / 1.8〜1.9 ms |
| GitHub Actions、QEMU（TCG） | 1.3 s | 2.3 ms | 1.4 ms |
| 参考：WSL2 で VM なし（`unshare -Urm`、層は ext4） | 4.2 s ※ | 7.3 / 9.9 ms | 0.3 / 0.5 ms |

※ wsl.exe の起動時間を含む。

- WHPX ではコミットが 0.1 ms 程度。補足 S-5 の「保存 1 回あたり数 ms」は、ゲストの層を tmpfs に置く限り当てはまらなかった。WSL2 との差は主に層の置き場所（tmpfs と ext4）によるものと見ているが、切り分けはしていない
- ゲストの中の処理時間（`elapsedUs`）であり、ホストとの往復や、ワークスペースとのファイルのやりとり（O-2）は含まない

## 4. 課題：QEMU の大きさ（NFR-3）

配布版（qemu.weilnetz.de の 2026-08-11 版）は展開すると 1.2 GB。`qemu-system-x86_64.exe` 本体が 25 MB で、GUI・音声・USB・ネットワークなどのために 104 個の DLL に依存している。

必要なのは次だけなので、自前でビルドすれば大きく削れる見込み（未確認）。

- 対象：`x86_64-softmmu` だけ
- アクセラレータ：WHPX と TCG
- デバイス：q35（または microvm）、virtio-serial、ファームウェア（SeaBIOS）
- 外す：GUI（SDL・GTK）、音声、USB、ネットワーク（slirp）、VNC・SPICE、ブロックデバイスの各種形式

見積もりは本体 10〜15 MB＋glib などの DLL 数 MB。一桁 MB（NFR-3）には届かない可能性が高く、NFR-3 の目標を「ゲスト」と「VMM」に分けて考え直す必要がある。`-M microvm`（PCI も ACPI も無い最小の x86 マシン）にすると、さらにデバイスを削れる。

## 5. 次にやること

| 項目 | 内容 |
|---|---|
| 小さい QEMU のビルド | GitHub Actions の Windows ランナーと MSYS2 で、必要な部品だけの QEMU をビルドし、大きさを測る |
| TCG への切り替えの確認 | 仮想化機能が無効な Windows（または WHPX を使えない VM の中）で `-accel auto` を試す |
| microvm の検討 | virtio-mmio に切り替えて、QEMU とカーネルの両方を削れるか |
| Windows on Arm | arm64 版の QEMU と arm64 のゲストで動くか |
| WSL2 を借りる方式（B） | WSL2 がある PC 向けの高速化オプションとして残すかどうか |
