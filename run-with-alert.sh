#!/bin/zsh
# run-with-alert: launchd 包装器 —— job 连续失败 ≥2 次就往 vault 00_Inbox 写 ALERT 笔记
# （主人在 Obsidian 能亲眼看到，git-sync 5 分钟拉回本地）；成功一次自动复位计数。
# 用法: run-with-alert.sh <job名> <日志文件> <命令...>
# 背景：2026-08 双子审查发现所有 job 的失败只进 log 文件，无人可见（静默失败红线）。
set -u

JOB="$1"; LOG_FILE="$2"; shift 2
STATE_DIR="$HOME/.config/orbitos-automation/alerts"
COUNT_FILE="$STATE_DIR/$JOB.count"
CONFIG="$HOME/.config/orbitos-automation/config.json"
THRESHOLD=2
mkdir -p "$STATE_DIR"

"$@" >> "$LOG_FILE" 2>&1
CODE=$?

if [ "$CODE" -eq 0 ]; then
  echo 0 > "$COUNT_FILE"
  exit 0
fi

COUNT=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$COUNT" > "$COUNT_FILE"
echo "[$(date '+%F %T')] $JOB failed (exit $CODE), consecutive=$COUNT" >> "$LOG_FILE"

[ "$COUNT" -lt "$THRESHOLD" ] && exit "$CODE"

# ---- 达到阈值：写 ALERT 到 vault（同一天同名覆盖，不刷屏） ----
DATE=$(date '+%F')
ALERT_PATH="00_Inbox/ALERT-$JOB-$DATE.md"
BODY=$(printf '# ALERT: %s 连续失败\n\n- 时间: %s\n- 连续失败次数: %s\n- 最近退出码: %s\n\n## 日志尾部\n\n```\n%s\n```\n' \
  "$JOB" "$(date '+%F %T %Z')" "$COUNT" "$CODE" "$(tail -20 "$LOG_FILE" 2>/dev/null)")
B64=$(printf '%s' "$BODY" | base64)

read OWNER REPO BRANCH TOKEN < <(/usr/bin/python3 -c "
import json
c = json.load(open('$CONFIG'))
print(c['github_owner'], c['github_repo'], c.get('github_branch','main'), c.get('github_token',''))
")
API="https://api.github.com/repos/$OWNER/$REPO/contents"

SHA=$(curl -s --max-time 30 -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "$API/$(python3 -c "import urllib.parse;print(urllib.parse.quote('$ALERT_PATH'))")?ref=$BRANCH" \
  | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin).get('sha',''))" 2>/dev/null)

PAYLOAD=$(/usr/bin/python3 -c "
import json, sys
p = {'message': 'alert: $JOB failing', 'content': '$B64'.replace('\n',''), 'branch': '$BRANCH'}
if '$SHA': p['sha'] = '$SHA'
print(json.dumps(p))
")

RESP=$(curl -s --max-time 30 -X PUT -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" -d "$PAYLOAD" "$API/$(python3 -c "import urllib.parse;print(urllib.parse.quote('$ALERT_PATH'))")")

if printf '%s' "$RESP" | grep -q '"sha"'; then
  echo "[$(date '+%F %T')] ALERT written: $ALERT_PATH (consecutive=$COUNT)" >> "$LOG_FILE"
else
  # 告警上传失败的兜底：至少 stderr 留痕（launchd StandardErrorPath 可见）
  echo "[$(date '+%F %T')] ALERT UPLOAD FAILED for $JOB: $(printf '%s' "$RESP" | head -c 200)" >&2
fi

# ---- 飞书直达通知（2026-09-16：告警只落 vault 无人看见 = 静默失败） ----
# 同一 job 同一天最多发一条 DM，防止每小时失败的告警风暴。
SENT_FILE="$STATE_DIR/$JOB.last-dm"
TODAY=$(date '+%F')
LAST_DM=$(cat "$SENT_FILE" 2>/dev/null || echo '')
if [ "$LAST_DM" != "$TODAY" ]; then
  read LARK_CLI OWNER_ID < <(/usr/bin/python3 -c "
import json
c = json.load(open('$CONFIG'))
print(c.get('lark_cli_path',''), c.get('feishu_user_id',''))
")
  if [ -n "$LARK_CLI" ] && [ -n "$OWNER_ID" ] && [ -x "$LARK_CLI" ]; then
    DM_TEXT=$(printf '⚠️ %s 连续失败 %s 次（退出码 %s）\n日志尾部见 %s' "$JOB" "$COUNT" "$CODE" "$LOG_FILE")
    if "$LARK_CLI" im +messages-send --as user --user-id "$OWNER_ID" --markdown "$DM_TEXT" >/dev/null 2>&1; then
      echo "$TODAY" > "$SENT_FILE"
      echo "[$(date '+%F %T')] alert DM sent to Feishu" >> "$LOG_FILE"
    fi
  fi
fi

exit "$CODE"
