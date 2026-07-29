#!/bin/zsh
set -eu

REPO="/Users/shadow/Work/orbitos-automation"
NODE="/opt/homebrew/bin/node"
DEFAULT_VAULT="${ORBITOS_VAULT_PATH:-/Users/shadow/Work/evander-orbitos-vault}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

MODE="${1:---dry-run}"
case "$MODE" in
  --dry-run|--bootstrap|--send)
    shift || true
    ;;
  *)
    MODE="--dry-run"
    ;;
esac

VAULT="${1:-$DEFAULT_VAULT}"

case "$MODE" in
  --dry-run)
    exec "$NODE" "$REPO/orbitos-brief-push.mjs" --dry-run --local-repo "$VAULT"
    ;;
  --bootstrap)
    exec "$NODE" "$REPO/orbitos-brief-push.mjs" --bootstrap --local-repo "$VAULT"
    ;;
  --send)
    exec "$NODE" "$REPO/orbitos-brief-push.mjs" --local-repo "$VAULT"
    ;;
esac
