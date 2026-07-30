# OrbitOS Automation

Local scripts + n8n cloud workflows for the OrbitOS personal knowledge system.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        n8n cloud (7 workflows)                      │
│                                                                     │
│  🟢 Daily Brief        — 08:00 Mon-Fri, DeepSeek v4-pro             │
│  🟢 Weekly Synthesis   — 10:00 Sun, DeepSeek v4-pro                 │
│  🟢 Telegram Capture   — bot polling (no LLM)                       │
│  🟢 Researcher Agent   — 10min scan #task inbox, Exa + DeepSeek     │
│  🟢 Analyst Agent      — 30min scan Selected notes, DeepSeek        │
│  🟢 Filter Agent       — 4h, 6 interest clusters, Exa + DeepSeek   │
│  🟢 Following Monitor  — 10:00+18:00, X timeline via CDP cache      │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ GitHub API (vault = git repo)
┌──────────────────────────┴──────────────────────────────────────────┐
│                    Local (launchd + scripts)                        │
│                                                                     │
│  brief-push          — GitHub → Feishu DM (retry + verify push)     │
│  feishu-flag-sync    — Feishu flag → vault inbox                    │
│  git-sync            — vault git auto push                          │
│  intake-loop         — OrbitOS intake processing                    │
│  youmind-sync        — YouMind → vault                              │
│  monitor-timeline    — CDP scrape X timeline → GitHub cache (30min) │
└─────────────────────────────────────────────────────────────────────┘
```

## Agents (DI architecture, 100% test coverage)

All agent logic modules use dependency injection — external calls (GitHub API, Exa search, DeepSeek LLM, CDP timeline) go through injectable runner functions. Tests inject mocks; n8n Code nodes inject real `this.helpers.httpRequest` implementations.

| Module | Tests | Coverage | Description |
|--------|-------|----------|-------------|
| `researcher-agent-logic.mjs` | 67 | 100% | Single-topic deep search + increment judgment |
| `analyst-agent-logic.mjs` | 40 | 100% | Cross-note pattern analysis (signposts + noise) |
| `filter-agent-logic.mjs` | 27 | 100% | 6 interest clusters, weighted, auto-inferred |
| `monitor-agent-logic.mjs` | 41 | 100% | X timeline engagement filter + tab signals |
| `orbitos-brief-push.mjs` | 60 | 89.67% | Feishu DM delivery with retry + verify push |

### Researcher Agent
- **Trigger**: `#task researcher {topic}.md` in 00_Inbox/
- **Flow**: Read vault baseline → Exa search (3 rounds, confidence-gated) → DeepSeek delta compare → Write insight to 30_Research/Selected/
- **Confidence**: C0-C4 with person-aware + topic-aware + phrase relevance gate
- **Increment logic**: 4-level (无增量/拓展/新发现/轻微增量) — only writes when there's real increment vs vault baseline

### Analyst Agent
- **Trigger**: cron every 30 min
- **Flow**: Read Selected notes (last 3 days) → DeepSeek cross-pattern analysis → Write analyst-{date}-pattern.md
- **Outputs**: Signposts (路标) + Noise (噪音) — honest "no pattern" when ≤2 notes with no signal

### Filter Agent
- **Trigger**: cron every 4 hours
- **Flow**: 6 base interests (weighted) + auto-inferred from vault → Exa parallel search → DeepSeek delta → Write filter-{date}-{period}.md
- **Weights**: AI agent/产品创业/PAI自动化/OKR = 3 (high), 原音/LLM安全 = 2 (medium)

### Following Monitor
- **Trigger**: cron 10:00 + 18:00 CST
- **Data source**: Local launchd script scrapes X.com timeline via CDP proxy → GitHub cache file
- **Tab signals**: Open X tabs signal active interest → engagement threshold drops from 100 to 5
- **Flow**: Read timeline cache → Filter by engagement + tab signals → Dedup by author (max 2) → DeepSeek increment → Write monitor-{date}-{period}.md

## Brief Push (Feishu DM delivery)

Reliable GitHub → Feishu DM bridge with:
- GitHub API retry (5s, max 3)
- Lark verify push (`ok:true` check, max 2 retries)
- `--force` flag for re-pushing last 10 briefs
- Failed commits logged to `~/.cache/orbitos-brief-push/failed-commits.json`

The push ledger keeps the historical `sha -> kind` entries and can also record
artifact metadata (`kind`, `period`, `path`, `commit`, `status`, attempts, and
timestamps) to avoid sending the same brief artifact twice. Both `sent` and
`bootstrapped` artifacts are treated as already handled.

Shadow local mode avoids the GitHub API token by reading the vault checkout with
local Git:

```bash
node orbitos-brief-push.mjs --dry-run --local-repo /Users/shadow/Work/evander-orbitos-vault
node orbitos-brief-push.mjs --bootstrap --local-repo /Users/shadow/Work/evander-orbitos-vault
```

`ORBITOS_VAULT_PATH` can provide the default local repo path. `--dry-run` is
read-only and never calls Lark. `--bootstrap` writes only the local push ledger
with `bootstrapped` status and never sends, so the first cutover can mark
historical Daily Brief and Weekly Synthesis artifacts as handled.

`LARK_CLI_PATH` and `FEISHU_USER_ID` can override config fallback for approved
real sends. Real Lark auth/send and launchd installation require a separately
approved step.

`com.evander.orbitos-brief-push-shadow.plist.template` and
`orbitos-brief-push-launchd.sh` are uninstalled Shadow templates. The plist runs
every 300 seconds through the wrapper with `--dry-run /Users/shadow/Work/evander-orbitos-vault`
and writes logs under `/Users/shadow/Library/Logs`. Production activation is a
separately approved change to the wrapper mode: replace `--dry-run` with explicit
`--send` only after reviewing the dry-run output and Lark recipient setup.

## Result-Led Review Runtime (prepared, not enabled by the repository)

The current product is an evidence-driven execution review, not a knowledge
digest. The primary Mac collects a minimized packet from parent Codex/Claude
sessions plus Feishu Calendar/Minutes. Raw conversations, tool output,
credentials, Feishu IDs, and minute tokens remain outside the vault and Git.
Shadow consumes those packets and active project context to produce:

- `10_Daily/result-daily-YYYY-MM-DD.md` — `超级个体结果日报`
- `10_Daily/result-weekly-WNN-YYYY-MM-DD.md` — `超级个体结果周复盘`

The daily contract requires evidence, 1–3 verifiable outcomes, a real 24-hour
time ledger using the 2.0 planning multiplier, explicit cuts, situational mental
model reminders, one capability prescription, and one minimal confirmation.
The weekly contract compares commitments with delivered results and creates the
next week's result and stop lists. A semantic gate rejects legacy knowledge
headings such as `CONNECTIONS`, `PATTERN`, and `EMERGING THESIS`.

Safe local checks:

```bash
node orbitos-result-evidence.mjs --date 2026-07-29 --host primary --include-feishu --dry-run
node orbitos-synthesis.mjs result-daily --dry-run --date 2026-07-29 --vault /Users/shadow/Work/evander-orbitos-vault
node orbitos-synthesis.mjs result-weekly --dry-run --date 2026-07-29 --vault /Users/shadow/Work/evander-orbitos-vault
```

The prepared schedules are daily at 10:00 Asia/Shanghai and weekly on Sunday at
10:15. The primary evidence collector runs every 15 minutes; the result push
checks every 5 minutes and sends with the bot identity. All templates are
key-free. Live installation is guarded by `ORBITOS_CUTOVER_APPROVED=YES` and is
additionally blocked until the operator confirms the two n8n Cloud Daily/Weekly
workflows are inactive with `ORBITOS_CLOUD_DAILY_WEEKLY_DISABLED=YES`. The exact
cutover is documented in `TOMORROW_RESULT_CUTOVER.md`.

## Legacy Local Synthesis Runtime (retained, disabled)

`orbitos-synthesis.mjs` still supports historical Daily Brief and Weekly Synthesis prompts from a
local vault checkout using the same selected-path strategy as the n8n workflows.
Default mode is dry-run:

```bash
node orbitos-synthesis.mjs daily --dry-run --date 2026-07-29 --vault /Users/shadow/Work/evander-orbitos-vault
node orbitos-synthesis.mjs weekly --dry-run --date 2026-07-29 --vault /Users/shadow/Work/evander-orbitos-vault
```

Dry-run prints a machine-readable JSON summary with `kind`, `period`,
`output_path`, selected file count, prompt character count, model, and
`dry_run:true`. It does not print prompt body, vault file contents, or secrets.

`--apply` is the approval gate. Apply first verifies that the vault is a clean
Git worktree, retries any clean ahead-only push from a previous failed run,
pulls `--ff-only`, rebuilds the prompt, and no-ops if the target artifact already
exists. It then reads `DEEPSEEK_API_KEY` or the macOS Keychain service
`orbitos-deepseek-api-key`, calls the configured DeepSeek-compatible endpoint,
writes exactly one vault path, stages/commits only that path, and records a
non-content ledger in `$XDG_STATE_HOME/orbitos-synthesis/runs.json` or
`~/.local/state/orbitos-synthesis/runs.json`. Do not use `--apply` while the
cloud workflow remains active for the same artifact.

Legacy uninstalled launchd templates are retained as
`com.evander.orbitos-synthesis-daily.plist.template` and
`com.evander.orbitos-synthesis-weekly.plist.template`; both call the wrapper in
`--dry-run` mode and require the system timezone to be `Asia/Shanghai`.

The legacy launchd labels stay disabled during the result-runtime cutover. They
are not automatically re-enabled by rollback because doing so would recreate
duplicate, rejected reports.

## Testing

```bash
# Run all agent tests with coverage
cd /Users/evander/codex/orbitos-automation
node --test --experimental-test-coverage \
  --test-coverage-include='**/*-agent-logic.mjs' \
  --test-coverage-lines=85 \
  tests/

# Run specific agent
node --test tests/researcher-agent-logic.test.mjs
```

All agent tests use:
- DI with mock runners (no real API calls)
- Seeded PRNG (mulberry32) for deterministic fuzz
- 2 rounds of variable-parameter fuzz testing per agent

## Vault Structure

```
00_Inbox/              — Input: #task files, briefs, captures, monitor digests
30_Research/Selected/  — Output: researcher + analyst notes
20_Project/            — Active projects
40_Wiki/               — Atomic concepts
99_System/Workflows/   — n8n workflow JSON exports
```

## Credentials (stored in n8n cloud)

| Credential | Type | Used by |
|-----------|------|---------|
| GitHub PAT | httpHeaderAuth | All workflows |
| DeepSeek Official | httpHeaderAuth | Daily Brief, Weekly Synth |
| Telegram Bot | telegramApi | Telegram Capture |

Agent workflows use inline tokens in Set Vars for Code node API calls that can't use n8n credentials. Friends should replace these with their own values after importing.

> ⚠️ **Friend notice**: The workflow JSON files in `99_System/Workflows/` contain the original author's tokens. Fork → replace all tokens in Set Vars with your own before deploying.
