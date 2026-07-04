#!/bin/zsh
set -u

export PATH="/usr/local/bin:/opt/homebrew/bin:/Users/evander/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LARK_CLI_NO_PROXY=1

SCRIPT="/Users/evander/codex/orbitos-automation/orbitos-intake-base.mjs"
LOG="/Users/evander/codex/orbitos-automation/orbitos-intake-loop.log"

timestamp() {
  date "+%Y-%m-%d %H:%M:%S %Z"
}

{
  printf "[%s] launch: OrbitOS intake loop\n" "$(timestamp)"
  /usr/local/bin/node "$SCRIPT" configure-views
  views_exit=$?
  /usr/local/bin/node "$SCRIPT" sync-vault
  sync_exit=$?
  /usr/local/bin/node "$SCRIPT" promote
  promote_exit=$?
  printf "[%s] launch: OrbitOS intake loop exit views=%s sync=%s promote=%s\n" "$(timestamp)" "$views_exit" "$sync_exit" "$promote_exit"
} >> "$LOG" 2>&1

exit 0
