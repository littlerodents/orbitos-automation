#!/usr/bin/env node
// Local Daily Brief / Weekly Synthesis runtime.
// Default mode is dry-run: no LLM call, no vault write, no git mutation.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { request } from "node:https";
import { fileURLToPath } from "node:url";

const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
const DEFAULT_LEDGER_BASENAME = "runs.json";
const DEFAULT_VAULT = existsSync("/Users/shadow/Work/evander-orbitos-vault")
  ? "/Users/shadow/Work/evander-orbitos-vault"
  : path.join(homedir(), "Obsidian", "OrbitOS");

export function defaultLedgerPath(env = process.env) {
  const stateRoot = env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(stateRoot, "orbitos-synthesis", DEFAULT_LEDGER_BASENAME);
}

const DEFAULT_LEDGER = defaultLedgerPath();

export function scheduledInstantMs(kind, date) {
  const hour = kind === "weekly" ? "10" : "08";
  return new Date(`${date}T${hour}:00:00+08:00`).getTime();
}

function noteTimeMs(date) {
  return new Date(date).getTime();
}

export function isoWeek(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function readUtf8(file) {
  return readFileSync(file, "utf8");
}

function walkMarkdown(root, rel = "") {
  const dir = path.join(root, rel);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const childRel = path.posix.join(rel.split(path.sep).join(path.posix.sep), name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkMarkdown(root, childRel));
    else if (st.isFile() && name.endsWith(".md") && !childRel.includes("/_errors/")) out.push(childRel);
  }
  return out;
}

function basenameNoMd(rel) {
  return path.posix.basename(rel).replace(/\.md$/, "");
}

function frontmatterDate(content, fields = ["date"]) {
  const fm = content.match(/^---[\s\S]*?\n---/);
  if (!fm) return null;
  for (const field of fields) {
    const match = fm[0].match(new RegExp(`\\n${field}:\\s*['"]?([\\d-]+)`));
    if (match) return match[1];
  }
  return null;
}

function isStrongPath(rel) {
  return rel.startsWith("30_Research/Selected/") || rel.startsWith("40_Wiki/") || rel.startsWith("20_Project/");
}

function isStrongContent(content, rel) {
  return isStrongPath(rel) || /\n(type:\s*selected-content|status:\s*(selected|promoted)|liked:\s*strong_like)\b/i.test(content);
}

function selectedSignal(content, rel) {
  return rel.startsWith("30_Research/Selected/")
    || rel.startsWith("40_Wiki/")
    || /\n(type:\s*selected-content|status:\s*(selected|promoted)|liked:\s*strong_like|rating:\s*[67])\b/i.test(content);
}

function fileRecord(vaultPath, rel) {
  const content = readUtf8(path.join(vaultPath, rel));
  return { rel, name: basenameNoMd(rel), content };
}

export function defaultOutputPath(kind, date) {
  if (kind === "daily") return `00_Inbox/brief-${date}.md`;
  const weekStr = String(isoWeek(date)).padStart(2, "0");
  return `10_Daily/weekly-W${weekStr}-${date}.md`;
}

function promptPath(kind) {
  return kind === "daily" ? "99_System/Prompts/Daily_Brief.md" : "99_System/Prompts/Weekly_Synthesis.md";
}

function readPrompt(vaultPath, kind, fallback) {
  const rel = promptPath(kind);
  const file = path.join(vaultPath, rel);
  return existsSync(file) ? readUtf8(file) : fallback;
}

export function buildDailyPlan({ vaultPath = DEFAULT_VAULT, date = todayCst(), model = DEFAULT_MODEL } = {}) {
  const all = walkMarkdown(vaultPath);
  const runAtMs = scheduledInstantMs("daily", date);
  const dayAgoMs = runAtMs - 24 * 3600 * 1000;
  const weekAgoMs = runAtMs - 7 * 24 * 3600 * 1000;
  const inboxPaths = all
    .filter((rel) => rel.startsWith("00_Inbox/") && !basenameNoMd(rel).startsWith("brief-") && !basenameNoMd(rel).startsWith("weekly-"))
    .slice(-15);
  const selectedPaths = all
    .filter((rel) => rel.startsWith("30_Research/Selected/") || rel.startsWith("40_Wiki/") || rel.startsWith("20_Project/"))
    .slice(-45);
  const selectedFiles = [...inboxPaths, ...selectedPaths, promptPath("daily")];
  const inbox = [];
  const research = [];
  for (const rel of [...inboxPaths, ...selectedPaths]) {
    const rec = fileRecord(vaultPath, rel);
    const dateStr = frontmatterDate(rec.content);
    const fileTime = dateStr ? noteTimeMs(dateStr) : runAtMs;
    if (rel.startsWith("00_Inbox/") && fileTime >= dayAgoMs) {
      inbox.push({ ...rec, content: rec.content.slice(0, 1800), date: dateStr });
    } else if (isStrongContent(rec.content, rel) && fileTime >= weekAgoMs) {
      research.push({ ...rec, content: rec.content.slice(0, 2600), date: dateStr });
    }
  }
  const inboxText = inbox.length
    ? inbox.map((n) => `### [[${n.name}]] (${n.date || "?"})\n${n.content}`).join("\n\n---\n\n")
    : "(empty)";
  const researchText = research.length
    ? research.map((n) => `### [[${n.name}]] (${n.date || "?"})\n${n.content}`).join("\n\n---\n\n")
    : "(empty)";
  const systemPrompt = readPrompt(
    vaultPath,
    "daily",
    "You are a vault thinking partner. Prioritize selected material and output CONNECTIONS, PATTERN, QUESTION, BASE REMINDER.",
  );
  const userContent = `today: ${date}\n\nINBOX (last 24h, light context, ${inbox.length} notes):\n${inboxText}\n\nSELECTED / PROJECT / WIKI (last 7d, primary input, ${research.length} notes):\n${researchText}`;
  return {
    kind: "daily",
    date,
    period: date,
    model,
    outputPath: defaultOutputPath("daily", date),
    selectedFiles,
    counts: { inbox: inbox.length, research: research.length },
    systemPrompt,
    userContent,
    promptChars: systemPrompt.length + userContent.length,
  };
}

export function buildWeeklyPlan({ vaultPath = DEFAULT_VAULT, date = todayCst(), model = DEFAULT_MODEL } = {}) {
  const all = walkMarkdown(vaultPath);
  const week = isoWeek(date);
  const runAtMs = scheduledInstantMs("weekly", date);
  const weekAgoMs = runAtMs - 7 * 24 * 3600 * 1000;
  const selectedResearchPaths = all.filter((rel) => rel.startsWith("30_Research/Selected/")).slice(-120);
  const wikiPaths = all.filter((rel) => rel.startsWith("40_Wiki/")).slice(-50);
  const projectPaths = all.filter((rel) => rel.startsWith("20_Project/")).slice(-80);
  const weekly = [];
  const projects = [];
  const oldSignalCandidates = [];
  for (const rel of [...selectedResearchPaths, ...wikiPaths, ...projectPaths]) {
    const rec = fileRecord(vaultPath, rel);
    if (rel.startsWith("20_Project/")) {
      projects.push({ ...rec, content: rec.content.slice(0, 1800) });
      continue;
    }
    const dateStr = frontmatterDate(rec.content, ["date", "created"]);
    const fileTime = dateStr ? noteTimeMs(dateStr) : runAtMs;
    if (selectedSignal(rec.content, rel) && fileTime >= weekAgoMs) {
      weekly.push({ ...rec, content: rec.content.slice(0, 4000), date: dateStr });
    } else if (selectedSignal(rec.content, rel) && fileTime < weekAgoMs) {
      oldSignalCandidates.push({ ...rec, content: rec.content.slice(0, 2500), date: dateStr });
    }
  }
  oldSignalCandidates.sort((a, b) => a.name.localeCompare(b.name));
  const oldSignal = oldSignalCandidates.length ? oldSignalCandidates[week % oldSignalCandidates.length] : null;
  const weeklyText = weekly.length
    ? weekly.map((n) => `### [[${n.name}]] (${n.date || "?"})\n${n.content}`).join("\n\n---\n\n")
    : "(empty)";
  const oldSignalText = oldSignal ? `### [[${oldSignal.name}]] (${oldSignal.date || "?"})\n${oldSignal.content}` : "(none)";
  const projectsText = projects.length
    ? projects.map((n) => `### [[${n.name}]]\n${n.content}`).join("\n\n---\n\n")
    : "(none)";
  const systemPrompt = readPrompt(
    vaultPath,
    "weekly",
    "You are a vault synthesis partner. Synthesize selected signals and include OLD SIGNAL revisit.",
  );
  const userContent = `today: ${date} | week: W${week}\n\nSELECTED WEEKLY NOTES (${weekly.length} items, last 7d):\n${weeklyText}\n\nOLD SELECTED SIGNAL (random revisit seed from ${oldSignalCandidates.length} older candidates):\n${oldSignalText}\n\nACTIVE PROJECTS:\n${projectsText}`;
  return {
    kind: "weekly",
    date,
    week,
    period: `W${String(week).padStart(2, "0")}-${date}`,
    model,
    outputPath: defaultOutputPath("weekly", date),
    selectedFiles: [...selectedResearchPaths, ...wikiPaths, ...projectPaths, promptPath("weekly")],
    counts: { weekly: weekly.length, oldSignalCandidates: oldSignalCandidates.length, projects: projects.length },
    systemPrompt,
    userContent,
    promptChars: systemPrompt.length + userContent.length,
  };
}

export function extractAssistantText(response) {
  const text = response?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim().length === 0) throw new Error("model content empty");
  const trimmed = text.trim();
  validateArtifactBody(trimmed, "model content");
  return trimmed;
}

function artifactBody(content) {
  return content
    .replace(/^---[\s\S]*?\n---\s*/, "")
    .replace(/^# .*(?:\n|$)/, "")
    .trim();
}

function hasRejectedHeading(content) {
  return /(^|\n)\s*(?:#{1,6}\s*)?(?:ERROR|RAW REASONING)\b/i.test(content);
}

function validateArtifactBody(content, label = "artifact") {
  const body = artifactBody(content);
  if (body.length === 0) throw new Error(`${label} body empty`);
  if (hasRejectedHeading(content)) throw new Error(`${label} contains rejected heading`);
  if (body.length < 300) throw new Error(`${label} shorter than 300 characters`);
}

function validateExistingArtifact(content) {
  validateArtifactBody(content, "existing artifact");
  return true;
}

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function assertHttpsEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("--endpoint must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("--endpoint must use HTTPS");
  if (url.username || url.password) throw new Error("--endpoint must not include credentials");
}

export function renderArtifact({ kind, date, week, model, text }) {
  if (kind === "daily") {
    return `---\ntype: daily-brief\ndate: ${date}\nstatus: unread\nmodel: ${model}\n---\n# Brief — ${date}\n\n${text}`;
  }
  return `---\ntype: weekly-synthesis\ndate: ${date}\nweek: ${week}\nstatus: unread\nmodel: ${model}\n---\n# Weekly Synthesis — Week ${week} (${date})\n\n${text}`;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function todayCst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function parseArgs(argv) {
  const args = {
    kind: argv[0],
    apply: false,
    dryRun: true,
    date: todayCst(),
    vaultPath: process.env.ORBITOS_VAULT_PATH || DEFAULT_VAULT,
    model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
    endpoint: process.env.DEEPSEEK_ENDPOINT || DEFAULT_ENDPOINT,
    ledger: null,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") { args.apply = true; args.dryRun = false; }
    else if (a === "--dry-run") { args.dryRun = true; args.apply = false; }
    else if (a === "--date") args.date = argv[++i];
    else if (a === "--vault") args.vaultPath = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--endpoint") args.endpoint = argv[++i];
    else if (a === "--ledger") args.ledger = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!["daily", "weekly"].includes(args.kind)) throw new Error("usage: node orbitos-synthesis.mjs <daily|weekly> [--dry-run|--apply] [--date YYYY-MM-DD] [--vault PATH]");
  if (!isRealDate(args.date)) throw new Error("--date must be a real YYYY-MM-DD calendar date");
  return args;
}

async function defaultCommandRunner(command, argv) {
  const r = spawnSync(command, argv, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export async function defaultSecretProvider(_name = "DEEPSEEK_API_KEY", opts = {}) {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const secretFile = process.env.DEEPSEEK_API_KEY_FILE
    || path.join(homedir(), ".config", "orbitos", "deepseek-api-key");
  if (existsSync(secretFile)) {
    const st = statSync(secretFile);
    if (!st.isFile() || (st.mode & 0o077) !== 0) {
      throw new Error("DeepSeek key file must be a regular file inaccessible to group and other users");
    }
    const secret = readFileSync(secretFile, "utf8").trim();
    if (!secret) throw new Error("DeepSeek key file is empty");
    return secret;
  }
  const commandRunner = opts.commandRunner || defaultCommandRunner;
  const r = await commandRunner("/usr/bin/security", [
    "find-generic-password",
    "-a", process.env.USER || "",
    "-s", "orbitos-deepseek-api-key",
    "-w",
  ]);
  if (r.status !== 0) return "";
  return (r.stdout || "").trim();
}

async function defaultGitRunner(argv, cwd) {
  const r = spawnSync("/usr/bin/git", argv, { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function defaultLlmClient({ endpoint, apiKey, model, messages }) {
  const body = JSON.stringify({ model, messages, temperature: 0.4 });
  const url = new URL(endpoint);
  return await new Promise((resolve, reject) => {
    const req = request({
      method: "POST",
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 60000,
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`DeepSeek request failed with status ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error("DeepSeek response was not JSON")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("DeepSeek request timed out")));
    req.write(body);
    req.end();
  });
}

function readLedger(file) {
  if (!existsSync(file)) return { runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
  } catch {
    return { runs: [] };
  }
}

function appendLedger(file, entry) {
  mkdirSync(path.dirname(file), { recursive: true });
  const ledger = readLedger(file);
  ledger.runs.push(entry);
  writeFileSync(file, JSON.stringify(ledger, null, 2));
}

function appendLedgerSafe(file, entry) {
  try {
    appendLedger(file, entry);
    return true;
  } catch {
    return false;
  }
}

function sanitizeError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\bhttps:\/\/([^/\s:@]+):([^/\s@]+)@/gi, "https://[REDACTED]@")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(deepseek[_-]?api[_-]?key\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function ledgerEntry(planLike, status, extra = {}) {
  return {
    kind: planLike.kind,
    period: planLike.period,
    stage: extra.stage || "apply",
    status,
    artifact_path: planLike.outputPath,
    content_hash: extra.hash || null,
    commit_sha: extra.commitSha || null,
    created_at: new Date().toISOString(),
    ...(extra.error ? { error: sanitizeError(extra.error) } : {}),
  };
}

function drySummary(plan, dryRun = true) {
  return {
    kind: plan.kind,
    period: plan.period,
    output_path: plan.outputPath,
    selected_file_count: plan.selectedFiles.length,
    prompt_chars: plan.promptChars,
    model: plan.model,
    dry_run: dryRun,
  };
}

async function gitChecked(gitRunner, argv, cwd) {
  const r = await gitRunner(argv, cwd);
  if (r.status !== 0) throw new Error(`git ${argv[0]} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return r;
}

function prePlan(kind, date) {
  const week = kind === "weekly" ? isoWeek(date) : null;
  return {
    kind,
    date,
    week,
    period: kind === "weekly" ? `W${String(week).padStart(2, "0")}-${date}` : date,
    outputPath: defaultOutputPath(kind, date),
  };
}

function hasAhead(statusBranch) {
  return /\[([^\]]*\bahead\b[^\]]*)\]/.test(statusBranch || "");
}

function hasDiverged(statusBranch) {
  return /\[([^\]]*\bbehind\b[^\]]*,[^\]]*\bahead\b|[^\]]*\bahead\b[^\]]*,[^\]]*\bbehind\b)[^\]]*\]/.test(statusBranch || "");
}

function dirtyLines(stdout) {
  return (stdout || "").split("\n").filter((line) => line.trim() && !line.startsWith("##"));
}

async function assertClean(gitRunner, cwd, stage) {
  const r = await gitChecked(gitRunner, ["status", "--porcelain"], cwd);
  const dirty = dirtyLines(r.stdout);
  if (dirty.length) throw new Error(`${stage}: vault worktree dirty`);
}

async function preflightVault({ gitRunner, vaultPath }) {
  const inside = await gitChecked(gitRunner, ["rev-parse", "--is-inside-work-tree"], vaultPath);
  if ((inside.stdout || "").trim() !== "true") throw new Error("vaultPath is not a Git worktree");
  await assertClean(gitRunner, vaultPath, "preflight");

  const beforeBranch = await gitChecked(gitRunner, ["status", "--porcelain", "--branch"], vaultPath);
  if (hasDiverged(beforeBranch.stdout)) throw new Error("preflight: vault branch diverged");
  if (hasAhead(beforeBranch.stdout)) {
    await gitChecked(gitRunner, ["push"], vaultPath);
    const afterPush = await gitChecked(gitRunner, ["status", "--porcelain", "--branch"], vaultPath);
    if (hasAhead(afterPush.stdout) || hasDiverged(afterPush.stdout) || dirtyLines(afterPush.stdout).length) {
      throw new Error("preflight: vault still unsynchronized after retry push");
    }
  }

  await gitChecked(gitRunner, ["pull", "--ff-only"], vaultPath);
  await assertClean(gitRunner, vaultPath, "post-pull");
}

function changedPathsFromPorcelain(stdout) {
  return dirtyLines(stdout).map((line) => {
    const renamed = line.includes(" -> ");
    const raw = renamed ? line.split(" -> ").at(-1) : line.slice(3);
    return raw.replace(/^"|"$/g, "");
  });
}

function assertOnlyTargetChanged(stdout, targetPath) {
  const paths = changedPathsFromPorcelain(stdout);
  if (paths.length !== 1 || paths[0] !== targetPath) {
    throw new Error(`refusing to commit vault changes outside target artifact: ${paths.join(", ") || "none"}`);
  }
}

async function cleanupNewTarget({ gitRunner, vaultPath, outputPath }) {
  try {
    await gitRunner(["restore", "--staged", "--", outputPath], vaultPath);
  } catch {
    // Best-effort unstage of only the target path.
  }
  rmSync(path.join(vaultPath, outputPath), { force: true });
}

export async function runSynthesis(opts = {}) {
  const args = parseArgs(opts.argv ?? process.argv.slice(2));
  const vaultPath = opts.vaultPath || args.vaultPath;
  const model = opts.model || args.model;
  const endpoint = opts.endpoint || args.endpoint;
  const stdout = opts.stdout || ((line) => process.stdout.write(`${line}\n`));
  const buildPlan = () => args.kind === "daily"
    ? buildDailyPlan({ vaultPath, date: args.date, model })
    : buildWeeklyPlan({ vaultPath, date: args.date, model });

  if (!args.apply) {
    const plan = buildPlan();
    const summary = drySummary(plan, true);
    stdout(JSON.stringify(summary));
    return { ...summary, dryRun: true };
  }

  const ledgerFile = args.ledger || defaultLedgerPath();
  const gitRunner = opts.gitRunner || defaultGitRunner;
  let plan = prePlan(args.kind, args.date);
  let hash = null;
  let commitSha = null;
  let commitCreated = false;
  let targetCreated = false;

  try {
    await preflightVault({ gitRunner, vaultPath });
    plan = buildPlan();

    const fullPath = path.join(vaultPath, plan.outputPath);
    if (existsSync(fullPath)) {
      validateExistingArtifact(readUtf8(fullPath));
      const ledgerWritten = appendLedgerSafe(ledgerFile, ledgerEntry(plan, "existing", { stage: "preflight" }));
      return { ...drySummary(plan, false), status: "existing", ledgerWritten };
    }

    assertHttpsEndpoint(endpoint);

    const secretProvider = opts.secretProvider
      || ((name) => defaultSecretProvider(name, { commandRunner: opts.commandRunner }));
    const apiKey = await secretProvider("DEEPSEEK_API_KEY");
    if (!apiKey) throw new Error("DeepSeek API key unavailable; apply fails closed");

    const llmClient = opts.llmClient || defaultLlmClient;
    const response = await llmClient({
      endpoint,
      model,
      apiKey,
      messages: [
        { role: "system", content: plan.systemPrompt },
        { role: "user", content: plan.userContent },
      ],
    });
    const text = extractAssistantText(response);
    const artifact = renderArtifact({ kind: plan.kind, date: plan.date, week: plan.week, model, text });

    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, artifact, "utf8");
    targetCreated = true;
    hash = sha256(artifact);

    const commitMessage = plan.kind === "daily"
      ? `chore: daily brief ${plan.date}`
      : `chore: weekly synthesis W${plan.week} ${plan.date}`;
    await gitChecked(gitRunner, ["add", "--", plan.outputPath], vaultPath);
    const fullStatus = await gitChecked(gitRunner, ["status", "--porcelain"], vaultPath);
    assertOnlyTargetChanged(fullStatus.stdout, plan.outputPath);
    await gitChecked(gitRunner, ["commit", "-m", commitMessage, "--", plan.outputPath], vaultPath);
    commitCreated = true;
    const rev = await gitChecked(gitRunner, ["rev-parse", "HEAD"], vaultPath);
    commitSha = (rev.stdout || "").trim() || null;
    await gitChecked(gitRunner, ["push"], vaultPath);
    const ledgerWritten = appendLedgerSafe(ledgerFile, ledgerEntry(plan, "committed", { hash, commitSha }));
    return { ...drySummary(plan, false), status: "committed", contentHash: hash, commitSha, ledgerWritten };
  } catch (error) {
    if (targetCreated && !commitCreated) {
      await cleanupNewTarget({ gitRunner, vaultPath, outputPath: plan.outputPath });
    }
    appendLedgerSafe(ledgerFile, ledgerEntry(plan, "failed", {
      stage: commitCreated ? "push" : "apply",
      hash,
      commitSha,
      error,
    }));
    throw error;
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  runSynthesis().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

export {
  DEFAULT_ENDPOINT,
  DEFAULT_LEDGER,
  DEFAULT_MODEL,
  DEFAULT_VAULT,
};
