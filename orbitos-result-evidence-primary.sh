#!/bin/zsh
set -eu

RUNTIME="${ORBITOS_RESULT_RUNTIME:-/Users/evander/.local/share/orbitos-result-runtime}"
LOCAL_DIR="${ORBITOS_EVIDENCE_DIR:-/Users/evander/.local/share/orbitos-result-evidence}"
SHADOW_HOST="${ORBITOS_SHADOW_HOST:-evander-shadowdeMac-mini.local}"
SHADOW_USER="${ORBITOS_SHADOW_USER:-shadow}"
SHADOW_HOST_KEY_ALIAS="${ORBITOS_SHADOW_HOST_KEY_ALIAS:-100.125.246.30}"
REMOTE_DIR="/Users/shadow/.local/share/orbitos-result-evidence"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/evander/.npm-global/bin"

if [ -n "${ORBITOS_NODE:-}" ]; then
  NODE="$ORBITOS_NODE"
elif [ -x /opt/homebrew/bin/node ]; then
  NODE=/opt/homebrew/bin/node
elif [ -x /usr/local/bin/node ]; then
  NODE=/usr/local/bin/node
else
  printf "node executable not found; set ORBITOS_NODE\n" >&2
  exit 1
fi

DATE="$($NODE -e 'process.stdout.write(new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()))')"

"$NODE" "$RUNTIME/orbitos-result-evidence.mjs" \
  --date "$DATE" \
  --host primary \
  --include-feishu \
  --output-dir "$LOCAL_DIR"

if [ "${ORBITOS_SKIP_SHADOW_SYNC:-0}" = "1" ]; then
  printf "local evidence ready: %s/primary-%s.json\n" "$LOCAL_DIR" "$DATE"
  exit 0
fi

LOCAL_FILE="$LOCAL_DIR/primary-$DATE.json"
REMOTE_FILE="$REMOTE_DIR/primary-$DATE.json"
REMOTE_TMP="$REMOTE_FILE.tmp-primary"

if /usr/bin/ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o HostKeyAlias="$SHADOW_HOST_KEY_ALIAS" \
  "$SHADOW_USER@$SHADOW_HOST" \
  "/bin/mkdir -p '$REMOTE_DIR' && /bin/cat > '$REMOTE_TMP' && /bin/chmod 600 '$REMOTE_TMP' && /bin/mv '$REMOTE_TMP' '$REMOTE_FILE'" \
  < "$LOCAL_FILE"; then
  printf "synced minimized evidence to Shadow: primary-%s.json\n" "$DATE"
else
  printf "Shadow unavailable; local evidence preserved for next run: primary-%s.json\n" "$DATE" >&2
fi
