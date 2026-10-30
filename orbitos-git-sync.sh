#!/bin/zsh
set -eu

SCRIPT_DIR="${0:A:h}"
source "$SCRIPT_DIR/lib/net-check.sh"

# 2026-10-30：无论脚本从哪条路退出（含 fetch/rebase 失败），都执行本地兜底。
# 之前兜底挂在文件末尾，任何 exit 1 都会跳过后面的 ensure-jobs —— 断网=日报永久缺失。
run_fallback() {
  if [ -x "$SCRIPT_DIR/ensure-jobs.sh" ]; then
    "$SCRIPT_DIR/ensure-jobs.sh" >/dev/null 2>&1 || true
  fi
}
trap run_fallback EXIT

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
  # 2026-10-30 修复：原来这里 exit 1，导致尾部的 ensure-jobs（本地兜底）永远不执行，
  # 断网 = 日报永久缺失且无人知道。现在：记一次失败 + 标记 pending，继续往下走。
  log "warn: fetch failed (network?), continuing to local fallback"
  net_mark_pending "git-sync"
  if ! net_ok 8; then
    log "skip: no network"
    # 仍要执行兜底逻辑（本地检查），所以不 exit
  fi
fi

DIVERGENCE="$(git -C "$VAULT" rev-list --left-right --count "HEAD...@{upstream}")"
AHEAD="${DIVERGENCE%%	*}"
BEHIND="${DIVERGENCE##*	}"

# 推送本地领先提交（vault 备份 / 日报提交）。obsidian-git 的推送在 2026-08 rebase
# 事故后不可靠，此处成为唯一稳定推送通道；失败只记日志，下轮（5 分钟后）自动重试。
# 放在 rebase 分支之前 —— behind=0 的早退路径也必须执行推送。
if [ "$AHEAD" != "0" ]; then
  if git -C "$VAULT" push origin main >> "$LOG" 2>&1; then
    log "ok: pushed $AHEAD commit(s)"
  else
    log "warn: push failed, will retry next cycle (ahead=$AHEAD)"
  fi
fi

if [ "$BEHIND" = "0" ]; then
  log "ok: up to date; ahead=$AHEAD behind=$BEHIND"
  net_clear_pending "git-sync"
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
  exit 1
fi

# autostash 警示：pop 冲突会把主人未提交改动留在 stash 里，必须显眼提示
if [ -n "$(git -C "$VAULT" stash list 2>/dev/null)" ]; then
  log "WARNING: stash 非空（可能是 autostash 未恢复）：$(git -C "$VAULT" stash list | head -1)——请人工检查 git stash pop"
fi
# 兜底由上面的 trap run_fallback EXIT 统一执行
