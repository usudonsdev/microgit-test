# Change Log

All notable changes to the "MicroGit" extension will be documented in this file.

## [3.4.0] - 2026-07-26

### Added
- Cursor Agent / Tab 編集を検知し、マイクロ履歴に `[AI]` 付きで記録
- サイドバー・グラフの非ホバー表示: `[AI] (更新内容)` / `mb-N (更新内容)`
- Agent 終了時に作業ツリーを自動 git commit する stop hook（`.cursor/hooks`）

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
