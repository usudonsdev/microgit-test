# Change Log

All notable changes to the "MicroGit" extension will be documented in this file.

## [3.6.1] - 2026-07-26

### Fixed
- 保存ジョブ発行時にファイル内容をスナップショットし、実行時のディスク変化・ジャンプ後状態の影響を受けないようにした

### Changed
- 同一パス・同一内容の連続保存ジョブを省略し、連続保存時のキュー膨張を抑制

## [3.6.0] - 2026-07-26

### Added
- OverlayGit 型「空間で時間を買う」: `views/<hash>/` に完全展開ビューを永続化
- 保存時に親ビュー + 差分レイヤで O(変更) 展開、再訪問・分岐切替はキャッシュヒット
- workspace 同期で内容同一ファイルをスキップ

### Changed
- checkout がフル再マージではなく展開ビュー利用を既定に

## [3.5.0] - 2026-07-26

### Added
- Node.js ユーザー空間 Overlay エンジン（OverlayFS 意味論: レイヤ上書き + `.wh.*` whiteout）
- コマンド `MicroGit: Overlay Status`
- スモーク `scripts/overlay-smoke.sh`（OS mount / Docker 不要）
- ドキュメント `docs/NodeOverlay.md`

### Changed
- checkout を OS 非依存の Node 経路に一本化（kernel OverlayFS / fuse-overlayfs は使わない）
- 設定 `microgit.overlayBackend` を廃止

## [3.4.1] - 2026-07-26

### Changed
- `mb-*` は各マイクロブランチの**先端のみ**に付与（タグ数 = ブランチ数）。同一ブランチ上の前進は tip を移動
- 同一内容の再保存は新規コミットせず HEAD のみ復帰
- 通常 git への Agent 自動コミット hook を廃止（記録はマイクロ履歴のみ）

### Fixed
- 非ホバー表示: 先端は `mb-N (…)`, 途中ノードは短縮ハッシュ

## [3.4.0] - 2026-07-26

### Added
- Cursor Agent / Tab 編集を検知し、マイクロ履歴に `[AI]` 付きで記録
- サイドバー・グラフの非ホバー表示: `[AI] (更新内容)` / `mb-N (更新内容)`
- Agent 編集検知用の afterFileEdit hook（`.cursor/hooks`）

## [3.3.0] - 2026-07-25

### Added
- Stage 1a Overlay checkout（ユーザー空間マージ）: `.microgit_overlay` にレイヤを書き出し、分岐パスだけを materialize して兄弟ブランチのファイル干渉を防ぐ
- 設定 `microgit.useOverlayCheckout`（デフォルト on）。オフで従来の git show 同期に戻せる
- 過去状態検知を拡張: 全体 tree 一致に加え、保存ファイルの blob 一致でも HEAD を巻き戻す（Ctrl+Z / 手編集戻し）

### Changed
- タイムライングラフ: レーン間隔を広げ、ラベルを右外側の共通列に配置して文字被りを解消
- サイドバー / グラフの表示をコンパクト化し、ホバーで詳細を表示

## [3.2.0] - 2026-07-04

### Added
- Activity Bar の専用コントロールパネル（オンオフ、ジャンプ、履歴一覧）
- サイドバー / グラフのリアルタイム更新
- 対象ブランチ以外への切替時にシャドウを退避し、復帰時に復元する仕組み
- オン / オフ切り替えと対象ブランチ管理

### Changed
- 現段階のスコープを個人開発と、メインリポジトリのコミット経由でのマイクロ履歴共有に限定
- チーム間の直接同期（Pull / Push）は将来予定とし、現行機能から削除
- Cursor 互換のため `engines.vscode` を緩和し、起動時にステータスバーを表示

### Fixed
- シャドウリポジトリ未初期化時に記録できない問題
- タイムトラベル後の detached HEAD による記録不安定を解消
- 記録成功 / 失敗のフィードバックを追加

## [3.1.0]

- オンオフ切替とブランチ単位のシャドウ管理を追加

## [3.0.0]

- 初期の公開ライン向け機能一式
