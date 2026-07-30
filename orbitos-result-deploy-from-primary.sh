#!/bin/zsh
set -eu

ROOT="${0:A:h}"
MODE="${1:---preflight}"
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

DATE="${2:-$($NODE -e 'process.stdout.write(new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()))')}"
SHADOW_HOST="${ORBITOS_SHADOW_HOST:-evander-shadowdeMac-mini.local}"
SHADOW_USER="${ORBITOS_SHADOW_USER:-shadow}"
SHADOW_HOST_KEY_ALIAS="${ORBITOS_SHADOW_HOST_KEY_ALIAS:-100.125.246.30}"
REMOTE_REPO="/Users/shadow/Work/orbitos-automation"
REMOTE_STAGE="/Users/shadow/.cache/orbitos-result-cutover/stage"
PRIMARY_RUNTIME="/Users/evander/.local/share/orbitos-result-runtime"
PRIMARY_AGENT="/Users/evander/Library/LaunchAgents/com.evander.orbitos-result-evidence-primary.plist"
DOMAIN="gui/$(/usr/bin/id -u)"

files=(
  orbitos-synthesis.mjs
  orbitos-brief-push.mjs
  orbitos-result-evidence.mjs
  orbitos-synthesis-launchd.sh
  orbitos-result-evidence-primary.sh
  orbitos-result-shadow-cutover.sh
  orbitos-result-deploy-from-primary.sh
  analyst-agent-logic.mjs
  today-md-logic.mjs
  Result_Daily.md
  Result_Weekly.md
  com.evander.orbitos-result-daily.plist.template
  com.evander.orbitos-result-weekly.plist.template
  com.evander.orbitos-result-push-shadow.plist.template
  com.evander.orbitos-result-evidence-primary.plist.template
  tests/orbitos-result-review.test.mjs
  tests/orbitos-result-evidence.test.mjs
  tests/orbitos-result-push.test.mjs
  tests/orbitos-result-runtime.test.mjs
  tests/analyst-agent-logic.test.mjs
  tests/today-md-logic.test.mjs
  README.md
  GETTING_STARTED.md
  TOMORROW_RESULT_CUTOVER.md
)

ssh_shadow() {
  /usr/bin/ssh \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o HostKeyAlias="$SHADOW_HOST_KEY_ALIAS" \
    "$SHADOW_USER@$SHADOW_HOST" "$@"
}

copy_files_to() {
  local destination="$1"
  /usr/bin/tar -C "$ROOT" -cf - "${files[@]}" | ssh_shadow "/usr/bin/tar -xf - -C '$destination'"
}

local_checks() {
  /bin/zsh -n "$ROOT/orbitos-result-deploy-from-primary.sh"
  /bin/zsh -n "$ROOT/orbitos-result-evidence-primary.sh"
  /bin/zsh -n "$ROOT/orbitos-result-shadow-cutover.sh"
  "$NODE" --test "$ROOT"/tests/*.test.mjs
}

install_primary_collector() {
  /bin/mkdir -p "$PRIMARY_RUNTIME" /Users/evander/Library/LaunchAgents /Users/evander/Library/Logs
  /usr/bin/install -m 700 "$ROOT/orbitos-result-evidence.mjs" "$PRIMARY_RUNTIME/orbitos-result-evidence.mjs"
  /usr/bin/install -m 700 "$ROOT/orbitos-result-evidence-primary.sh" "$PRIMARY_RUNTIME/orbitos-result-evidence-primary.sh"
  /bin/cp "$ROOT/com.evander.orbitos-result-evidence-primary.plist.template" "$PRIMARY_AGENT"
  /bin/launchctl bootout "$DOMAIN/com.evander.orbitos-result-evidence-primary" >/dev/null 2>&1 || true
  /bin/launchctl enable "$DOMAIN/com.evander.orbitos-result-evidence-primary"
  /bin/launchctl bootstrap "$DOMAIN" "$PRIMARY_AGENT"
}

case "$MODE" in
  --preflight)
    local_checks
    ssh_shadow "/bin/rm -rf '$REMOTE_STAGE' && /bin/mkdir -p '$REMOTE_STAGE' && /bin/cp -R '$REMOTE_REPO/.' '$REMOTE_STAGE/'"
    copy_files_to "$REMOTE_STAGE"
    ssh_shadow "ORBITOS_AUTOMATION_REPO='$REMOTE_STAGE' '$REMOTE_STAGE/orbitos-result-shadow-cutover.sh' --preflight '$DATE'"
    printf "remote staging preflight passed; production unchanged\n"
    ;;
  --install)
    [ "${ORBITOS_CUTOVER_APPROVED:-}" = "YES" ] || { printf "set ORBITOS_CUTOVER_APPROVED=YES for install\n" >&2; exit 1; }
    [ "${ORBITOS_CLOUD_DAILY_WEEKLY_DISABLED:-}" = "YES" ] || { printf "confirm n8n cloud Daily/Weekly workflows are inactive with ORBITOS_CLOUD_DAILY_WEEKLY_DISABLED=YES\n" >&2; exit 1; }
    local_checks
    ssh_shadow "test -z \"\$(/usr/bin/git -C '$REMOTE_REPO' status --porcelain)\""
    copy_files_to "$REMOTE_REPO"
    ssh_shadow "ORBITOS_CUTOVER_APPROVED=YES ORBITOS_CLOUD_DAILY_WEEKLY_DISABLED=YES '$REMOTE_REPO/orbitos-result-shadow-cutover.sh' --install '$DATE'"
    install_primary_collector
    printf "installed both lanes; acceptance has not run yet\n"
    ;;
  --acceptance)
    [ "${ORBITOS_CUTOVER_APPROVED:-}" = "YES" ] || { printf "set ORBITOS_CUTOVER_APPROVED=YES for acceptance\n" >&2; exit 1; }
    "$PRIMARY_RUNTIME/orbitos-result-evidence-primary.sh"
    ssh_shadow "ORBITOS_CUTOVER_APPROVED=YES '$REMOTE_REPO/orbitos-result-shadow-cutover.sh' --acceptance '$DATE'"
    ;;
  --verify)
    local_checks
    /bin/launchctl print "$DOMAIN/com.evander.orbitos-result-evidence-primary" >/dev/null
    ssh_shadow "'$REMOTE_REPO/orbitos-result-shadow-cutover.sh' --verify '$DATE'"
    ;;
  --stop-new)
    [ "${ORBITOS_CUTOVER_APPROVED:-}" = "YES" ] || { printf "set ORBITOS_CUTOVER_APPROVED=YES for stop-new\n" >&2; exit 1; }
    /bin/launchctl bootout "$DOMAIN/com.evander.orbitos-result-evidence-primary" >/dev/null 2>&1 || true
    /bin/launchctl disable "$DOMAIN/com.evander.orbitos-result-evidence-primary"
    ssh_shadow "ORBITOS_CUTOVER_APPROVED=YES '$REMOTE_REPO/orbitos-result-shadow-cutover.sh' --stop-new '$DATE'"
    ;;
  *)
    printf "usage: orbitos-result-deploy-from-primary.sh <--preflight|--install|--acceptance|--verify|--stop-new> [YYYY-MM-DD]\n" >&2
    exit 2
    ;;
esac
