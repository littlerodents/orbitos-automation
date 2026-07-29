#!/bin/zsh
set -eu

REPO="/Users/shadow/Work/orbitos-automation"
NODE="/opt/homebrew/bin/node"
VAULT="${ORBITOS_VAULT_PATH:-/Users/shadow/Work/evander-orbitos-vault}"
MODE="${1:-daily}"
ACTION="${2:---dry-run}"
DATE_ARG="${3:-}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [ "$(/bin/ls -l /etc/localtime 2>/dev/null | /usr/bin/awk '{print $NF}')" != "/var/db/timezone/zoneinfo/Asia/Shanghai" ]; then
  printf "skip: system timezone must be Asia/Shanghai\n"
  exit 0
fi

if [ "$ACTION" != "--dry-run" ] && [ "$ACTION" != "--apply" ]; then
  printf "usage: orbitos-synthesis-launchd.sh <daily|weekly> [--dry-run|--apply] [YYYY-MM-DD]\n"
  exit 2
fi

if [ -n "$DATE_ARG" ]; then
  exec "$NODE" "$REPO/orbitos-synthesis.mjs" "$MODE" "$ACTION" --date "$DATE_ARG" --vault "$VAULT"
fi

exec "$NODE" "$REPO/orbitos-synthesis.mjs" "$MODE" "$ACTION" --vault "$VAULT"
