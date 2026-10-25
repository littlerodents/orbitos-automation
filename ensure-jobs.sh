#!/bin/zsh
# ensure-jobs: 自动化守护 —— 关键 launchd 任务掉线自动拉起，plist 丢失自动从仓库副本恢复。
# 背景：2026-09-21 一次清理误删了 daily-brief/brief-push 的脚本与 plist，系统静默空转 8 天
# 才被发现。本脚本由 git-sync（5 分钟一轮）尾部调用，让这类破坏在 5 分钟内自愈。
set -u

LOG="/Users/evander/Labs/codex/orbitos-automation/ensure-jobs.log"
REPO_LAUNCHD="/Users/evander/Labs/codex/orbitos-automation/launchd"
AGENTS_DIR="$HOME/Library/LaunchAgents"
GUARD_STATE="$HOME/.config/orbitos-automation/guard"
CONFIG="$HOME/.config/orbitos-automation/config.json"
UID_=$(id -u)

JOBS=(
  com.evander.orbitos-daily-brief
  com.evander.orbitos-weekly-synthesis
  com.evander.orbitos-brief-push-v2
  com.evander.orbitos-bookmark-organizer
  com.evander.orbitos-git-sync
  com.evander.monitor-timeline-fetcher
  com.evander.orbitos-learning-fetcher
  com.evander.orbitos-evening-reminder
  com.evander.orbitos-archive-sweeper
  com.evander.cdp-proxy
  com.evander.chrome-x-automation
)

mkdir -p "$GUARD_STATE"
ACTED=""

for j in $JOBS; do
  if launchctl print "gui/$UID_/$j" >/dev/null 2>&1; then continue; fi
  plist="$AGENTS_DIR/$j.plist"
  # plist 被删 → 从仓库副本恢复
  if [ ! -f "$plist" ] && [ -f "$REPO_LAUNCHD/$j.plist" ]; then
    cp "$REPO_LAUNCHD/$j.plist" "$plist"
    echo "[$(date '+%F %T')] guard: restored plist for $j from repo copy" >> "$LOG"
    ACTED="$ACTED $j(plist)"
  fi
  if [ -f "$plist" ]; then
    launchctl enable "gui/$UID_/$j" >/dev/null 2>&1
    if launchctl bootstrap "gui/$UID_" "$plist" >/dev/null 2>&1; then
      echo "[$(date '+%F %T')] guard: reloaded $j" >> "$LOG"
      ACTED="$ACTED $j(reload)"
    else
      echo "[$(date '+%F %T')] guard: FAILED to reload $j" >> "$LOG"
    fi
  else
    echo "[$(date '+%F %T')] guard: $j plist missing and no repo copy" >> "$LOG"
  fi
done

# 有自愈动作时飞书通知（每天最多一条）
if [ -n "$ACTED" ]; then
  TODAY=$(date '+%F')
  if [ "$(cat "$GUARD_STATE/last-dm" 2>/dev/null)" != "$TODAY" ]; then
    read LARK_CLI OWNER_ID < <(/usr/bin/python3 -c "
import json
c = json.load(open('$CONFIG'))
print(c.get('lark_cli_path',''), c.get('feishu_user_id',''))
")
    if [ -n "$LARK_CLI" ] && [ -x "$LARK_CLI" ]; then
      PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/Users/evander/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH" \
        "$LARK_CLI" im +messages-send --as user --user-id "$OWNER_ID" \
        --markdown "🔧 自动化守护已自愈：$ACTED（详见 ensure-jobs.log）" >/dev/null 2>&1 \
        && echo "$TODAY" > "$GUARD_STATE/last-dm"
    fi
  fi
fi

# ---- 日报兜底（2026-10-02 教训：单次触发+网络抖动=静默漏发三天） ----
# 过了 11:35 还没有今天的 brief 文件 → 补跑（经 run-with-alert，连败两次飞书告警）。
# 每 5 分钟随 git-sync 检查；跑成功后文件存在，自然退出。
NODE_BIN="/opt/homebrew/opt/node@22/bin/node"
BRIEF_SCRIPT="/Users/evander/Labs/codex/orbitos-automation/orbitos-daily-brief.mjs"
BRIEF_LOG="/Users/evander/Labs/codex/orbitos-automation/orbitos-daily-brief.log"
TODAY_STR=$(TZ=Asia/Shanghai date '+%F')
BRIEF_FILE="$HOME/Obsidian/OrbitOS/00_Inbox/brief-$TODAY_STR.md"
HOUR_NOW=$(TZ=Asia/Shanghai date '+%H')
MIN_NOW=$(TZ=Asia/Shanghai date '+%M')
LOCK_DIR="/tmp/orbitos-brief-catchup.lock"

if [ "$HOUR_NOW" -gt 11 ] || { [ "$HOUR_NOW" -eq 11 ] && [ "$MIN_NOW" -ge 35 ]; }; then
  if [ ! -f "$BRIEF_FILE" ] && catchup_lock_acquire "$LOCK_DIR" 1800; then
    {
      # 无条件清理（不依赖 trap：后台子进程被 kill 时 trap 不一定执行 → 锁会永久残留）
      trap 'catchup_lock_release "$LOCK_DIR"' EXIT INT TERM HUP
      echo "[$(date '+%F %T')] catchup: brief for $TODAY_STR missing, running" >> "$BRIEF_LOG"
      /Users/evander/Labs/codex/orbitos-automation/run-with-alert.sh \
        "daily-brief-catchup" "$BRIEF_LOG" \
        "$NODE_BIN" "$BRIEF_SCRIPT"
      if [ -f "$BRIEF_FILE" ]; then
        echo "[$(date '+%F %T')] catchup: brief for $TODAY_STR generated OK" >> "$BRIEF_LOG"
      else
        echo "[$(date '+%F %T')] catchup: brief for $TODAY_STR still missing, will retry next cycle" >> "$BRIEF_LOG"
      fi
      catchup_lock_release "$LOCK_DIR"
      trap - EXIT INT TERM HUP
    } &
  fi
fi
