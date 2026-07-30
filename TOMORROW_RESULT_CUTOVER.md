# Shadow Result Runtime Cutover

This runbook is intentionally short. Run it from the primary Mac after Shadow is
online on the same LAN. It uses SSH only and does not take over the mouse.

Set the Shanghai date once for the whole cutover:

```bash
cd /Users/evander/codex/orbitos-result-system
DATE="$(TZ=Asia/Shanghai /bin/date +%F)"
```

## DONE signal

- Every active n8n Cloud workflow named `OrbitOS_Daily_Brief_Cloud` or
  `OrbitOS_Weekly_Synthesis_Cloud` is inactive. Workflow IDs are not trusted.
- Primary evidence packet is present on Shadow with mode `600`.
- `10_Daily/result-daily-YYYY-MM-DD.md` exists in the Obsidian vault and passes
  the seven-section semantic gate.
- The matching Git commit is pushed.
- Feishu contains exactly one bot message titled `超级个体结果日报 — YYYY-MM-DD`.
- New daily, weekly, and push jobs are loaded; old synthesis and brief-push jobs
  are unloaded and disabled.
- The old Codex heartbeat is disabled only after the Feishu readback succeeds.

## 1. Disable the two cloud report workflows

In n8n Cloud, find workflows by exact name and deactivate every active match:

- `OrbitOS_Daily_Brief_Cloud`
- `OrbitOS_Weekly_Synthesis_Cloud`

Confirm both names have no active workflow before install. Do not use a saved
workflow ID: historical records contain conflicting Daily IDs. Do not change
Telegram or any other n8n workflow.

## 2. Staging preflight

Production remains unchanged. The script copies the current Shadow repo to a
staging directory, overlays the prepared files, runs the complete test suite and
both result dry-runs.

```bash
./orbitos-result-deploy-from-primary.sh --preflight "$DATE"
```

## 3. Install both lanes

This commits and pushes the prepared automation changes and vault prompts,
bootstraps the historical push ledger, installs the primary collector, and
loads the new Shadow jobs. It does not generate or send a report.

```bash
ORBITOS_CUTOVER_APPROVED=YES \
ORBITOS_CLOUD_DAILY_WEEKLY_DISABLED=YES \
  ./orbitos-result-deploy-from-primary.sh --install "$DATE"
```

The second variable is a deliberate operator attestation. Do not set it until
the two exact n8n Cloud workflow names above have been checked as inactive.

## 4. One real acceptance run

This refreshes and transfers the primary packet, generates one result daily on
Shadow, commits/pushes it, sends it through the bot identity, and verifies the
artifact plus launchd state.

```bash
ORBITOS_CUTOVER_APPROVED=YES \
  ./orbitos-result-deploy-from-primary.sh --acceptance "$DATE"
```

## 5. Independent Feishu readback

Use the primary user's read identity. Confirm exactly one result for the date
and inspect its body against the product contract.

```bash
lark-cli im +messages-search --as user \
  --query "超级个体结果日报" \
  --start "${DATE}T00:00:00+08:00" \
  --end "${DATE}T23:59:59+08:00" \
  --page-all --format json
```

Only after this succeeds, disable the existing Codex automation
`每日语料复盘与能力处方` through the Codex automation API. Do not edit its TOML by
hand.

## 6. Final verification

```bash
./orbitos-result-deploy-from-primary.sh --verify "$DATE"
```

## Stop without restoring rejected reports

If acceptance fails after install, stop the new jobs. This deliberately leaves
the old knowledge jobs disabled to prevent duplicate or low-value reports.

```bash
ORBITOS_CUTOVER_APPROVED=YES \
  ./orbitos-result-deploy-from-primary.sh --stop-new "$DATE"
```

Evidence packets and raw conversations are never committed. Secret values are
read only from the existing protected runtime stores on each host.

The primary Obsidian worktree may contain user-owned edits. The cutover writes
the accepted artifact in Shadow's canonical vault and pushes that vault commit;
it does not force-pull or clean `/Users/evander/Obsidian/OrbitOS`.
