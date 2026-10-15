#!/bin/zsh
set -u

export PATH="/usr/local/bin:/opt/homebrew/bin:/Users/evander/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LARK_CLI_NO_PROXY=1

SCRIPT="/Users/evander/codex/orbitos-automation/orbitos-intake-base.mjs"
LOG="/Users/evander/codex/orbitos-automation/orbitos-intake-loop.log"
SCRIPT_DIR="${SCRIPT:h}"

cd "$SCRIPT_DIR" || exit 1

timestamp() {
  date "+%Y-%m-%d %H:%M:%S %Z"
}

{
  printf "[%s] launch: OrbitOS intake loop\n" "$(timestamp)"
  /usr/local/bin/node "$SCRIPT" configure-views
  views_exit=$?
  /usr/local/bin/node "$SCRIPT" sync-vault
  sync_exit=$?
  /usr/local/bin/node "$SCRIPT" promote --no-git
  promote_exit=$?
  # 2026-10-12 接线：把 Base 状态机的“源文件已移除/历史版本 → archived”真正跑起来
  /usr/local/bin/node "$SCRIPT" reconcile-records
  reconcile_exit=$?
  # 2026-10-15 接线：内容生命周期“减少”——归档器随本轮自动跑（10 分钟节拍）
  /usr/local/bin/node "$SCRIPT_DIR/orbitos-archive-sweeper.mjs" sweep
  sweep_exit=$?
  printf "[%s] launch: OrbitOS intake loop exit views=%s sync=%s promote=%s reconcile=%s sweep=%s\n" "$(timestamp)" "$views_exit" "$sync_exit" "$promote_exit" "$reconcile_exit" "$sweep_exit"
} >> "$LOG" 2>&1

if (( views_exit != 0 || sync_exit != 0 || promote_exit != 0 || reconcile_exit != 0 || sweep_exit != 0 )); then
  exit 1
fi

exit 0
