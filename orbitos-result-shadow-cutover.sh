#!/bin/zsh
set -eu

REPO="${ORBITOS_AUTOMATION_REPO:-/Users/shadow/Work/orbitos-automation}"
VAULT="${ORBITOS_VAULT_PATH:-/Users/shadow/Work/evander-orbitos-vault}"
EVIDENCE_DIR="${ORBITOS_EVIDENCE_DIR:-/Users/shadow/.local/share/orbitos-result-evidence}"
NODE="${ORBITOS_NODE:-/opt/homebrew/bin/node}"
DOMAIN="gui/$(/usr/bin/id -u)"
LAUNCH_AGENTS="/Users/shadow/Library/LaunchAgents"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/shadow/.npm-global/bin"

MODE="${1:---preflight}"
DATE="${2:-$($NODE -e 'process.stdout.write(new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()))')}"

managed_files=(
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

fail() {
  printf "cutover failed: %s\n" "$1" >&2
  exit 1
}

assert_timezone() {
  local timezone
  timezone="$(/bin/ls -l /etc/localtime 2>/dev/null | /usr/bin/awk '{print $NF}')"
  [ "$timezone" = "/var/db/timezone/zoneinfo/Asia/Shanghai" ] || fail "system timezone must be Asia/Shanghai"
}

assert_date() {
  "$NODE" -e 'const v=process.argv[1]; const d=new Date(v+"T00:00:00Z"); if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==v) process.exit(1)' "$DATE" \
    || fail "date must be a real YYYY-MM-DD"
}

run_tests() {
  /bin/zsh -n "$REPO/orbitos-synthesis-launchd.sh"
  /bin/zsh -n "$REPO/orbitos-result-evidence-primary.sh"
  /bin/zsh -n "$REPO/orbitos-result-shadow-cutover.sh"
  /bin/zsh -n "$REPO/orbitos-result-deploy-from-primary.sh"
  for plist in \
    com.evander.orbitos-result-daily.plist.template \
    com.evander.orbitos-result-weekly.plist.template \
    com.evander.orbitos-result-push-shadow.plist.template \
    com.evander.orbitos-result-evidence-primary.plist.template; do
    /usr/bin/plutil -lint "$REPO/$plist" >/dev/null
  done
  (
    cd "$REPO"
    "$NODE" --test tests/*.test.mjs
  )
}

dry_run() {
  "$NODE" "$REPO/orbitos-synthesis.mjs" result-daily --dry-run --date "$DATE" --vault "$VAULT" --evidence-dir "$EVIDENCE_DIR"
  "$NODE" "$REPO/orbitos-synthesis.mjs" result-weekly --dry-run --date "$DATE" --vault "$VAULT" --evidence-dir "$EVIDENCE_DIR"
  "$NODE" "$REPO/orbitos-brief-push.mjs" --dry-run --local-repo "$VAULT"
}

is_managed_file() {
  local candidate="$1"
  local expected
  for expected in "${managed_files[@]}"; do
    [ "$candidate" = "$expected" ] && return 0
  done
  return 1
}

assert_only_managed_changes() {
  local changed
  local paths
  paths="$(/usr/bin/git -C "$REPO" diff --name-only; /usr/bin/git -C "$REPO" ls-files --others --exclude-standard)"
  while IFS= read -r changed; do
    [ -z "$changed" ] && continue
    is_managed_file "$changed" || fail "unrelated automation repo change: $changed"
  done <<< "$paths"
}

install_prompt_files() {
  [ -d "$VAULT/.git" ] || fail "vault is not a Git worktree"
  [ -z "$(/usr/bin/git -C "$VAULT" status --porcelain)" ] || fail "vault worktree is dirty"
  /usr/bin/git -C "$VAULT" pull --ff-only
  /bin/mkdir -p "$VAULT/99_System/Prompts"
  /bin/cp "$REPO/Result_Daily.md" "$VAULT/99_System/Prompts/Result_Daily.md"
  /bin/cp "$REPO/Result_Weekly.md" "$VAULT/99_System/Prompts/Result_Weekly.md"
  /usr/bin/git -C "$VAULT" add -- 99_System/Prompts/Result_Daily.md 99_System/Prompts/Result_Weekly.md
  if ! /usr/bin/git -C "$VAULT" diff --cached --quiet; then
    /usr/bin/git -C "$VAULT" commit -m "chore: add result review prompts" -- \
      99_System/Prompts/Result_Daily.md 99_System/Prompts/Result_Weekly.md
    /usr/bin/git -C "$VAULT" push
  fi
}

bootout_if_loaded() {
  /bin/launchctl bootout "$DOMAIN/$1" >/dev/null 2>&1 || true
}

install_jobs() {
  /bin/mkdir -p "$LAUNCH_AGENTS" /Users/shadow/Library/Logs "$EVIDENCE_DIR"
  /bin/chmod 700 "$EVIDENCE_DIR"

  /bin/cp "$REPO/com.evander.orbitos-result-daily.plist.template" "$LAUNCH_AGENTS/com.evander.orbitos-result-daily.plist"
  /bin/cp "$REPO/com.evander.orbitos-result-weekly.plist.template" "$LAUNCH_AGENTS/com.evander.orbitos-result-weekly.plist"
  /bin/cp "$REPO/com.evander.orbitos-result-push-shadow.plist.template" "$LAUNCH_AGENTS/com.evander.orbitos-result-push-shadow.plist"

  for old in \
    com.evander.orbitos-synthesis-daily \
    com.evander.orbitos-synthesis-weekly \
    com.evander.orbitos-brief-push-shadow; do
    bootout_if_loaded "$old"
    /bin/launchctl disable "$DOMAIN/$old"
  done

  for current in \
    com.evander.orbitos-result-daily \
    com.evander.orbitos-result-weekly \
    com.evander.orbitos-result-push-shadow; do
    bootout_if_loaded "$current"
    /bin/launchctl enable "$DOMAIN/$current"
    /bin/launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENTS/$current.plist"
  done
}

install_repo_commit() {
  assert_only_managed_changes
  /usr/bin/git -C "$REPO" add -- "${managed_files[@]}"
  if ! /usr/bin/git -C "$REPO" diff --cached --quiet; then
    /usr/bin/git -C "$REPO" commit -m "feat: replace synthesis with result-led reviews" -- "${managed_files[@]}"
    /usr/bin/git -C "$REPO" push
  fi
  [ -z "$(/usr/bin/git -C "$REPO" status --porcelain)" ] || fail "automation repo remained dirty after commit"
}

assert_primary_evidence() {
  [ -s "$EVIDENCE_DIR/primary-$DATE.json" ] || fail "current primary evidence is missing for $DATE"
}

verify_jobs() {
  for current in \
    com.evander.orbitos-result-daily \
    com.evander.orbitos-result-weekly \
    com.evander.orbitos-result-push-shadow; do
    /bin/launchctl print "$DOMAIN/$current" >/dev/null || fail "$current is not loaded"
  done
  for old in \
    com.evander.orbitos-synthesis-daily \
    com.evander.orbitos-synthesis-weekly \
    com.evander.orbitos-brief-push-shadow; do
    if /bin/launchctl print "$DOMAIN/$old" >/dev/null 2>&1; then
      fail "$old is still loaded"
    fi
  done
  printf "verified: result jobs loaded; old synthesis and push jobs unloaded\n"
}

assert_timezone
assert_date

case "$MODE" in
  --preflight)
    run_tests
    dry_run
    printf "preflight passed for %s\n" "$DATE"
    ;;
  --install)
    [ "${ORBITOS_CUTOVER_APPROVED:-}" = "YES" ] || fail "set ORBITOS_CUTOVER_APPROVED=YES for install"
    [ "${ORBITOS_CLOUD_DAILY_WEEKLY_DISABLED:-}" = "YES" ] \
      || fail "confirm n8n cloud Daily/Weekly workflows are inactive with ORBITOS_CLOUD_DAILY_WEEKLY_DISABLED=YES"
    run_tests
    install_repo_commit
    install_prompt_files
    "$NODE" "$REPO/orbitos-brief-push.mjs" --bootstrap --local-repo "$VAULT"
    install_jobs
    verify_jobs
    printf "installed result runtime; no report generated by install\n"
    ;;
  --acceptance)
    [ "${ORBITOS_CUTOVER_APPROVED:-}" = "YES" ] || fail "set ORBITOS_CUTOVER_APPROVED=YES for acceptance"
    assert_primary_evidence
    "$NODE" "$REPO/orbitos-synthesis.mjs" result-daily --apply --date "$DATE" --vault "$VAULT" --evidence-dir "$EVIDENCE_DIR"
    "$REPO/orbitos-brief-push-launchd.sh" --send "$VAULT"
    "$NODE" -e 'import(process.argv[1]).then(({validateResultArtifact})=>{const fs=require("node:fs");validateResultArtifact(fs.readFileSync(process.argv[2],"utf8"),"result-daily");console.log("artifact semantic validation passed")})' \
      "file://$REPO/orbitos-synthesis.mjs" "$VAULT/10_Daily/result-daily-$DATE.md"
    verify_jobs
    printf "acceptance passed for result daily %s\n" "$DATE"
    ;;
  --verify)
    run_tests
    verify_jobs
    dry_run
    ;;
  --stop-new)
    [ "${ORBITOS_CUTOVER_APPROVED:-}" = "YES" ] || fail "set ORBITOS_CUTOVER_APPROVED=YES for stop-new"
    for current in \
      com.evander.orbitos-result-daily \
      com.evander.orbitos-result-weekly \
      com.evander.orbitos-result-push-shadow; do
      bootout_if_loaded "$current"
      /bin/launchctl disable "$DOMAIN/$current"
    done
    printf "new result jobs stopped; old jobs remain disabled\n"
    ;;
  *)
    fail "usage: orbitos-result-shadow-cutover.sh <--preflight|--install|--acceptance|--verify|--stop-new> [YYYY-MM-DD]"
    ;;
esac
