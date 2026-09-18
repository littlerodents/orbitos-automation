#!/bin/zsh
set -u

NODE="/usr/local/bin/node"
SCRIPT="/Users/evander/codex/orbitos-automation/youmind-sync.mjs"
LOG="/Users/evander/codex/orbitos-automation/orbitos-youmind-sync.log"
SCRIPT_DIR="${SCRIPT:h}"

cd "$SCRIPT_DIR" || exit 1

timestamp() {
  date "+%Y-%m-%d %H:%M:%S %Z"
}

{
  printf "[%s] launch: YouMind sync\n" "$(timestamp)"
  "$NODE" "$SCRIPT" --no-git
  script_exit=$?
  printf "[%s] launch: YouMind sync exit=%s\n" "$(timestamp)" "$script_exit"
} >> "$LOG" 2>&1

exit "$script_exit"
