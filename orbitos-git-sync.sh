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

# rebase + autostash：本地有未提交改动先暂存、本地有提交则变基到远端之上，
# 不再因为脏树或本地 commit 就永久跳过（2026-08-03 修：曾因脏树卡住落后 39 个 commit）
if git -C "$VAULT" pull --rebase --autostash origin main >> "$LOG" 2>&1; then
  log "ok: rebased onto remote; ahead=$AHEAD behind=$BEHIND"
else
  # 冲突卡死会每 5 分钟稳定失败——abort 兜底回到干净状态，下轮重试
  log "error: pull --rebase --autostash failed; ahead=$AHEAD behind=$BEHIND; aborting rebase"
  git -C "$VAULT" rebase --abort >> "$LOG" 2>&1 || true
fi

# autostash 警示：pop 冲突会把主人未提交改动留在 stash 里，必须显眼提示
if [ -n "$(git -C "$VAULT" stash list 2>/dev/null)" ]; then
  log "WARNING: stash 非空（可能是 autostash 未恢复）：$(git -C "$VAULT" stash list | head -1)——请人工检查 git stash pop"
fi
