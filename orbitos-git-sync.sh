#!/bin/zsh
set -eu

VAULT="/Users/evander/Obsidian/OrbitOS"
LOG="/Users/evander/codex/orbitos-automation/orbitos-git-sync.log"

timestamp() {
  date "+%Y-%m-%d %H:%M:%S %Z"
}

log() {
  printf "[%s] %s\n" "$(timestamp)" "$*" >> "$LOG"
}

if [ ! -d "$VAULT/.git" ]; then
  log "skip: vault git repo not found at $VAULT"
  exit 0
fi

if ! git -C "$VAULT" rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" >/dev/null 2>&1; then
  log "skip: no upstream configured"
  exit 0
fi

if ! git -C "$VAULT" fetch --prune origin main >> "$LOG" 2>&1; then
  log "error: fetch failed"
  exit 0
fi

DIVERGENCE="$(git -C "$VAULT" rev-list --left-right --count "HEAD...@{upstream}")"
AHEAD="${DIVERGENCE%%	*}"
BEHIND="${DIVERGENCE##*	}"

if [ "$BEHIND" = "0" ]; then
  log "ok: up to date; ahead=$AHEAD behind=$BEHIND"
  exit 0
fi

if ! git -C "$VAULT" diff --quiet; then
  log "skip: tracked working tree changes present; ahead=$AHEAD behind=$BEHIND"
  exit 0
fi

if ! git -C "$VAULT" diff --cached --quiet; then
  log "skip: staged changes present; ahead=$AHEAD behind=$BEHIND"
  exit 0
fi

if git -C "$VAULT" pull --ff-only origin main >> "$LOG" 2>&1; then
  log "ok: pulled remote changes; ahead=$AHEAD behind=$BEHIND"
else
  log "error: pull --ff-only failed; ahead=$AHEAD behind=$BEHIND"
fi
