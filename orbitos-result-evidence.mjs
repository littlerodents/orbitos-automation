#!/usr/bin/env node
// Collects a minimized, redacted evidence packet. Raw conversations and Feishu IDs never leave source files.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LARK_CLI = existsSync(path.join(homedir(), ".npm-global", "bin", "lark-cli"))
  ? path.join(homedir(), ".npm-global", "bin", "lark-cli")
  : "lark-cli";

export function redactEvidenceText(value) {
  return String(value ?? "")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:ou|on|om|cli)_[A-Za-z0-9_-]{8,}\b/g, "[FEISHU_ID_REDACTED]")
    .replace(/\bhttps:\/\/([^/\s:@]+):([^/\s@]+)@/gi, "https://[REDACTED]@")
    .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(token\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]");
}

function compactText(value, maxChars = 900) {
  return redactEvidenceText(value)
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, "[IMAGE OMITTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && ["text", "input_text", "output_text"].includes(item.type))
    .map((item) => item.text || item.content || "")
    .filter(Boolean)
    .join("\n");
}

function parseJsonLines(jsonl) {
  const out = [];
  for (const line of String(jsonl).split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* Ignore partial/corrupt lines in active logs. */ }
  }
  return out;
}

function inWindow(timestamp, { startMs, endMs }) {
  const ms = Date.parse(timestamp || "");
  return Number.isFinite(ms) && ms >= startMs && ms < endMs;
}

function projectFromCwd(cwd) {
  if (!cwd) return "unknown";
  const clean = String(cwd).replace(/\/$/, "");
  return path.basename(clean) || "unknown";
}

function sessionEvidence({ source, cwd, events, intents, outcomes, complete }) {
  if (!events.length || (!intents.length && !outcomes.length)) return null;
  const sorted = [...events].sort((a, b) => a - b);
  return {
    source,
    project: projectFromCwd(cwd),
    started_at: new Date(sorted[0]).toISOString(),
    ended_at: new Date(sorted.at(-1)).toISOString(),
    intent: compactText(intents[0] || "unknown"),
    outcome: compactText(outcomes.at(-1) || "unknown", 1400),
    status: complete ? "completed" : "in_progress_or_unknown",
  };
}

export function parseCodexJsonl(jsonl, window) {
  const rows = parseJsonLines(jsonl);
  const metas = rows.filter((row) => row.type === "session_meta");
  if (metas.some((row) => row.payload?.source?.subagent)) return [];
  const cwd = metas.find((row) => row.payload?.cwd)?.payload.cwd || null;
  const events = [];
  const intents = [];
  const outcomes = [];
  let complete = false;
  for (const row of rows) {
    if (!inWindow(row.timestamp, window) || row.type !== "event_msg") continue;
    const type = row.payload?.type;
    if (!["user_message", "agent_message", "task_complete"].includes(type)) continue;
    events.push(Date.parse(row.timestamp));
    if (type === "user_message") intents.push(row.payload?.message || "");
    if (type === "agent_message") outcomes.push(row.payload?.message || "");
    if (type === "task_complete") {
      complete = true;
      outcomes.push(row.payload?.last_agent_message || "");
    }
  }
  if (intents.some((intent) => /<heartbeat\b|<automation_id>/i.test(String(intent)))) return [];
  const evidence = sessionEvidence({ source: "codex", cwd, events, intents, outcomes, complete });
  return evidence ? [evidence] : [];
}

export function parseClaudeJsonl(jsonl, window) {
  const rows = parseJsonLines(jsonl);
  const humanPrompt = rows.some((row) => inWindow(row.timestamp, window)
    && row.type === "user"
    && row.entrypoint !== "sdk-cli"
    && row.promptSource !== "sdk"
    && (row.promptSource === "typed" || row.origin?.kind === "human" || row.entrypoint === "cli")
    && !/<task-notification\b/i.test(messageText(row.message?.content)));
  if (!humanPrompt) return [];
  const events = [];
  const intents = [];
  const outcomes = [];
  let cwd = null;
  for (const row of rows) {
    if (!inWindow(row.timestamp, window) || row.isSidechain === true) continue;
    if (!["user", "assistant"].includes(row.type)) continue;
    cwd ||= row.cwd || null;
    const text = messageText(row.message?.content);
    if (row.type === "user" && /<task-notification\b/i.test(text)) continue;
    events.push(Date.parse(row.timestamp));
    if (row.type === "user" && text) intents.push(text);
    if (row.type === "assistant" && text) outcomes.push(text);
  }
  const evidence = sessionEvidence({ source: "claude", cwd, events, intents, outcomes, complete: outcomes.length > 0 });
  return evidence ? [evidence] : [];
}

export function activityMinutesProxy(timestamps) {
  const sorted = [...new Set(timestamps.filter(Number.isFinite))].sort((a, b) => a - b);
  if (!sorted.length) {
    return { active_minutes_proxy: 0, method: "5 minute floor plus inter-event gaps capped at 30 minutes" };
  }
  let minutes = 5;
  for (let i = 1; i < sorted.length; i++) {
    minutes += Math.min(30, Math.max(0, Math.round((sorted[i] - sorted[i - 1]) / 60000)));
  }
  return {
    active_minutes_proxy: minutes,
    method: "5 minute floor plus inter-event gaps capped at 30 minutes",
  };
}

function walkJsonl(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root).sort()) {
    const full = path.join(root, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...walkJsonl(full));
    else if (st.isFile() && name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function collectSessions(root, parser, window) {
  const sessions = [];
  for (const file of walkJsonl(root)) {
    let st;
    try { st = statSync(file); } catch { continue; }
    if (st.mtimeMs < window.startMs) continue;
    try { sessions.push(...parser(readFileSync(file, "utf8"), window)); } catch { /* Source stays unavailable, collector continues. */ }
  }
  return sessions.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

export function collectLocalAiEvidence({ home = homedir(), window }) {
  const codex = collectSessions(path.join(home, ".codex", "sessions"), parseCodexJsonl, window);
  const claude = collectSessions(path.join(home, ".claude", "projects"), parseClaudeJsonl, window);
  const timestamps = [...codex, ...claude].flatMap((session) => [Date.parse(session.started_at), Date.parse(session.ended_at)]);
  return {
    codex,
    claude,
    activity_time: activityMinutesProxy(timestamps),
  };
}

function eventTime(event, field) {
  const value = event?.[field];
  if (typeof value === "string") return value;
  return value?.datetime || value?.date || "unknown";
}

export function dedupeCalendarEvents(events) {
  const seen = new Set();
  const out = [];
  for (const event of events || []) {
    const normalized = {
      summary: compactText(event?.summary || "untitled", 300),
      start: eventTime(event, "start_time"),
      end: eventTime(event, "end_time"),
      status: compactText(event?.self_rsvp_status || "unknown", 80),
    };
    const key = `${normalized.summary}|${normalized.start}|${normalized.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

export function normalizeMinutesDetails(response) {
  const minutes = response?.data?.minutes || response?.minutes || [];
  return minutes.map((minute) => ({
    title: compactText(minute?.title || "untitled", 300),
    summary: compactText(minute?.artifacts?.summary || "unknown", 6000),
    summary_source: "Feishu AI artifact; not independently transcript-verified",
    todos: (minute?.artifacts?.todos || []).slice(0, 30).map((todo) => ({
      content: compactText(todo?.content || "unknown", 600),
      is_done: Boolean(todo?.is_done),
    })),
    chapters: (minute?.artifacts?.chapters || []).slice(0, 12).map((chapter) => ({
      title: compactText(chapter?.title || "untitled", 300),
      summary: compactText(chapter?.summary_content || "unknown", 1000),
    })),
    keywords: (minute?.artifacts?.keywords || []).slice(0, 30).map((keyword) => compactText(keyword, 100)),
  }));
}

function defaultCommandRunner(command, argv) {
  const result = spawnSync(command, argv, { encoding: "utf8", timeout: 45000 });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function runLarkJson(larkCli, argv, commandRunner) {
  const result = commandRunner(larkCli, argv);
  if (result.status !== 0) throw new Error(compactText(result.stderr || result.stdout || "lark-cli failed", 400));
  const parsed = JSON.parse(result.stdout);
  if (parsed?.ok === false) throw new Error(compactText(parsed?.error?.message || "lark-cli returned ok:false", 400));
  return parsed;
}

export function collectFeishuEvidence({ date, larkCli = DEFAULT_LARK_CLI, commandRunner = defaultCommandRunner }) {
  const evidence = {
    availability: { calendar: "unavailable", minutes: "unavailable" },
    calendar: [],
    minutes: [],
  };
  try {
    const calendar = runLarkJson(larkCli, [
      "calendar", "+agenda", "--as", "user", "--start", date, "--end", date, "--format", "json",
    ], commandRunner);
    evidence.calendar = dedupeCalendarEvents(Array.isArray(calendar.data) ? calendar.data : []);
    evidence.availability.calendar = "available";
  } catch (error) {
    evidence.availability.calendar = `unavailable: ${compactText(error.message, 300)}`;
  }

  try {
    const itemsByToken = new Map();
    for (const identityFlag of ["--owner-ids", "--participant-ids"]) {
      const search = runLarkJson(larkCli, [
        "minutes", "+search", identityFlag, "me", "--start", date, "--end", date,
        "--page-size", "30", "--format", "json",
      ], commandRunner);
      for (const item of search?.data?.items || []) {
        if (item?.token) itemsByToken.set(item.token, item);
      }
    }
    const tokens = [...itemsByToken.keys()].slice(0, 50);
    if (tokens.length) {
      const details = runLarkJson(larkCli, [
        "minutes", "+detail", "--minute-tokens", tokens.join(","),
        "--summary", "--todo", "--chapter", "--keyword", "--format", "json",
      ], commandRunner);
      evidence.minutes = normalizeMinutesDetails(details);
    }
    evidence.availability.minutes = "available";
  } catch (error) {
    evidence.availability.minutes = `unavailable: ${compactText(error.message, 300)}`;
  }
  return evidence;
}

function cstDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function dateWindow(date) {
  const startMs = Date.parse(`${date}T00:00:00+08:00`);
  const end = new Date(startMs);
  end.setUTCDate(end.getUTCDate() + 1);
  return { startMs, endMs: end.getTime() };
}

function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function parseArgs(argv) {
  const user = userInfo().username;
  const args = {
    date: cstDate(),
    host: user === "evander" ? "primary" : "shadow",
    home: homedir(),
    outputDir: process.env.ORBITOS_EVIDENCE_DIR || path.join(homedir(), ".local", "share", "orbitos-result-evidence"),
    includeFeishu: user === "evander",
    dryRun: false,
    larkCli: process.env.LARK_CLI_PATH || DEFAULT_LARK_CLI,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--date") args.date = argv[++i];
    else if (arg === "--host") args.host = argv[++i];
    else if (arg === "--home") args.home = argv[++i];
    else if (arg === "--output-dir") args.outputDir = argv[++i];
    else if (arg === "--lark-cli") args.larkCli = argv[++i];
    else if (arg === "--include-feishu") args.includeFeishu = true;
    else if (arg === "--no-feishu") args.includeFeishu = false;
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!realDate(args.date)) throw new Error("--date must be a real YYYY-MM-DD calendar date");
  if (!/^[a-z0-9_-]+$/i.test(args.host)) throw new Error("--host must contain only letters, numbers, underscore, or hyphen");
  return args;
}

export function writeEvidencePacketAtomic(target, packet) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(packet, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, target);
  chmodSync(target, 0o600);
}

export function runEvidenceCollector(opts = {}) {
  const args = parseArgs(opts.argv ?? process.argv.slice(2));
  const local = collectLocalAiEvidence({ home: args.home, window: dateWindow(args.date) });
  const feishu = args.includeFeishu
    ? collectFeishuEvidence({ date: args.date, larkCli: args.larkCli, commandRunner: opts.commandRunner || defaultCommandRunner })
    : { availability: { calendar: "not collected on this host", minutes: "not collected on this host" }, calendar: [], minutes: [] };
  const packet = {
    schema_version: 1,
    host: args.host,
    source_machine: compactText(hostname(), 120),
    date: args.date,
    generated_at: new Date().toISOString(),
    privacy: "minimized summaries only; no raw transcripts, tool output, credentials, Feishu IDs, or minute tokens",
    source_coverage: {
      codex_sessions: local.codex.length,
      claude_sessions: local.claude.length,
      calendar: feishu.availability.calendar,
      minutes: feishu.availability.minutes,
    },
    activity_time: local.activity_time,
    ai_work: { codex: local.codex, claude: local.claude },
    feishu: { calendar: feishu.calendar, minutes: feishu.minutes },
  };
  const target = path.join(args.outputDir, `${args.host}-${args.date}.json`);
  if (!args.dryRun) writeEvidencePacketAtomic(target, packet);
  const summary = {
    date: args.date,
    host: args.host,
    output_path: target,
    dry_run: args.dryRun,
    codex_sessions: local.codex.length,
    claude_sessions: local.claude.length,
    calendar_events: feishu.calendar.length,
    minutes: feishu.minutes.length,
    active_minutes_proxy: local.activity_time.active_minutes_proxy,
  };
  (opts.stdout || ((line) => process.stdout.write(`${line}\n`)))(JSON.stringify(summary));
  return { summary, packet };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  try {
    runEvidenceCollector();
  } catch (error) {
    console.error(compactText(error?.message || error, 500));
    process.exitCode = 1;
  }
}
