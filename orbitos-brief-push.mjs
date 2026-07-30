#!/usr/bin/env node
// Detect supported OrbitOS report commits and push exactly once to Feishu DM via lark-cli.
//   - skips already-pushed commits (by SHA) unless --force
//   - pulls the brief file content, sends as markdown DM to owner user_id
//   - GitHub API calls via curl (--retry 3 retries transient TLS/5xx/429; 4xx fails fast); lark send verified via ok:true (max 2 retries)
//   - send failures recorded to failed-commits.json; pipeline failures recorded to failed-runs.json + exit 0 (launchd retries next round)
//   - not a n8n workflow: pure local launchd (independent from any n8n downtime)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { loadConfig } from "./lib/config.mjs";

const _cfg = loadConfig();
const LARK_CLI = process.env.LARK_CLI_PATH || _cfg.lark_cli_path;
const OWNER_USER_ID = process.env.FEISHU_USER_ID || _cfg.feishu_user_id;
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
  if (!LARK_CLI || !String(LARK_CLI).trim()) {
    throw new Error("lark cli path is required before send");
  }
  if (!OWNER_USER_ID || !String(OWNER_USER_ID).trim()) {
    throw new Error("lark recipient id is required before send");
  }
  const r = spawnSync(LARK_CLI, argv, { encoding: "utf8", env: {
    ...process.env,
    PATH: `/usr/local/bin:/opt/homebrew/bin:${join(homedir(), ".npm-global", "bin")}:${process.env.PATH || "/usr/bin:/bin"}`,
    LARK_CLI_NO_PROXY: "1",
  }});
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function defaultGitRunner(repoPath, argv) {
  const r = spawnSync("/usr/bin/git", ["-C", repoPath, ...argv], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r.stdout;
}

// Injectable runners (defaults = real subprocess calls). Tests swap via setCurlRunner/setLarkRunner.
let curlRunner = defaultCurlRunner;
let sendRetryWaitMs = RETRY_WAIT_MS;
let larkRunner = defaultLarkRunner;
let gitRunner = defaultGitRunner;
export function setCurlRunner(fn) { curlRunner = fn; }
export function setLarkRunner(fn) { larkRunner = fn; }
export function setGitRunner(fn) { gitRunner = fn; }
export function setRetryWait(ms) { sendRetryWaitMs = ms; }
export function resetRunners() {
  curlRunner = defaultCurlRunner;
  sendRetryWaitMs = RETRY_WAIT_MS;
  larkRunner = defaultLarkRunner;
  gitRunner = defaultGitRunner;
}

export function curlGithub(urlPath) {
  return curlRunner(urlPath);
}

function larkcliRaw(...argv) { return larkRunner(argv); }

// returns { ok: true, data } on verified delivery, or { ok: false, error }
export function sanitizeErrorText(value) {
  return String(value ?? "")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1[REDACTED]@")
    .replace(/\bou_[A-Za-z0-9_-]+\b/g, "[REDACTED_FEISHU_OPEN_ID]");
}

export function sendBrief(markdown, attempts = SEND_MAX_ATTEMPTS, waitMs = sendRetryWaitMs, idempotencyKey = "") {
  let lastErr = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const argv = ["im", "+messages-send", "--as", "bot", "--user-id", OWNER_USER_ID, "--markdown", markdown];
    if (idempotencyKey) argv.push("--idempotency-key", idempotencyKey);
    let status, stdout, stderr;
    try {
      ({ status, stdout, stderr } = larkcliRaw(...argv));
    } catch (e) {
      lastErr = `attempt ${attempt}: ${sanitizeErrorText(e.message)}`;
      if (attempt < attempts) sleepSync(waitMs);
      continue;
    }
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* non-JSON stdout */ }
    const ok = parsed && parsed.ok === true;
    if (status === 0 && ok) return { ok: true, data: parsed && parsed.data, attempts: attempt };
    lastErr = sanitizeErrorText(`attempt ${attempt}: exit=${status} ok=${parsed ? parsed.ok : "n/a"} ${(stderr || stdout || "").trim()}`);
    if (attempt < attempts) sleepSync(waitMs);
  }
  return { ok: false, error: lastErr, attempts };
}

function ensureState(stateDir = STATE_DIR, stateFile = STATE_FILE) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  if (!existsSync(stateFile)) writeFileSync(stateFile, "{}");
}
export function loadPushed(stateFile = STATE_FILE) {
  ensureState(dirname(stateFile), stateFile);
  return JSON.parse(readFileSync(stateFile, "utf8"));
}
export function readPushed(stateFile = STATE_FILE) {
  if (!existsSync(stateFile)) return {};
  return JSON.parse(readFileSync(stateFile, "utf8"));
}
function artifactKey(kind, period, artifactPath) {
  return `${kind}|${period || ""}|${artifactPath || ""}`;
}
export function hasPushedArtifact(pushed, kind, period, artifactPath) {
  const artifacts = pushed?.__artifacts;
  if (!artifacts || typeof artifacts !== "object") return false;
  const status = artifacts[artifactKey(kind, period, artifactPath)]?.status;
  return status === "sent" || status === "bootstrapped";
}
export function markPushed(sha, kind, stateFile = STATE_FILE, meta = null) {
  const m = loadPushed(stateFile);
  m[sha] = kind;
  if (meta?.period && meta?.path) {
    m.__artifacts = m.__artifacts && typeof m.__artifacts === "object" ? m.__artifacts : {};
    const key = artifactKey(kind, meta.period, meta.path);
    const prev = m.__artifacts[key] || {};
    const preserveSent = prev.status === "sent" && meta.status === "bootstrapped";
    m.__artifacts[key] = {
      kind,
      period: meta.period,
      path: meta.path,
      commit: preserveSent ? prev.commit || meta.commit || sha : meta.commit || sha,
      status: preserveSent ? "sent" : meta.status || prev.status || "sent",
      attempts: preserveSent ? prev.attempts || 1 : Number.isInteger(meta.attempts) ? meta.attempts : prev.attempts || 1,
      first_pushed_at: prev.first_pushed_at || new Date().toISOString(),
      last_pushed_at: preserveSent ? prev.last_pushed_at || new Date().toISOString() : new Date().toISOString(),
    };
  }
  writeFileSync(stateFile, JSON.stringify(m, null, 2));
}
function appendJsonArray(file, entry) {
  const dir = dirname(file);
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
  appendJsonArray(failedFile, { sha, kind, error: sanitizeErrorText(error), failed_at: new Date().toISOString() });
}
export function appendFailedRun(error, failedRunsFile = FAILED_RUNS_FILE) {
  appendJsonArray(failedRunsFile, { error: sanitizeErrorText(error.message), failed_at: new Date().toISOString() });
}

export function parseArgs(argv = process.argv.slice(2)) {
  const valueAfter = (flag) => {
    const i = argv.indexOf(flag);
    if (i < 0) return "";
    if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
      throw new Error(`${flag} requires a following path`);
    }
    return argv[i + 1];
  };
  const set = new Set(argv);
  const localRepo = valueAfter("--local-repo") || process.env.ORBITOS_VAULT_PATH || "";
  if (set.has("--bootstrap") && !localRepo) {
    throw new Error("--bootstrap requires local mode via --local-repo or ORBITOS_VAULT_PATH");
  }
  if (set.has("--dry-run") && set.has("--bootstrap")) {
    throw new Error("--dry-run and --bootstrap are mutually exclusive");
  }
  return {
    dryRun: set.has("--dry-run"),
    force: set.has("--force"),
    bootstrap: set.has("--bootstrap"),
    localRepo,
  };
}

export function parseBriefCommitLine(line) {
  const nul = line.indexOf("\0");
  if (nul < 1) return null;
  const sha = line.slice(0, nul);
  const msg = line.slice(nul + 1);
  let m = msg.match(/^chore: daily brief (\d{4}-\d{2}-\d{2})$/);
  if (m) {
    return {
      sha,
      kind: "daily brief",
      msg,
      artifactPath: `00_Inbox/brief-${m[1]}.md`,
    };
  }
  m = msg.match(/^chore: weekly synthesis W(\d{1,2}) (\d{4}-\d{2}-\d{2})$/);
  if (m) {
    const week = Number(m[1]);
    if (!Number.isInteger(week) || week < 1 || week > 53) return null;
    const paddedWeek = String(week).padStart(2, "0");
    return {
      sha,
      kind: "weekly synthesis",
      msg,
      artifactPath: `10_Daily/weekly-W${paddedWeek}-${m[2]}.md`,
    };
  }
  m = msg.match(/^chore: result daily (\d{4}-\d{2}-\d{2})$/);
  if (m) {
    return {
      sha,
      kind: "result daily",
      msg,
      artifactPath: `10_Daily/result-daily-${m[1]}.md`,
    };
  }
  m = msg.match(/^chore: result weekly W(\d{1,2}) (\d{4}-\d{2}-\d{2})$/);
  if (m) {
    const week = Number(m[1]);
    if (!Number.isInteger(week) || week < 1 || week > 53) return null;
    const paddedWeek = String(week).padStart(2, "0");
    return {
      sha,
      kind: "result weekly",
      msg,
      artifactPath: `10_Daily/result-weekly-W${paddedWeek}-${m[2]}.md`,
    };
  }
  return null;
}

export function parseGithubCommit(c) {
  const msg = c.commit?.message || "";
  const subject = msg.split("\n")[0];
  const line = `${c.sha}\0${subject}`;
  const parsed = parseBriefCommitLine(line);
  if (parsed) return parsed;
  const legacy = subject.match(/^chore: weekly synthesis (\d{4}-\d{2}-\d{2})$/);
  if (!legacy) return null;
  return {
    sha: c.sha,
    kind: "weekly synthesis",
    msg: subject,
    date: legacy[1],
  };
}

export function listLocalCandidates(localRepo) {
  const out = gitRunner(localRepo, ["log", "-20", "--format=%H%x00%s"]);
  return out.split("\n").filter(Boolean).map(parseBriefCommitLine).filter(Boolean).reverse();
}

export function deriveArtifactMeta(kind, artifactPath) {
  let m = artifactPath.match(/^00_Inbox\/brief-(\d{4}-\d{2}-\d{2})\.md$/);
  if (kind === "daily brief" && m) return { kind, period: m[1], path: artifactPath };
  m = artifactPath.match(/^10_Daily\/weekly-(W\d{2}-\d{4}-\d{2}-\d{2})\.md$/);
  if (kind === "weekly synthesis" && m) return { kind, period: m[1], path: artifactPath };
  m = artifactPath.match(/^10_Daily\/result-daily-(\d{4}-\d{2}-\d{2})\.md$/);
  if (kind === "result daily" && m) return { kind, period: m[1], path: artifactPath };
  m = artifactPath.match(/^10_Daily\/result-weekly-(W\d{2}-\d{4}-\d{2}-\d{2})\.md$/);
  if (kind === "result weekly" && m) return { kind, period: m[1], path: artifactPath };
  throw new Error(`invalid artifact path for ${kind}`);
}

export function larkIdempotencyKey(kind, period, artifactPath) {
  const hash = createHash("sha256").update(`${kind}\0${period}\0${artifactPath}`).digest("hex");
  return `brief-${hash.slice(0, 44)}`;
}

export function stripBriefBody(content) {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/^# .*(?:\r?\n|$)/, "")
    .trim();
}

const RESULT_PUSH_SECTIONS = {
  "result daily": [
    "## 1. 证据与最新事实",
    "## 2. 今天结束时必须留下的结果",
    "## 3. 取舍与 24 小时时间账本",
    "## 4. 思维模型强提醒",
    "## 5. 其余相关模型",
    "## 6. 能力与 Agent Team",
    "## 7. 最小确认",
  ],
  "result weekly": [
    "## 1. 本周证据与结果",
    "## 2. 承诺与交付差距",
    "## 3. 时间投向与取舍",
    "## 4. 重复瓶颈与思维模型",
    "## 5. 下周必须留下的结果",
    "## 6. 停止清单与能力处方",
    "## 7. 最小确认",
  ],
};

export function validateArtifactContent(content, kind = "") {
  if (/^#{1,6}\s+(?:ERROR|RAW REASONING)\b.*$/im.test(content)) {
    return { ok: false, error: "artifact contains forbidden heading" };
  }
  const body = stripBriefBody(content);
  if (body.length < 300) {
    return { ok: false, error: `artifact body too short (${body.length} chars)`, body };
  }
  const required = RESULT_PUSH_SECTIONS[kind];
  if (required) {
    if (/(^|\n)\s*#{1,6}\s*(?:CONNECTIONS|PATTERN|QUESTION|BASE REMINDER|EMERGING THESIS|CONTRADICTIONS|KNOWLEDGE GAPS?)\b/i.test(body)) {
      return { ok: false, error: "artifact contains legacy knowledge heading", body };
    }
    for (const section of required) {
      if (!body.includes(section)) return { ok: false, error: `artifact missing required section: ${section}`, body };
    }
    const outcomeIndex = kind === "result daily" ? 1 : 4;
    const outcomeSection = body.slice(
      body.indexOf(required[outcomeIndex]) + required[outcomeIndex].length,
      body.indexOf(required[outcomeIndex + 1]),
    );
    const outcomeCount = outcomeSection.split("\n").filter((line) => {
      const trimmed = line.trim();
      return /^\d{1,2}[.、)）]\s*/.test(trimmed)
        || /^#{3,4}\s*(?:结果|Outcome)\s*[一二三123]?/i.test(trimmed)
        || /^-\s+\*\*(?:结果|Outcome)\s*[:：]?/i.test(trimmed)
        || /^\*\*(?:结果|Outcome)\s*[一二三123]?\s*[:：]?/i.test(trimmed);
    }).length;
    if (outcomeCount < 1 || outcomeCount > 3) {
      return { ok: false, error: "artifact must contain between 1 and 3 outcomes", body };
    }
    if (kind === "result daily" && /(?:结果日报.{0,12}(?:生成|发送|发出|推送)|(?:生成|发送|发出|推送).{0,12}结果日报)/i.test(outcomeSection)) {
      return { ok: false, error: "artifact contains self-referential report outcome", body };
    }
  }
  return { ok: true, body };
}

// Fetch brief content for a candidate commit via GitHub contents API.
// Returns { content, inferredPath } or { content: null } on fetch failure.
export function fetchBriefContent(c, repo = REPO) {
  const filePath = c.artifactPath || (c.kind === "daily brief"
    ? `00_Inbox/brief-${c.date.slice(0, 10)}.md`
    : `10_Daily/weekly-W${c.date.slice(0, 10)}/`.slice(0, -1));
  let content = null;
  let inferredPath = filePath;
  if (c.localRepo) {
    try {
      content = gitRunner(c.localRepo, ["show", `${c.sha}:${inferredPath}`]);
    } catch { content = null; }
    return { content, inferredPath };
  }
  if (c.artifactPath) {
    try {
      const data = curlGithub(`/repos/${repo}/contents/${encodeURIComponent(inferredPath)}?ref=${c.sha}`);
      if (typeof data.content === 'string') {
        content = Buffer.from(data.content, "base64").toString("utf8");
      }
    } catch (e) { /* fall through */ }
  } else if (c.kind === "daily brief") {
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
  const { dryRun, force, bootstrap, pushed, stateFile = STATE_FILE, failedFile = FAILED_FILE, sendAttempts, sendWaitMs } = opts;
  if (!force && pushed[c.sha] === c.kind) return { pushed: false, failed: false, dry: false, skipped: true };
  const { content, inferredPath } = fetchBriefContent(c);
  if (content == null) {
    console.error(sanitizeErrorText(`skip ${c.sha}: no content fetchable`));
    return { pushed: false, failed: false, dry: false, skipped: true, noContent: true };
  }
  let meta;
  try {
    meta = deriveArtifactMeta(c.kind, inferredPath);
  } catch (e) {
    if (!dryRun) appendFailed(c.sha, c.kind, e.message, failedFile);
    return { pushed: false, failed: true, dry: false, error: e.message };
  }
  const period = meta.period;
  if (!force && hasPushedArtifact(pushed, c.kind, period, inferredPath)) {
    if (bootstrap) {
      markPushed(c.sha, c.kind, stateFile, {
        period,
        path: inferredPath,
        commit: c.sha,
        status: "bootstrapped",
        attempts: 0,
      });
      return { pushed: false, failed: false, dry: false, bootstrapped: true, duplicateArtifact: true };
    }
    return { pushed: false, failed: false, dry: false, skipped: true, duplicateArtifact: true };
  }
  const validation = validateArtifactContent(content, c.kind);
  if (!validation.ok) {
    if (!dryRun) appendFailed(c.sha, c.kind, validation.error, failedFile);
    return { pushed: false, failed: true, dry: Boolean(dryRun), error: validation.error };
  }
  const body = validation.body;
  if (dryRun) {
    console.log(`DRY: would push ${c.kind} @ ${c.sha.slice(0, 7)} (${body.length} chars)`);
    return { pushed: false, failed: false, dry: true };
  }
  if (bootstrap) {
    markPushed(c.sha, c.kind, stateFile, {
      period,
      path: inferredPath,
      commit: c.sha,
      status: "bootstrapped",
      attempts: 0,
    });
    return { pushed: false, failed: false, dry: false, bootstrapped: true };
  }
  const title = {
    "daily brief": "## Brief",
    "weekly synthesis": "## Weekly Synthesis",
    "result daily": "## 超级个体结果日报",
    "result weekly": "## 超级个体结果周复盘",
  }[c.kind];
  if (!title) {
    const error = `unsupported report kind: ${c.kind}`;
    appendFailed(c.sha, c.kind, error, failedFile);
    return { pushed: false, failed: true, dry: false, error };
  }
  const md = `${title} — ${period}\n\n${body}`;
  const idempotencyKey = larkIdempotencyKey(c.kind, period, inferredPath);
  const result = sendBrief(md, sendAttempts, sendWaitMs, idempotencyKey);
  if (result.ok) {
    markPushed(c.sha, c.kind, stateFile, {
      period,
      path: inferredPath,
      commit: c.sha,
      status: "sent",
      attempts: result.attempts,
    });
    console.log(`pushed ${c.kind} @ ${c.sha.slice(0, 7)} (${body.length} chars)`);
    return { pushed: true, failed: false, dry: false };
  }
  appendFailed(c.sha, c.kind, result.error, failedFile);
  console.error(sanitizeErrorText(`FAILED ${c.kind} @ ${c.sha.slice(0, 7)}: ${result.error}`));
  return { pushed: false, failed: true, dry: false, error: result.error };
}

// Testable pipeline: no process.exit inside. Returns { code, nothing?, results? }. Throws on listing failure.
// opts: { argv, curlRunner, larkRunner, retryWait, stateFile, failedFile }
export async function runPipeline(opts = {}) {
  const { dryRun, force, bootstrap, localRepo } = parseArgs(opts.argv);
  if (opts.curlRunner) setCurlRunner(opts.curlRunner);
  if (opts.larkRunner) setLarkRunner(opts.larkRunner);
  if (opts.gitRunner) setGitRunner(opts.gitRunner);
  if (opts.retryWait) setRetryWait(opts.retryWait);
  const stateFile = opts.stateFile ?? STATE_FILE;
  const failedFile = opts.failedFile ?? FAILED_FILE;
  let candidates;
  if (localRepo) {
    candidates = listLocalCandidates(localRepo).map((c) => ({ ...c, localRepo }));
  } else {
    const commits = curlGithub(`/repos/${REPO}/commits?per_page=10`);
    candidates = (Array.isArray(commits) ? commits : []).map(parseGithubCommit).filter(Boolean).reverse();
  }
  if (candidates.length === 0) return { code: 0, nothing: true, dryRun, bootstrap, localMode: Boolean(localRepo) };
  const pushed = dryRun ? readPushed(stateFile) : loadPushed(stateFile);
  const results = [];
  for (const c of candidates) {
    const result = processCandidate(c, { dryRun, force, bootstrap, pushed, stateFile, failedFile, sendAttempts: SEND_MAX_ATTEMPTS, sendWaitMs: sendRetryWaitMs });
    results.push(result);
    if (result.pushed || result.bootstrapped) {
      pushed[c.sha] = c.kind;
      if (c.artifactPath) {
        const meta = deriveArtifactMeta(c.kind, c.artifactPath);
        pushed.__artifacts = pushed.__artifacts && typeof pushed.__artifacts === "object" ? pushed.__artifacts : {};
        const key = artifactKey(c.kind, meta.period, meta.path);
        const prev = pushed.__artifacts[key] || {};
        pushed.__artifacts[key] = { ...prev, status: prev.status === "sent" && result.bootstrapped ? "sent" : result.bootstrapped ? "bootstrapped" : "sent" };
      }
    }
  }
  return { code: 0, results, localMode: Boolean(localRepo), bootstrap };
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
      console.error(sanitizeErrorText(`failed to log to failed-runs.json: ${logErr.message}`));
    }
    console.error(sanitizeErrorText(`logged failure (exit 0 for launchd): ${error.message}`));
    return { code: 0, logged, error: sanitizeErrorText(error.message) };
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
