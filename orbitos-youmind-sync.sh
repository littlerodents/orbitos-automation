#!/bin/zsh
set -u

NODE="/usr/local/bin/node"
SCRIPT="/Users/evander/codex/orbitos-automation/youmind-sync.mjs"
LOG="/Users/evander/codex/orbitos-automation/orbitos-youmind-sync.log"

timestamp() {
  date "+%Y-%m-%d %H:%M:%S %Z"
}

{
  printf "[%s] launch: YouMind sync\n" "$(timestamp)"
  "$NODE" "$SCRIPT"
  printf "[%s] launch: YouMind sync exit=%s\n" "$(timestamp)" "$?"
} >> "$LOG" 2>&1
