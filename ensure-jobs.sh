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
