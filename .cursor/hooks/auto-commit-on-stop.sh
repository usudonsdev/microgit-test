#!/usr/bin/env bash
# Agent ターン終了時に、作業ツリーの変更を自動コミットする。
# stdout は Cursor 向け JSON のみ。ログは stderr へ。

set -euo pipefail

input="$(cat)"

# completed 以外（中断など）ではコミットしない
status="$(
  printf '%s' "$input" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    data = {}
print(data.get("status") or data.get("stop_status") or "completed")
' 2>/dev/null || echo "completed"
)"

if [[ "$status" != "completed" ]]; then
  echo '{}' 
  exit 0
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo '{}' 
  exit 0
fi

# 何も変わっていなければ終了
if git diff --quiet && git diff --cached --quiet; then
  untracked="$(git ls-files --others --exclude-standard || true)"
  if [[ -z "$untracked" ]]; then
    echo '{}' 
    exit 0
  fi
fi

# ステージ（秘匿・巨大成果物は除外）
git add -A 2>/dev/null || true
git reset -q HEAD -- \
  'photo/' \
  '*.vsix' \
  '.env' \
  '.env.*' \
  '**/.env' \
  '.microgit_shadow/' \
  '.microgit_logs/' \
  '.microgit_overlay/' \
  2>/dev/null || true

if git diff --cached --quiet; then
  echo '{}' 
  exit 0
fi

msg="$(cat <<EOF
chore: apply agent session changes

Auto-committed by Cursor stop hook after agent completion.
EOF
)"

if git commit -m "$msg" >/dev/null 2>&1; then
  echo "[auto-commit-on-stop] committed: $(git rev-parse --short HEAD)" >&2
else
  echo "[auto-commit-on-stop] commit skipped or failed" >&2
fi

echo '{}'
exit 0
