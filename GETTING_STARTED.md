# Getting Started

## Prerequisites

- **Node.js 22+** (for agent logic + tests)
- **gh CLI** (GitHub API access, authenticated)
- **n8n cloud account** (workflow deployment)
- **Optional**: lark-cli (Feishu DM), Chrome + CDP proxy (X timeline monitoring)

## Setup (5 steps)

### 1. Fork & Clone

```bash
git clone https://github.com/littlerodents/orbitos-automation.git
cd orbitos-automation
```

### 2. Configure

```bash
# The first run creates a default config at:
# ~/.config/orbitos-automation/config.json
node -e "import('./lib/config.mjs').then(m => m.loadConfig())"
```

Edit `~/.config/orbitos-automation/config.json` with your values:

```json
{
  "vault_path": "/path/to/your/Obsidian/OrbitOS",
  "lark_cli_path": "/path/to/lark-cli",
  "feishu_user_id": "your_open_id",
  "github_owner": "your-github-username",
  "github_repo": "your-vault-repo",
  "github_branch": "main"
}
```

### 3. Test

```bash
# Run all agent tests with coverage
node --test --experimental-test-coverage \
  --test-coverage-include='**/*-agent-logic.mjs' \
  --test-coverage-lines=85 \
  tests/

# Or run individual agents
node --test tests/researcher-agent-logic.test.mjs
node --test tests/analyst-agent-logic.test.mjs
node --test tests/filter-agent-logic.test.mjs
node --test tests/monitor-agent-logic.test.mjs
node --test tests/orbitos-brief-push.test.mjs
```

All tests use DI with mock runners — no real API calls needed.

### 4. Deploy to n8n Cloud

```bash
# Set your n8n API key
export N8N_API_KEY="your-n8n-api-key"

# Deploy all workflows
for wf in ~/Obsidian/OrbitOS/99_System/Workflows/cloud_*.json; do
  # Create workflow
  curl -s -X POST "https://YOUR-INSTANCE.app.n8n.cloud/api/v1/workflows" \
    -H "X-N8N-API-KEY: $N8N_API_KEY" \
    -H "Content-Type: application/json" \
    -d @$wf
done
```

Then activate each workflow in the n8n UI or via API:
```bash
curl -s -X POST "https://YOUR-INSTANCE.app.n8n.cloud/api/v1/workflows/{id}/activate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY"
```

### 5. Verify

```bash
# Test brief-push (dry run, no actual Feishu DM)
node orbitos-brief-push.mjs --dry-run

# Shadow local brief-push dry run (local Git, no GitHub API token, no state write)
node orbitos-brief-push.mjs --dry-run --local-repo /Users/shadow/Work/evander-orbitos-vault

# One-time cutover ledger bootstrap (no Feishu send)
node orbitos-brief-push.mjs --bootstrap --local-repo /Users/shadow/Work/evander-orbitos-vault

# Test local synthesis prompt assembly (dry run, no LLM, no vault writes, no git)
node orbitos-synthesis.mjs daily --dry-run --date 2026-07-29 --vault /Users/shadow/Work/evander-orbitos-vault
node orbitos-synthesis.mjs weekly --dry-run --date 2026-07-29 --vault /Users/shadow/Work/evander-orbitos-vault

# Test timeline fetcher (requires Chrome + CDP proxy)
node monitor-timeline-fetcher.mjs

# Write a test researcher task to your vault's 00_Inbox/
echo '# test topic' > ~/Obsidian/OrbitOS/00_Inbox/'#task researcher test topic.md'
# Push to GitHub, wait 10 min, check 30_Research/Selected/
```

## Architecture Overview

All agent logic modules use **dependency injection (DI)**:
- External calls (GitHub API, Exa search, DeepSeek LLM) go through injectable runner functions
- Tests inject mock runners (no real API calls, no network)
- n8n Code nodes inject real `this.helpers.httpRequest` implementations
- This enables 100% test coverage and friend-friendly forkability

```
config.json (your values)
       ↓
lib/config.mjs (loader)
       ↓
*-agent-logic.mjs (DI modules, 100% tested)
       ↓                    ↓
tests/*.test.mjs        n8n workflow JSON
(mock runners)          (real httpRequest)
```

## Agent Quick Reference

| Agent | Trigger | What it does |
|-------|---------|-------------|
| Researcher | `#task researcher {topic}.md` in inbox | Deep search + increment judgment → Selected note |
| Analyst | cron 30min | Cross-note pattern analysis → signposts + noise |
| Filter | cron 4h | 6 interest clusters, parallel search → digest |
| Following Monitor | cron 2x/day | X timeline engagement filter + tab signals |

## Troubleshooting

- **`config.json not found`**: Run any script once, it auto-creates the default. Edit with your values.
- **Tests fail with `not configured`**: Tests inject their own mocks, they don't need config.json. Make sure you're running from the repo root.
- **n8n workflow 401**: Check that Set Vars has correct GitHub token + DeepSeek key.
- **CDP proxy timeout**: Make sure Chrome is running with the extension, and X.com tab is open.

## Local Synthesis Approval Gate

`orbitos-synthesis.mjs` defaults to `--dry-run`; without explicit `--apply` it
does not call DeepSeek, write the vault, commit, push, or send Feishu. Approve
`--apply` only after confirming the matching n8n cloud workflow will not produce
the same Daily or Weekly artifact.

The included launchd plists are templates only. They are not installed, loaded,
or enabled by this repository. The templates run dry-runs and use a wrapper that
skips unless the macOS system timezone is `Asia/Shanghai`.

Rollback: delete the local synthesis files or revert this repo change. For any
separately approved apply run, revert the generated artifact and commit in the
vault repository.

## Local Brief Push Cutover

`orbitos-brief-push.mjs --local-repo PATH` reads recent Daily Brief and Weekly
Synthesis commits from local Git, fetches the exact committed markdown artifact
with `git show`, validates it, and prepares Feishu delivery without needing a
GitHub API token. `ORBITOS_VAULT_PATH` can provide the default local repo path.

Use `--dry-run` first; it is read-only and does not write state or call Lark.
Use `--bootstrap` once only after review to mark discovered historical artifacts
as `bootstrapped`; bootstrap never sends and is idempotent.

The Shadow launchd plist is a template only and explicitly runs the wrapper in
`--dry-run` mode against `/Users/shadow/Work/evander-orbitos-vault`. Production
activation requires a separately approved change from `--dry-run` to explicit
`--send`, after reviewing dry-run output and Lark recipient setup. Real Lark
authentication/sending and installing/loading any launchd job require a
separately approved step.
