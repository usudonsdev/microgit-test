# Claude Code instructions

Cursor と併用する。指示の正本は [AGENTS.md](AGENTS.md)。内容が食い違う場合は AGENTS.md と [docs/design-policy.md](docs/design-policy.md) を優先し、本ファイルを合わせて更新する。

## 最重要: 会話成果物をリポジトリに残す

チャット履歴は Cursor 側と共有されない。トークン限界後のやり直しも高い。そのため:

1. **設計判断・トレードオフ・却下した案** → `docs/design-policy.md` または `docs/` へ、理由付きで詳細に追記・更新する
2. **Agent Skills や繰り返し手順** → `AGENTS.md` / 本ファイル / `.cursor/rules/` へ残す
3. **実装の不変条件・罠** → 該当ソース近傍コメント、または `docs/`
4. チャット内の長い説明で終わらせない。**後続エージェントがファイルだけ読んで再開できる**粒度にする
5. 秘密情報は書かない

作業単位の終わりに「ドキュメントを更新したか」を自分で確認してから完了とする。

## プロジェクト要約

- VS Code / Cursor 拡張: 保存ごとのマイクロ履歴（MicroGit）
- 設計方針: [docs/design-policy.md](docs/design-policy.md)
- 利用者向け: [README.md](README.md)
