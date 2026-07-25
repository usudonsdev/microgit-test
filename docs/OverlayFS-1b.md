# OverlayFS Stage 1b について（方針変更）

当初の Stage 1b（`mount -t overlay` / `fuse-overlayfs`）は **採用しない**。

理由: OS / 権限ごとに挙動が分かれ、拡張機能として単独・ポータブルに動作させにくい。

現行実装は計画書のアプローチ 1 に従い、**Node.js ユーザー空間 Overlay** に一本化している。

→ 詳細: [NodeOverlay.md](./NodeOverlay.md)
