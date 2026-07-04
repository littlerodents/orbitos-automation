#!/bin/zsh
set -u

NODE="/usr/local/bin/node"
SCRIPT="/Users/evander/codex/orbitos-automation/feishu-flag-sync.mjs"
LOG="/Users/evander/codex/orbitos-automation/orbitos-feishu-flag-sync.log"

timestamp() {
  date "+%Y-%m-%d %H:%M:%S %Z"
}

{
  printf "[%s] launch: Feishu flag sync\n" "$(timestamp)"
  "$NODE" "$SCRIPT"
  exit_code="$?"
  printf "[%s] launch: Feishu flag sync exit=%s\n" "$(timestamp)" "$exit_code"
  exit "$exit_code"
} >> "$LOG" 2>&1
