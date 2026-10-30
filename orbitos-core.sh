#!/bin/zsh
# orbitos-core: 每小时的主循环（2026-10-30）
# 合并原来分散的 5 分钟/10 分钟/30 分钟任务，降低注意力和故障面：
#   1) 网络探测 —— 无网则记录 pending 并静默退出（不刷失败、不告警）
#   2) git-sync —— vault 与 GitHub 双向同步
#   3) intake —— 飞书 Base 同步 + reconcile + 归档 + 对外行动生成
#   4) ensure-jobs —— 任务自愈 + 日报缺失兜底（本地逻辑，不依赖网络）
# 手动: zsh orbitos-core.sh [--skip-net-check]

set -u

SCRIPT_DIR="${0:A:h}"
source "$SCRIPT_DIR/lib/net-check.sh"

LOG="$SCRIPT_DIR/orbitos-core.log"
NODE=/opt/homebrew/opt/node@22/bin/node
VAULT="/Users/evander/Obsidian/OrbitOS"
TODAY=$(TZ=Asia/Shanghai date '+%F')

log() { printf "[%s] %s\n" "$(TZ=Asia/Shanghai date '+%F %T')" "$*" >> "$LOG"; }

log "=== core start ==="

# 1) 网络：不可用就标记 pending 并退出（这是"断网不乱跑"的关键）
if ! net_ok 8; then
  log "no network → mark pending, skip remote work"
  net_mark_pending "core"
  # 本地兜底仍然执行（缺日报可以本地检测，只是生成要等网络）
  "$SCRIPT_DIR/ensure-jobs.sh" >> "$LOG" 2>&1 || true
  log "=== core end (offline) ==="
  exit 0
fi
net_clear_pending "core"

# 2) git 同步（失败不阻断后续）
if ! zsh "$SCRIPT_DIR/orbitos-git-sync.sh" >> "$LOG" 2>&1; then
  log "warn: git-sync failed, continue"
fi

# 2b) 书签同步（YouMind，原 30 分钟 → 每小时）
if [ -x "$SCRIPT_DIR/orbitos-youmind-sync.sh" ]; then
  zsh "$SCRIPT_DIR/orbitos-youmind-sync.sh" >> "$LOG" 2>&1 || log "warn: youmind-sync failed"
fi

# 2c) X 时间线抓取（原 60 分钟 → 合并进 core）
if [ -f "$SCRIPT_DIR/monitor-timeline-fetcher.mjs" ]; then
  "$NODE" "$SCRIPT_DIR/monitor-timeline-fetcher.mjs" >> "$LOG" 2>&1 || log "warn: monitor failed"
fi

# 3) intake：Base 同步 / reconcile / 归档 / 对外行动（任一失败不阻断）
if [ -x "$SCRIPT_DIR/orbitos-intake-loop.sh" ]; then
  zsh "$SCRIPT_DIR/orbitos-intake-loop.sh" >> "$LOG" 2>&1 || log "warn: intake-loop failed"
fi

# 4) 推送未送达的日报/周报（幂等：已推过的 SHA 会跳过）
if [ -f "$SCRIPT_DIR/orbitos-brief-push.mjs" ]; then
  "$NODE" "$SCRIPT_DIR/orbitos-brief-push.mjs" >> "$LOG" 2>&1 || log "warn: brief-push failed"
fi

# 5) 兜底：任务自愈 + 缺失产物补跑
"$SCRIPT_DIR/ensure-jobs.sh" >> "$LOG" 2>&1 || log "warn: ensure-jobs failed"

log "=== core end (online) ==="
exit 0
