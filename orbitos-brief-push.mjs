#!/usr/bin/env node
// brief-push: detect new chore: daily brief / weekly synthesis commit, push to Feishu DM via lark-cli
//   - skips already-pushed commits (by SHA) unless --force
//   - pulls the brief file content, sends as markdown DM to owner user_id
//   - GitHub API calls via curl (--retry 3 retries transient TLS/5xx/429; 4xx fails fast); lark send verified via ok:true (max 2 retries)
//   - send failures recorded to failed-commits.json; pipeline failures recorded to failed-runs.json + exit 0 (launchd retries next round)
//   - not a n8n workflow: pure local launchd (independent from any n8n downtime)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { loadConfig } from "./lib/config.mjs";

const _cfg = loadConfig();
const LARK_CLI = _cfg.lark_cli_path;
const OWNER_USER_ID = _cfg.feishu_user_id;
const STATE_DIR = join(homedir(), ".cache/orbitos-brief-push");
const STATE_FILE = join(STATE_DIR, "pushed-commits.json");
const FAILED_FILE = join(STATE_DIR, "failed-commits.json");
const FAILED_RUNS_FILE = join(STATE_DIR, "failed-runs.json");
const REPO = _cfg.github_owner + "/" + _cfg.github_repo;

const RETRY_WAIT_MS = 5000;
const SEND_MAX_ATTEMPTS = 3; // 1 initial + 2 retries

const CURL_BIN = process.env.CURL_BIN || "/usr/bin/curl";

function sleepSync(ms) {
  try {
    const buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, ms);
  } catch {
    spawnSync("/bin/sleep", [String(Math.max(1, Math.ceil(ms / 1000)))]);
  }
}

// Default curl runner: real curl subprocess with retry + auth. Response parsing delegated to parseGithubResponse.
function defaultCurlRunner(urlPath) {
  const token = process.env.GITHUB_TOKEN || _cfg.github_token;
  if (!token) throw new Error("GITHUB_TOKEN not set (env or config.json github_token field)");
  const result = spawnSync(CURL_BIN, [
    "-s",
    "--retry", "3",
    "--retry-delay", "5",
    "--connect-timeout", "10",
    "--max-time", "30",
    "-H", `Authorization: Bearer ${token}`,
    "-H", "Accept: application/vnd.github+json",
    `https://api.github.com${urlPath}`,
  ], { encoding: "utf8" });
  return parseGithubResponse(result.stdout, result.stderr, result.status);
}

// Parse curl response: throws on non-zero exit, non-JSON, or GitHub API error shape. Returns parsed JSON otherwise.
export function parseGithubResponse(stdout, stderr, exitStatus) {
  if (exitStatus !== 0) {
    throw new Error(`curl failed (exit ${exitStatus}): ${stderr || "no stderr"}`);
  }
  let parsed;
  try {
    if (!stdout) throw new Error(`github api empty body (curl exit ${exitStatus})${stderr ? ': ' + stderr.slice(0, 200) : ''}`);
    parsed = JSON.parse(stdout);
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`github api non-json${stderr ? ' (stderr: ' + stderr.slice(0, 100) + ')' : ''}: ${(stdout || '<empty>').slice(0, 200)}`);
    }
    throw e;
  }
  // GitHub API error response shape: { message, documentation_url, status? }
  if (parsed && typeof parsed === "object" && parsed.message && parsed.documentation_url) {
    throw new Error(`github api error: ${parsed.message} (${parsed.status || "???"})`);
  }
  return parsed;
}

// Default lark runner: real lark-cli subprocess with PATH + no-proxy env.
function defaultLarkRunner(argv) {
  const r = spawnSync(LARK_CLI, argv, { encoding: "utf8", env: {
    ...process.env,
    PATH: `/usr/local/bin:/opt/homebrew/bin:${join(homedir(), ".npm-global", "bin")}:${process.env.PATH || "/usr/bin:/bin"}`,
    LARK_CLI_NO_PROXY: "1",
  }});
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Injectable runners (defaults = real subprocess calls). Tests swap via setCurlRunner/setLarkRunner.
let curlRunner = defaultCurlRunner;
let sendRetryWaitMs = RETRY_WAIT_MS;
let larkRunner = defaultLarkRunner;
export function setCurlRunner(fn) { curlRunner = fn; }
export function setLarkRunner(fn) { larkRunner = fn; }
export function setRetryWait(ms) { sendRetryWaitMs = ms; }
export function resetRunners() {
  curlRunner = defaultCurlRunner;
  sendRetryWaitMs = RETRY_WAIT_MS;
  larkRunner = defaultLarkRunner;
}

export function curlGithub(urlPath) {
  return curlRunner(urlPath);
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
function appendJsonArray(file, entry) {
  const dir = join(file, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let arr = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      arr = Array.isArray(parsed) ? parsed : [];
    } catch { arr = []; }
  }
  arr.push(entry);
  writeFileSync(file, JSON.stringify(arr, null, 2));
}
export function appendFailed(sha, kind, error, failedFile = FAILED_FILE) {
  appendJsonArray(failedFile, { sha, kind, error, failed_at: new Date().toISOString() });
}
export function appendFailedRun(error, failedRunsFile = FAILED_RUNS_FILE) {
  appendJsonArray(failedRunsFile, { error: error.message, failed_at: new Date().toISOString() });
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
      const data = curlGithub(`/repos/${repo}/contents/${encodeURIComponent(inferredPath)}?ref=${c.sha}`);
      if (typeof data.content === 'string') {
        content = Buffer.from(data.content, "base64").toString("utf8");
      }
    } catch (e) { /* fall through */ }
  } else {
    try {
      const treeData = curlGithub(`/repos/${repo}/git/trees/${c.sha}?recursive=1`);
      const wpath = (treeData.tree || [])
        .map((t) => t.path)
        .find((p) => p.startsWith("10_Daily/weekly-"));
      if (wpath) {
        inferredPath = wpath;
        const data = curlGithub(`/repos/${repo}/contents/${encodeURIComponent(inferredPath)}?ref=${c.sha}`);
        if (typeof data.content === 'string') {
          content = Buffer.from(data.content, "base64").toString("utf8");
        }
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
  if (content == null) {
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

// Testable pipeline: no process.exit inside. Returns { code, nothing?, results? }. Throws on listing failure.
// opts: { argv, curlRunner, larkRunner, retryWait, stateFile, failedFile }
export async function runPipeline(opts = {}) {
  const { dryRun, force } = parseArgs(opts.argv);
  if (opts.curlRunner) setCurlRunner(opts.curlRunner);
  if (opts.larkRunner) setLarkRunner(opts.larkRunner);
  if (opts.retryWait) setRetryWait(opts.retryWait);
  const stateFile = opts.stateFile ?? STATE_FILE;
  const failedFile = opts.failedFile ?? FAILED_FILE;
  const commits = curlGithub(`/repos/${REPO}/commits?per_page=10`);
  const candidates = (Array.isArray(commits) ? commits : [])
    .filter((c) => /^chore: (daily brief|weekly synthesis) /.test(c.commit?.message || ""))
    .map((c) => {
      const msg = c.commit.message;
      const kindMatch = msg.match(/(daily brief|weekly synthesis)/);
      const dateMatch = msg.match(/(\d{4}-\d{2}-\d{2})/);
      return {
        sha: c.sha,
        kind: kindMatch[1],
        msg,
        date: dateMatch ? dateMatch[1] : (c.commit.author?.date || "").slice(0, 10),
      };
    })
    .reverse();
  if (candidates.length === 0) return { code: 0, nothing: true, dryRun };
  const pushed = loadPushed(stateFile);
  const results = [];
  for (const c of candidates) {
    results.push(processCandidate(c, { dryRun, force, pushed, stateFile, failedFile, sendAttempts: SEND_MAX_ATTEMPTS, sendWaitMs: sendRetryWaitMs }));
  }
  return { code: 0, results };
}

// Testable main: catches pipeline errors, logs to failed-runs.json, returns testable shape. No process.exit inside.
// opts: { argv, curlRunner, larkRunner, retryWait, stateFile, failedFile, failedRunsFile }
export async function runMain(opts = {}) {
  const failedRunsFile = opts.failedRunsFile ?? FAILED_RUNS_FILE;
  try {
    const r = await runPipeline(opts);
    if (r.nothing && !r.dryRun) console.log("nothing to push");
    return r;
  } catch (error) {
    let logged = false;
    try {
      appendFailedRun(error, failedRunsFile);
      logged = true;
    } catch (logErr) {
      console.error(`failed to log to failed-runs.json: ${logErr.message}`);
    }
    console.error(`logged failure (exit 0 for launchd): ${error.message}`);
    return { code: 0, logged, error: error.message };
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(thisFile)) {
  runMain().then(() => { process.exitCode = 0; });
}

export {
  RETRY_WAIT_MS,
  SEND_MAX_ATTEMPTS,
  REPO,
  OWNER_USER_ID,
  STATE_DIR,
  STATE_FILE,
  FAILED_FILE,
  FAILED_RUNS_FILE,
  sleepSync,
};
