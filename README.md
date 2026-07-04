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
| `orbitos-brief-push.mjs` | 28 | 89.67% | Feishu DM delivery with retry + verify push |

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

| Credential | n8n ID | Used by |
|-----------|--------|---------|
| GitHub PAT | QEKX1U3jmTLOWz8F | All workflows |
| DeepSeek Official | WAiJ6o2iZ72KnkgB | Daily Brief, Weekly Synth |
| OrbitOS Bot (Telegram) | JcZ8k5MXCyGZtRmD | Telegram Capture |

Agent workflows use inline tokens in Set Vars (GitHub PAT + DeepSeek API key + Exa API key) for Code node API calls that can't use n8n credentials.

## n8n API

```bash
N8N_KEY="<api-key>"
BASE="https://hmzshhy.app.n8n.cloud/api/v1"

# List workflows
curl -s "$BASE/workflows" -H "X-N8N-API-KEY: $N8N_KEY"

# Activate workflow
curl -s -X POST "$BASE/workflows/{id}/activate" -H "X-N8N-API-KEY: $N8N_KEY"

# Create workflow
curl -s -X POST "$BASE/workflows" -H "X-N8N-API-KEY: $N8N_KEY" \
  -H "Content-Type: application/json" -d @workflow.json
```
