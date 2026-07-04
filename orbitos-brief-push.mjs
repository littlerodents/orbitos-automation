#!/usr/bin/env node
// brief-push: detect new chore: daily brief / weekly synthesis commit, push to Feishu DM via lark-cli
//   - skips already-pushed commits (by SHA) unless --force
//   - pulls the brief file content, sends as markdown DM to owner user_id
//   - GitHub API calls retried (5s wait, max 3 attempts); lark send verified via ok:true (max 2 retries)
//   - send failures recorded to failed-commits.json
//   - not a n8n workflow: pure local launchd (independent from any n8n downtime)

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const LARK_CLI = "/Users/evander/.npm-global/bin/lark-cli";
const OWNER_USER_ID = "ou_2d2b140887fb5be28b9dfe6ed130771b";
const STATE_DIR = join(homedir(), ".cache/orbitos-brief-push");
const STATE_FILE = join(STATE_DIR, "pushed-commits.json");
const FAILED_FILE = join(STATE_DIR, "failed-commits.json");
const REPO = "littlerodents/evander-orbitos-vault";

const GH_MAX_ATTEMPTS = 3;
const RETRY_WAIT_MS = 5000;
const SEND_MAX_ATTEMPTS = 3; // 1 initial + 2 retries

const GH = process.env.GH_BIN || "/opt/homebrew/bin/gh";

function sleepSync(ms) {
  try {
    const buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, ms);
  } catch {
    spawnSync("/bin/sleep", [String(Math.max(1, Math.ceil(ms / 1000)))]);
  }
}

// Injectable runners (defaults = real subprocess calls). Tests swap via setGhRunner/setLarkRunner.
let ghRunner = (argv) => execFileSync(GH, argv, { encoding: "utf8" }).trim();
let ghRetryWaitMs = RETRY_WAIT_MS;
let sendRetryWaitMs = RETRY_WAIT_MS;
let larkRunner = (argv) => {
  const r = spawnSync(LARK_CLI, argv, { encoding: "utf8", env: {
    ...process.env,
    PATH: `/usr/local/bin:/opt/homebrew/bin:/Users/evander/.npm-global/bin:${process.env.PATH || "/usr/bin:/bin"}`,
    LARK_CLI_NO_PROXY: "1",
  }});
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
export function setGhRunner(fn) { ghRunner = fn; }
export function setLarkRunner(fn) { larkRunner = fn; }
export function setRetryWait(ms) { ghRetryWaitMs = ms; sendRetryWaitMs = ms; }
export function resetRunners() {
  ghRunner = (argv) => execFileSync(GH, argv, { encoding: "utf8" }).trim();
  ghRetryWaitMs = RETRY_WAIT_MS;
  sendRetryWaitMs = RETRY_WAIT_MS;
  larkRunner = (argv) => {
    const r = spawnSync(LARK_CLI, argv, { encoding: "utf8", env: {
      ...process.env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:/Users/evander/.npm-global/bin:${process.env.PATH || "/usr/bin:/bin"}`,
      LARK_CLI_NO_PROXY: "1",
    }});
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
}

function gh(...argv) { return ghRunner(argv); }
export function ghWithRetry(...argv) {
  let lastErr;
  for (let attempt = 1; attempt <= GH_MAX_ATTEMPTS; attempt++) {
    try {
      return gh(...argv);
    } catch (e) {
      lastErr = e;
      if (attempt < GH_MAX_ATTEMPTS) sleepSync(ghRetryWaitMs);
    }
  }
  throw lastErr;
}

function larkcliRaw(...argv) { return larkRunner(argv); }

// returns { ok: true, data } on verified delivery, or { ok: false, error }
export function sendBrief(markdown, attempts = SEND_MAX_ATTEMPTS, waitMs = sendRetryWaitMs) {
  let lastErr = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { status, stdout, stderr } = larkcliRaw(
      "im", "+messages-send", "--as", "user", "--user-id", OWNER_USER_ID, "--markdown", markdown);
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* non-JSON stdout */ }
    const ok = parsed && parsed.ok === true;
    if (status === 0 && ok) return { ok: true, data: parsed && parsed.data };
    lastErr = `attempt ${attempt}: exit=${status} ok=${parsed ? parsed.ok : "n/a"} ${(stderr || stdout || "").trim()}`;
    if (attempt < attempts) sleepSync(waitMs);
  }
  return { ok: false, error: lastErr };
}

function ensureState(stateDir = STATE_DIR, stateFile = STATE_FILE) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  if (!existsSync(stateFile)) writeFileSync(stateFile, "{}");
}
export function loadPushed(stateFile = STATE_FILE) {
  ensureState(join(stateFile, ".."), stateFile);
  return JSON.parse(readFileSync(stateFile, "utf8"));
}
export function markPushed(sha, kind, stateFile = STATE_FILE) {
  const m = loadPushed(stateFile);
  m[sha] = kind;
  writeFileSync(stateFile, JSON.stringify(m, null, 2));
}
export function appendFailed(sha, kind, error, failedFile = FAILED_FILE) {
  const dir = join(failedFile, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let arr = [];
  if (existsSync(failedFile)) {
    try {
      const parsed = JSON.parse(readFileSync(failedFile, "utf8"));
      arr = Array.isArray(parsed) ? parsed : [];
    } catch { arr = []; }
  }
  arr.push({ sha, kind, error, failed_at: new Date().toISOString() });
  writeFileSync(failedFile, JSON.stringify(arr, null, 2));
}

export function parseArgs(argv = process.argv.slice(2)) {
  const set = new Set(argv);
  return {
    dryRun: set.has("--dry-run"),
    force: set.has("--force"),
  };
}

// Fetch brief content for a candidate commit via GitHub contents API.
// Returns { content, inferredPath } or { content: null } on fetch failure.
export function fetchBriefContent(c, repo = REPO) {
  const filePath = c.kind === "daily brief"
    ? `00_Inbox/brief-${c.date.slice(0, 10)}.md`
    : `10_Daily/weekly-W${c.date.slice(0, 10)}/`.slice(0, -1);
  let content = null;
  let inferredPath = filePath;
  if (c.kind === "daily brief") {
    try {
      const b64 = ghWithRetry("api", `repos/${repo}/contents/${inferredPath}?ref=${c.sha}`, "--jq", ".content");
      content = Buffer.from(b64, "base64").toString("utf8");
    } catch (e) { /* fall through */ }
  } else {
    try {
      const tree = ghWithRetry("api", `repos/${repo}/git/trees/${c.sha}?recursive=1`, "--jq",
        '.tree | map(select(.path | startswith("10_Daily/weekly-"))) | .[].path');
      const wpath = tree.split("\n").find(Boolean);
      if (wpath) {
        inferredPath = wpath;
        const b64 = ghWithRetry("api", `repos/${repo}/contents/${inferredPath}?ref=${c.sha}`, "--jq", ".content");
        content = Buffer.from(b64, "base64").toString("utf8");
      }
    } catch (e) { /* fall through */ }
  }
  return { content, inferredPath };
}

// Process one candidate: fetch + (dry-run | send + record). Returns { pushed, failed, dry }.
export function processCandidate(c, opts) {
  const { dryRun, force, pushed, stateFile = STATE_FILE, failedFile = FAILED_FILE, sendAttempts, sendWaitMs } = opts;
  if (!force && pushed[c.sha] === c.kind) return { pushed: false, failed: false, dry: false, skipped: true };
  const { content } = fetchBriefContent(c);
  if (!content) {
    console.error(`skip ${c.sha}: no content fetchable`);
    return { pushed: false, failed: false, dry: false, skipped: true, noContent: true };
  }
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  if (dryRun) {
    console.log(`DRY: would push ${c.kind} @ ${c.sha.slice(0, 7)} (${body.length} chars)`);
    return { pushed: false, failed: false, dry: true };
  }
  const title = c.kind === "daily brief" ? "## Brief" : "## Weekly Synthesis";
  const md = `${title} — ${c.date.slice(0, 10)}\n\n${body}`;
  const result = sendBrief(md, sendAttempts, sendWaitMs);
  if (result.ok) {
    markPushed(c.sha, c.kind, stateFile);
    console.log(`pushed ${c.kind} @ ${c.sha.slice(0, 7)} (${body.length} chars)`);
    return { pushed: true, failed: false, dry: false };
  }
  appendFailed(c.sha, c.kind, result.error, failedFile);
  console.error(`FAILED ${c.kind} @ ${c.sha.slice(0, 7)}: ${result.error}`);
  return { pushed: false, failed: true, dry: false, error: result.error };
}

// Testable pipeline: no process.exit inside. Returns { code, fatal?, nothing?, results? }.
// opts: { argv, ghRunner, larkRunner, retryWait, stateFile, failedFile }
export async function runPipeline(opts = {}) {
  const { dryRun, force } = parseArgs(opts.argv);
  if (opts.ghRunner) setGhRunner(opts.ghRunner);
  if (opts.larkRunner) setLarkRunner(opts.larkRunner);
  if (opts.retryWait) setRetryWait(opts.retryWait);
  const stateFile = opts.stateFile ?? STATE_FILE;
  const failedFile = opts.failedFile ?? FAILED_FILE;
  let raw;
  try {
    raw = ghWithRetry("api", `repos/${REPO}/commits?per_page=10`, "--jq",
      '.[] | select(.commit.message | test("^chore: (daily brief|weekly synthesis) ")) | {sha: .sha, kind: (.commit.message | capture("^chore: (?<kind>daily brief|weekly synthesis)").kind), msg: .commit.message, date: .commit.author.date}');
  } catch (e) {
    return { code: 1, fatal: e.message };
  }
  if (!raw) return { code: 0, nothing: true, dryRun };
  const pushed = loadPushed(stateFile);
  const candidates = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line)).reverse();
  const results = [];
  for (const c of candidates) {
    results.push(processCandidate(c, { dryRun, force, pushed, stateFile, failedFile, sendAttempts: SEND_MAX_ATTEMPTS, sendWaitMs: sendRetryWaitMs }));
  }
  return { code: 0, results };
}

async function main() {
  const r = await runPipeline();
  if (r.code === 1) {
    console.error(`FATAL: github commits listing failed after ${GH_MAX_ATTEMPTS} attempts: ${r.fatal}`);
    process.exit(1);
  }
  if (r.nothing && !r.dryRun) console.log("nothing to push");
  process.exit(0);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(thisFile)) {
  main();
}

export {
  GH_MAX_ATTEMPTS,
  SEND_MAX_ATTEMPTS,
  RETRY_WAIT_MS,
  REPO,
  OWNER_USER_ID,
  STATE_DIR,
  STATE_FILE,
  FAILED_FILE,
  ghWithRetry as gh,
  sleepSync,
  main,
};
