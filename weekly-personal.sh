#!/bin/zsh
# weekly-personal: 周日 23:00 —— 个人周报 + Wiki 草稿（2026-10-31）
# 顺序：先周报（可能有对外账等上下文），再让 LLM 从本周产物抽 1-2 条 Wiki 草稿
set -u
SCRIPT_DIR="${0:A:h}"
NODE=/opt/homebrew/opt/node@22/bin/node
LOG="$SCRIPT_DIR/weekly-personal.log"
source "$SCRIPT_DIR/lib/net-check.sh"

log() { printf "[%s] %s\n" "$(TZ=Asia/Shanghai date '+%F %T')" "$*" >> "$LOG"; }

if ! net_ok 8; then
  log "no network → skip weekly-personal"
  net_mark_pending "weekly-personal"
  exit 0
fi

"$NODE" "$SCRIPT_DIR/orbitos-daily-brief.mjs" --weekly-personal >> "$LOG" 2>&1 || log "warn: weekly-personal failed"
"$NODE" "$SCRIPT_DIR/wiki-draft.mjs" >> "$LOG" 2>&1 || log "warn: wiki-draft failed"
log "=== weekly-personal done ==="
