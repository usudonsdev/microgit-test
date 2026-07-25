# Node.js Overlay Engine（空間で時間を買う）

OS mount は使わない。Node.js だけで OverlayFS 意味論を実装し、  
**展開済みビューをストレージに保持して切替時間を短縮する**（OverlayGit の利点）。

## 方針

| 項目 | 内容 |
|------|------|
| 差分レイヤ | `layers/<hash>/` に変更ファイルのフル実体（+ `.wh.*` whiteout） |
| 展開ビュー | `views/<hash>/` にそのコミット時点の完全ツリーを永続化 |
| 伸ばし方 | 親ビュー + 新レイヤ（O(変更)）。再訪問はビューをそのまま利用 |
| 合成 | ビュー → `merge/` → `write/<mb-*>/` を最上層 |
| 同期 | 内容同一ファイルはワークスペースへコピーしない |
| OS | Windows / macOS / Linux 同一経路 |

```
保存時:  layer 書き出し → 親ビューから差分展開して views/<hash>/ を保持
切替時:  views/<tip>/ を載せる（構築済みなら再計算しない）→ write → workspace
```

## 設定

| キー | 既定 | 意味 |
|------|------|------|
| `microgit.useOverlayCheckout` | `true` | Overlay checkout を有効化 |

## コマンド

- `MicroGit: Overlay Status` — `backend=nodejs space-for-time=views`

## 検証

```bash
./scripts/overlay-smoke.sh
```
