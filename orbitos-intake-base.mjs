#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { loadConfig } from "./lib/config.mjs";
const _cfg = loadConfig();

import { fileURLToPath } from "node:url";

const VAULT = _cfg.vault_path;
const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "orbitos-intake-base.config.json");
const STATE_PATH = path.join(ROOT, "orbitos-intake-base.state.json");
const LARK_CLI = _cfg.lark_cli_path;
const TIME_ZONE = "Asia/Shanghai";
const DEFAULT_CALIBRATION_UNTIL = "2026-05-31";
const MAX_SELECTED_TOPICS = 3;

const FIELD = {
  title: "标题",
  source: "来源",
  sourceId: "来源 ID",
  sourceKey: "Source Key",
  type: "类型",
  status: "状态",
  liked: "我喜欢的内容",
  promote: "进入 Obsidian",
  obsidianPath: "Obsidian 路径",
  url: "URL",
  author: "作者",
  sourceTime: "来源时间",
  importedAt: "导入时间",
  tags: "标签",
  aiTags: "AI 标签",
  project: "项目",
  topic: "主题",
  summary: "摘要",
  raw: "原文",
  hash: "Hash",
  lastSync: "最后同步",
};

const SELECTS = {
  source: ["Telegram", "Feishu", "YouMind", "Readwise", "Flomo", "Manual", "Other"],
  type: ["quick-thought", "web-reading", "highlight", "article", "craft", "brief-feedback", "other"],
  status: ["raw", "to_review", "liked", "selected", "promoted", "rejected", "noise", "archived"],
  liked: ["unknown", "like", "strong_like", "neutral", "dislike", "noise"],
};

const SOURCE_GLOBS = [
  ["00_Inbox", 2],
  ["30_Research/YouMind", 5],
  ["30_Research/Readwise", 5],
];

function nowIso() {
  return new Date().toISOString();
}

function localDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function log(message) {
  process.stdout.write(`[${nowIso()}] ${message}\n`);
}

function usage() {
  process.stdout.write(`Usage:
	  orbitos-intake-base.mjs init --base-token <token> [--base-url <url>]
	  orbitos-intake-base.mjs configure-views [--dry-run] [--today YYYY-MM-DD]
	  orbitos-intake-base.mjs sync-vault [--dry-run]
	  orbitos-intake-base.mjs promote [--dry-run] [--no-git]
	  orbitos-intake-base.mjs status

Purpose:
  Keep the Feishu Base "OrbitOS Intake DB" as the first-stage content database.
  Sources are scanned from OrbitOS Markdown, upserted into Base, then selected
  Base rows can be promoted back into OrbitOS.
`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function sleepMs(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function isTransientLarkError(error) {
  return /TLS handshake timeout|timeout awaiting response|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|temporarily unavailable|network/i.test(String(error?.message || error || ""));
}

function runLarkCli(argv, { attempts = 2 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return runLarkCliOnce(argv);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientLarkError(error)) break;
      log(`warn: lark-cli transient error, retrying once: ${error.message.split("\n")[0]}`);
      sleepMs(1200);
    }
  }
  throw lastError;
}

function runLarkCliOnce(argv) {
	  const result = spawnSync(LARK_CLI, argv, {
	    encoding: "utf8",
	    timeout: 60_000,
	    env: {
      ...process.env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:${require("node:os").homedir()}/.npm-global/bin:${process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"}`,
      LARK_CLI_NO_PROXY: "1",
    },
    maxBuffer: 50 * 1024 * 1024,
  });
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.error) throw new Error(`${LARK_CLI} ${argv.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${LARK_CLI} ${argv.join(" ")} failed (${result.status}): ${combined.slice(0, 2000)}`);
  }
  return parseJsonFromCliOutput(combined);
}

function parseJsonFromCliOutput(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object found in lark-cli output: ${output.slice(0, 500)}`);
  }
  return JSON.parse(output.slice(start, end + 1));
}

function git(args, options = {}) {
  const output = execFileSync("git", ["-C", VAULT, ...args], {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) throw new Error(`Missing config: ${CONFIG_PATH}. Run init first.`);
  return {
    calibrationUntil: DEFAULT_CALIBRATION_UNTIL,
    ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")),
  };
}

function writeConfig(config) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function readState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify({ ...readState(), ...patch }, null, 2)}\n`, "utf8");
}

function markSuccess(action) {
	  writeState({
	    lastRunAt: nowIso(),
	    lastRunAction: action,
	    lastRunOk: true,
	    lastSuccessAt: nowIso(),
	    lastSuccessAction: action,
	    lastErrorAt: null,
	    lastErrorAction: null,
	    lastError: null,
	  });
}

function markError(error, action = "unknown") {
  writeState({
    lastRunAt: nowIso(),
    lastRunAction: action,
    lastRunOk: false,
    lastErrorAt: nowIso(),
    lastErrorAction: action,
    lastError: String(error?.stack || error?.message || error).slice(0, 4000),
  });
}

function selectField(name, options, multiple = false) {
  return {
    name,
    type: "select",
    multiple,
    options: options.map((option) => ({ name: option, hue: "Blue", lightness: "Lighter" })),
  };
}

function tableFields() {
  return [
    { name: FIELD.title, type: "text", description: "内容标题或第一行摘要" },
    selectField(FIELD.source, SELECTS.source),
    { name: FIELD.sourceId, type: "text" },
    { name: FIELD.sourceKey, type: "text", description: "Stable de-duplication key: source:id/path" },
    selectField(FIELD.type, SELECTS.type),
    selectField(FIELD.status, SELECTS.status),
    selectField(FIELD.liked, SELECTS.liked),
    { name: FIELD.promote, type: "checkbox" },
    { name: FIELD.obsidianPath, type: "text" },
    { name: FIELD.url, type: "text", style: { type: "url" } },
    { name: FIELD.author, type: "text" },
    { name: FIELD.sourceTime, type: "datetime", style: { format: "yyyy-MM-dd HH:mm" } },
    { name: FIELD.importedAt, type: "datetime", style: { format: "yyyy-MM-dd HH:mm" } },
    { name: FIELD.tags, type: "text" },
    { name: FIELD.aiTags, type: "text" },
    { name: FIELD.project, type: "text" },
    { name: FIELD.topic, type: "text" },
    { name: FIELD.summary, type: "text" },
    { name: FIELD.raw, type: "text" },
    { name: FIELD.hash, type: "text" },
    { name: FIELD.lastSync, type: "datetime", style: { format: "yyyy-MM-dd HH:mm" } },
  ];
}

function localDate(date = new Date()) {
  return localDateTime(date).slice(0, 10);
}

function readwiseInMainView(config = {}, today = localDate()) {
  return String(today) <= String(config.calibrationUntil || DEFAULT_CALIBRATION_UNTIL);
}

function viewDefinitions(config = {}, today = localDate()) {
  const mainSources = readwiseInMainView(config, today) ? ["YouMind", "Readwise"] : ["YouMind"];
  return [
    {
      name: "00 每周只看",
      filter: { logic: "and", conditions: [[FIELD.status, "intersects", ["raw", "to_review"]], [FIELD.source, "intersects", mainSources]] },
      visibleFields: [FIELD.title, FIELD.source, FIELD.summary, FIELD.liked, FIELD.promote],
    },
    {
      name: "Readwise 纠偏",
      filter: { logic: "and", conditions: [[FIELD.source, "intersects", ["Readwise"]]] },
      visibleFields: [FIELD.title, FIELD.source, FIELD.summary, FIELD.liked, FIELD.promote, FIELD.url],
    },
    {
      name: "后台全量",
      filter: { logic: "and", conditions: [] },
      visibleFields: Object.values(FIELD),
    },
  ];
}

function createIntakeTable(baseToken) {
  const created = runLarkCli([
    "base",
    "+table-create",
    "--as",
    "user",
    "--base-token",
    baseToken,
    "--name",
    "Content Inbox",
    "--fields",
    JSON.stringify(tableFields()),
    "--view",
    JSON.stringify([{ name: "00 全量", type: "grid" }]),
  ]);
  const table = created?.data?.table || created?.table || firstObjectWith(created, "table_id") || firstObjectWith(created, "id");
  const tableId = table?.table_id || table?.id;
  if (!tableId) throw new Error(`Could not extract table id from table-create response: ${JSON.stringify(created).slice(0, 1000)}`);
  return tableId;
}

function createViews(baseToken, tableId) {
  const views = [];
  for (const def of viewDefinitions()) {
    const created = runLarkCli([
      "base",
      "+view-create",
      "--as",
      "user",
      "--base-token",
      baseToken,
      "--table-id",
      tableId,
      "--json",
      JSON.stringify({ name: def.name, type: "grid" }),
    ]);
    const view = created?.data?.view || created?.data?.views?.[0] || firstObjectWith(created, "view_id") || firstObjectWith(created, "id");
    const viewId = view?.view_id || view?.id || def.name;
    try {
      runLarkCli([
        "base",
        "+view-set-filter",
        "--as",
        "user",
        "--base-token",
        baseToken,
        "--table-id",
        tableId,
        "--view-id",
        viewId,
        "--json",
        JSON.stringify(def.filter),
      ]);
      runLarkCli([
        "base",
        "+view-set-sort",
        "--as",
        "user",
        "--base-token",
        baseToken,
        "--table-id",
        tableId,
        "--view-id",
        viewId,
        "--json",
        JSON.stringify({ sort_config: [{ field: FIELD.sourceTime, desc: true }, { field: FIELD.importedAt, desc: true }] }),
      ]);
      runLarkCli([
        "base",
        "+view-set-visible-fields",
        "--as",
        "user",
        "--base-token",
        baseToken,
        "--table-id",
        tableId,
        "--view-id",
        viewId,
        "--json",
        JSON.stringify({ visible_fields: def.visibleFields }),
      ]);
    } catch (error) {
      log(`warn: view config skipped for ${def.name}: ${error.message}`);
    }
    views.push({ name: def.name, id: viewId });
  }
  return views;
}

function normalizeViewListResponse(response) {
  const direct = response?.data?.views || response?.data?.items || response?.views || response?.items;
  if (Array.isArray(direct)) return direct;
  const found = firstObjectWith(response, "views");
  return Array.isArray(found?.views) ? found.views : [];
}

function viewId(view) {
  return view?.view_id || view?.id;
}

function viewName(view) {
  return view?.view_name || view?.name;
}

function listViews(config) {
  const response = runLarkCli([
    "base",
    "+view-list",
    "--as",
    "user",
    "--base-token",
    config.baseToken,
    "--table-id",
    config.tableId,
    "--limit",
    "200",
  ]);
  return normalizeViewListResponse(response);
}

function ensureView(config, def, views) {
  const existing = views.find((view) => viewName(view) === def.name);
  if (existing) return viewId(existing) || def.name;

  const created = runLarkCli([
    "base",
    "+view-create",
    "--as",
    "user",
    "--base-token",
    config.baseToken,
    "--table-id",
    config.tableId,
    "--json",
    JSON.stringify({ name: def.name, type: "grid" }),
  ]);
  const view = created?.data?.view || created?.data?.views?.[0] || firstObjectWith(created, "view_id") || firstObjectWith(created, "id");
  return view?.view_id || view?.id || def.name;
}

function configureViews({ dryRun = false, today = localDate() } = {}) {
  const config = readConfig();
  const defs = viewDefinitions(config, today);
  const existingViews = dryRun ? [] : listViews(config);
  const configured = [];

  for (const def of defs) {
    if (dryRun) {
      configured.push({ name: def.name, id: "(dry-run)" });
      log(`configure-views: would configure ${def.name}; fields=${def.visibleFields.join(", ")}`);
      continue;
    }
    const id = ensureView(config, def, existingViews);
    runLarkCli([
      "base",
      "+view-set-filter",
      "--as",
      "user",
      "--base-token",
      config.baseToken,
      "--table-id",
      config.tableId,
      "--view-id",
      id,
      "--json",
      JSON.stringify(def.filter),
    ]);
    runLarkCli([
      "base",
      "+view-set-sort",
      "--as",
      "user",
      "--base-token",
      config.baseToken,
      "--table-id",
      config.tableId,
      "--view-id",
      id,
      "--json",
      JSON.stringify({ sort_config: [{ field: FIELD.sourceTime, desc: true }, { field: FIELD.importedAt, desc: true }] }),
    ]);
    runLarkCli([
      "base",
      "+view-set-visible-fields",
      "--as",
      "user",
      "--base-token",
      config.baseToken,
      "--table-id",
      config.tableId,
      "--view-id",
      id,
      "--json",
      JSON.stringify({ visible_fields: def.visibleFields }),
    ]);
    configured.push({ name: def.name, id });
  }

  if (!dryRun) {
    const viewMap = new Map((config.views || []).map((view) => [view.name, view]));
    for (const view of configured) viewMap.set(view.name, view);
    writeConfig({ ...config, calibrationUntil: config.calibrationUntil || DEFAULT_CALIBRATION_UNTIL, views: [...viewMap.values()] });
    markSuccess("configure-views");
  }

  log(`configure-views: configured=${configured.map((view) => view.name).join(", ")}; dry_run=${dryRun}; readwise_in_main_view=${readwiseInMainView(config, today)}`);
}

function firstObjectWith(value, key) {
  if (!value || typeof value !== "object") return null;
  if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key)) return value;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = firstObjectWith(item, key);
    if (found) return found;
  }
  return null;
}

function walkMarkdown(root, maxDepth, depth = 0) {
  if (!existsSync(root) || depth > maxDepth) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(file, maxDepth, depth + 1));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(file);
  }
  return files;
}

function sourceFiles(vault = VAULT) {
  const files = [];
  for (const [rel, depth] of SOURCE_GLOBS) {
    files.push(...walkMarkdown(path.join(vault, rel), depth));
  }
  return files
    .filter((file) => !path.basename(file).startsWith("brief-"))
    .filter((file) => !file.includes(`${path.sep}_errors${path.sep}`))
    .sort();
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) return { data: {}, body: markdown };
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: markdown };
  const raw = markdown.slice(4, end).trimEnd();
  const body = markdown.slice(end + 4).replace(/^\n/, "");
  const data = {};
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^([A-Za-z0-9_ -]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    let value = match[2].trim();
    if (!value && lines[i + 1]?.startsWith("  - ")) {
      const arr = [];
      while (lines[i + 1]?.startsWith("  - ")) {
        i += 1;
        arr.push(lines[i].replace(/^  -\s*/, "").trim());
      }
      data[key] = arr;
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }
    data[key] = value;
  }
  return { data, body };
}

function titleFromBody(body, fallback) {
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) return cleanInline(heading[1]).slice(0, 180);
  const firstLine = body.split("\n").map((line) => cleanInline(line)).find(Boolean);
  return (firstLine || fallback).slice(0, 180);
}

function cleanInline(value) {
  return String(value || "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[[^\]]+]\(([^)]+)\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownText(body) {
  return body
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[[^\]]+]\(([^)]+)\)/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(value, max = 12000) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max - 30)}\n\n...[truncated]` : text;
}

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function normalizeDateTime(value) {
  if (!value) return "";
  const raw = String(value).trim();
  let date = new Date(raw);
  if (Number.isNaN(date.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    date = new Date(`${raw}T00:00:00+08:00`);
  }
  if (Number.isNaN(date.getTime()) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)) {
    date = new Date(raw.replace(" ", "T"));
  }
  return Number.isNaN(date.getTime()) ? "" : localDateTime(date);
}

function inferRecord(file, vault = VAULT) {
  const markdown = readFileSync(file, "utf8");
  const { data, body } = parseFrontmatter(markdown);
  const rel = path.relative(vault, file);
  const lowerRel = rel.toLowerCase();
  const text = markdownText(body);
  const title = String(data.title || data["Full Title"] || titleFromBody(body, path.basename(file, ".md")));

  let source = "Other";
  let type = "other";
  let sourceId = data.source_id || data.id || rel;

  if (data.source === "telegram" || lowerRel.startsWith("00_inbox/20")) {
    source = "Telegram";
    type = "quick-thought";
    sourceId = data.message_id || `${data.date || ""}-${data.time || ""}-${rel}`;
  }
  if (data.source === "feishu" || lowerRel.includes("/feishu-") || path.basename(file).startsWith("feishu-")) {
    source = "Feishu";
    type = "quick-thought";
    sourceId = data.message_id || rel;
  }
  if (data.source === "youmind" || lowerRel.includes("30_research/youmind/")) {
    source = "YouMind";
    type = data.type === "craft" ? "craft" : (data.youmind_type === "article" ? "article" : "web-reading");
    sourceId = data.youmind_id || rel;
  }
  if (lowerRel.includes("30_research/readwise/")) {
    source = "Readwise";
    type = "highlight";
    sourceId = `${rel}:${sha(text)}`;
  }
  if (data.source === "flomo" || lowerRel.includes("00_inbox/flomo/")) {
    source = "Flomo";
    type = data.flomo_type || "quick-thought";
    sourceId = data.flomo_id || `${rel}:${sha(text)}`;
  }
  if (String(data.type || "").includes("brief-feedback")) {
    type = "brief-feedback";
  }

  const tags = normalizeTags([data.tags, data.tag, source.toLowerCase(), type, data.board, data.project]);
  const aiTags = inferTags(`${title}\n${text}`).join(", ");
  const sourceTime = normalizeDateTime(data.created || data.date || data.time || statSync(file).mtime.toISOString());
  const url = data.url || extractMetadataUrl(body) || "";
  const author = data.author || extractMetadataLine(body, "Author") || data.from || "";
  const summary = summarize(title, text);

  return {
    title,
    source,
    sourceId: String(sourceId || rel),
    sourceKey: `${source}:${String(sourceId || rel)}`,
    type,
    status: "raw",
    liked: "unknown",
    promote: false,
    obsidianPath: rel,
    url: String(url || ""),
    author: String(author || ""),
    sourceTime,
    importedAt: localDateTime(),
    tags: tags.join(", "),
    aiTags,
    project: String(data.project || ""),
    topic: "",
    summary,
    raw: truncate(text),
    hash: sha(markdown),
    lastSync: localDateTime(),
  };
}

function normalizeTags(values) {
  const tags = [];
  for (const value of values.flat(Infinity)) {
    if (!value) continue;
    const parts = Array.isArray(value) ? value : String(value).split(/[,\s#]+/);
    for (const part of parts) {
      const cleaned = String(part).trim().replace(/^#/, "");
      if (cleaned && !tags.includes(cleaned)) tags.push(cleaned);
    }
  }
  return tags.slice(0, 24);
}

function inferTags(text) {
  const rules = [
    ["pai", /\bPAI\b|OrbitOS|Obsidian|外脑|个人系统/i],
    ["ai", /\bAI\b|LLM|agent|Claude|OpenAI|模型|智能体/i],
    ["product", /产品|用户|需求|MVP|PMF|增长|市场/i],
    ["writing", /写作|表达|文章|内容|叙事/i],
    ["crypto", /crypto|BTC|ETH|币|链上|交易|投资/i],
    ["career", /职业|工作|DevRel|面试|简历|offer/i],
    ["health", /健康|睡眠|营养|运动|药/i],
    ["actionable", /下一步|todo|行动|执行|应该|需要/i],
  ];
  return rules.filter(([, re]) => re.test(text)).map(([tag]) => tag);
}

function summarize(title, text) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return title;
  return compact.slice(0, 280);
}

function extractMetadataLine(body, name) {
  const re = new RegExp(`^-\\s*${name}:\\s*(.+)$`, "im");
  const match = body.match(re);
  return match ? cleanInline(match[1]) : "";
}

function extractMetadataUrl(body) {
  const fromSource = body.match(/^- URL:\s*(https?:\/\/\S+)/im);
  if (fromSource) return fromSource[1];
  const any = body.match(/https?:\/\/[^\s)]+/);
  return any ? any[0] : "";
}

function baseRecordPayload(record, includeUserFields = true) {
  const payload = {
    [FIELD.title]: record.title,
    [FIELD.source]: record.source,
    [FIELD.sourceId]: record.sourceId,
    [FIELD.sourceKey]: record.sourceKey,
    [FIELD.type]: record.type,
    [FIELD.obsidianPath]: record.obsidianPath,
    [FIELD.url]: record.url,
    [FIELD.author]: record.author,
    [FIELD.tags]: record.tags,
    [FIELD.aiTags]: record.aiTags,
    [FIELD.project]: record.project,
    [FIELD.topic]: record.topic,
    [FIELD.summary]: record.summary,
    [FIELD.raw]: record.raw,
    [FIELD.hash]: record.hash,
    [FIELD.lastSync]: record.lastSync,
  };
  if (record.sourceTime) payload[FIELD.sourceTime] = record.sourceTime;
  if (record.importedAt) payload[FIELD.importedAt] = record.importedAt;
  if (includeUserFields) {
    payload[FIELD.status] = record.status;
    payload[FIELD.liked] = record.liked;
    payload[FIELD.promote] = record.promote;
  }
  return payload;
}

function listBaseRecords(config, fields = [FIELD.sourceKey, FIELD.hash, FIELD.obsidianPath, FIELD.status, FIELD.liked, FIELD.promote]) {
  const rows = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const argv = [
      "base",
      "+record-list",
      "--as",
      "user",
      "--base-token",
      config.baseToken,
      "--table-id",
      config.tableId,
      "--limit",
      String(limit),
      "--offset",
      String(offset),
      "--format",
      "json",
    ];
    for (const field of fields) argv.push("--field-id", field);
    const response = runLarkCli(argv);
    const records = normalizeRecordListResponse(response);
    rows.push(...records);
    if (records.length < limit) break;
    offset += limit;
  }
  return rows;
}

function normalizeRecordListResponse(response) {
  const records = response?.data?.records || response?.data?.items || response?.records;
  if (Array.isArray(records)) return records;

  const matrix = response?.data?.data;
  const fieldNames = response?.data?.fields;
  const recordIds = response?.data?.record_id_list;
  if (!Array.isArray(matrix) || !Array.isArray(fieldNames)) return [];

  return matrix.map((row, index) => {
    const fields = {};
    fieldNames.forEach((field, fieldIndex) => {
      fields[field] = Array.isArray(row) ? row[fieldIndex] : undefined;
    });
    return {
      record_id: Array.isArray(recordIds) ? recordIds[index] : undefined,
      fields,
    };
  });
}

function rowId(row) {
  return row.record_id || row.id;
}

function rowFields(row) {
  return row.fields || row.record?.fields || {};
}

function cellText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    if (value.text) return String(value.text);
    if (value.name) return String(value.name);
    if (value.value) return cellText(value.value);
    if (value.id) return String(value.id);
  }
  return "";
}

function recordIndex(rows) {
  const map = new Map();
  for (const row of rows) {
    const fields = rowFields(row);
    const key = cellText(fields[FIELD.sourceKey]);
    if (key) map.set(key, { row, fields });
  }
  return map;
}

function syncVault({ dryRun = false } = {}) {
  const config = readConfig();
  const existing = recordIndex(listBaseRecords(config));
  const records = sourceFiles().map((file) => inferRecord(file));
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const record of records) {
    const hit = existing.get(record.sourceKey);
    if (!hit) {
      if (!dryRun) {
        runLarkCli([
          "base",
          "+record-upsert",
          "--as",
          "user",
          "--base-token",
          config.baseToken,
          "--table-id",
          config.tableId,
          "--json",
          JSON.stringify(baseRecordPayload(record, true)),
        ]);
      }
      created += 1;
      continue;
    }

    const fields = hit.fields;
    const sameHash = cellText(fields[FIELD.hash]) === record.hash;
    const samePath = cellText(fields[FIELD.obsidianPath]) === record.obsidianPath;
    if (sameHash && samePath) {
      unchanged += 1;
      continue;
    }
    if (!dryRun) {
      runLarkCli([
        "base",
        "+record-upsert",
        "--as",
        "user",
        "--base-token",
        config.baseToken,
        "--table-id",
        config.tableId,
        "--record-id",
        rowId(hit.row),
        "--json",
        JSON.stringify(baseRecordPayload(record, false)),
      ]);
    }
    updated += 1;
  }

  log(`sync-vault: scanned=${records.length}; created=${created}; updated=${updated}; unchanged=${unchanged}; dry_run=${dryRun}`);
  markSuccess(dryRun ? "sync-vault:dry-run" : "sync-vault");
}

function shouldPromote(fields) {
  const status = cellText(fields[FIELD.status]);
  const liked = cellText(fields[FIELD.liked]);
  const promote = String(cellText(fields[FIELD.promote])).toLowerCase() === "true";
  const hasPath = Boolean(cellText(fields[FIELD.obsidianPath]));
  return !hasPath && (promote || status === "selected" || liked === "strong_like");
}

function slugify(value, fallback = "intake") {
  const cleaned = String(value || fallback)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#^[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function promoteTarget(fields) {
  const source = cellText(fields[FIELD.source]).toLowerCase() || "manual";
  const type = cellText(fields[FIELD.type]);
  const title = slugify(cellText(fields[FIELD.title]), "content");
  const key = sha(cellText(fields[FIELD.sourceKey]) || title).slice(0, 8);
  const date = localDateTime().slice(0, 10);
  const dir = source === "flomo" ? "00_Inbox/Flomo" : (type === "quick-thought" ? "00_Inbox" : "30_Research/Selected");
  return `${dir}/${date} ${title} ${key}.md`;
}

function yaml(value) {
  if (value == null || value === "") return '""';
  return JSON.stringify(String(value));
}

function yamlList(name, values) {
  if (!values.length) return [`${name}: []`];
  return [`${name}:`, ...values.map((value) => `  - ${yaml(value)}`)];
}

function selectionRating(fields) {
  const liked = cellText(fields[FIELD.liked]);
  const status = cellText(fields[FIELD.status]);
  const promote = String(cellText(fields[FIELD.promote])).toLowerCase() === "true";
  if (liked === "noise" || status === "noise" || status === "rejected") return 2;
  if (liked === "strong_like" && promote) return 7;
  if (liked === "strong_like" || status === "selected" || promote) return 6;
  return 5;
}

function linkTitle(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
	  const mapped = {
	    ai: "AI",
	    pai: "PAI",
	    orbitos: "OrbitOS",
	    devrel: "DevRel",
	    product: "Product",
    writing: "Writing",
    crypto: "Crypto",
    career: "Career",
    health: "Health",
    actionable: "Actionable",
  }[raw.toLowerCase()];
  if (mapped) return mapped;
  if (/^[a-z][a-z0-9- ]*$/i.test(raw)) {
    return raw
      .split(/[-\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }
  return raw;
}

function linkSeeds(fields) {
  const ignore = new Set([
    "youmind",
    "readwise",
    "flomo",
    "telegram",
    "feishu",
    "manual",
    "other",
    "web-reading",
    "quick-thought",
    "highlight",
    "article",
    "craft",
    "brief-feedback",
    "selected-content",
    "raw",
    "selected",
    "promoted",
  ]);
  const topicCandidates = normalizeTags([
    cellText(fields[FIELD.tags]),
    cellText(fields[FIELD.aiTags]),
    cellText(fields[FIELD.topic]),
  ])
    .filter((tag) => !ignore.has(tag.toLowerCase()))
    .map(linkTitle)
    .filter(Boolean);
  const projectCandidates = normalizeTags([cellText(fields[FIELD.project])])
    .map(linkTitle)
    .filter(Boolean);

  const topics = [...new Set(topicCandidates)].slice(0, MAX_SELECTED_TOPICS);
  const projects = [...new Set(projectCandidates)].slice(0, 4);
  const related = [...new Set([...projects, ...topics])].slice(0, 8);
  return { topics, projects, related };
}

function wikilinks(values) {
  return values.length ? values.map((value) => `[[${value}]]`).join(", ") : "_None yet_";
}

function buildPromotionMarkdown(fields) {
  const title = cellText(fields[FIELD.title]) || "Untitled";
  const tags = normalizeTags([cellText(fields[FIELD.tags]), cellText(fields[FIELD.aiTags])]);
  const raw = cellText(fields[FIELD.raw]);
  const source = cellText(fields[FIELD.source]) || "Manual";
  const sourceKey = cellText(fields[FIELD.sourceKey]);
  const url = cellText(fields[FIELD.url]);
  const summary = cellText(fields[FIELD.summary]);
  const liked = cellText(fields[FIELD.liked]);
  const status = cellText(fields[FIELD.status]);
  const rating = selectionRating(fields);
  const links = linkSeeds(fields);
  const created = localDateTime().slice(0, 10);

  return [
    "---",
    "type: selected-content",
    `created: ${yaml(created)}`,
    `source: ${yaml(source.toLowerCase())}`,
    `source_key: ${yaml(sourceKey)}`,
    `status: ${yaml(status || "selected")}`,
    `liked: ${yaml(liked || "unknown")}`,
    `rating: ${rating}`,
    `url: ${yaml(url)}`,
    ...yamlList("topics", links.topics),
    ...yamlList("projects", links.projects),
    ...yamlList("related", links.related),
    "tags:",
    ...tags.map((tag) => `  - ${tag}`),
    "---",
    `# ${title}`,
    "",
    "## Why This Is Here",
    "",
    summary || "_Selected from OrbitOS Intake DB._",
    "",
    "## Source",
    "",
    `- Source: ${source}`,
    sourceKey ? `- Source Key: ${sourceKey}` : "",
    url ? `- URL: ${url}` : "",
    "",
    "## Links",
    "",
    `- Topics: ${wikilinks(links.topics)}`,
    `- Projects: ${wikilinks(links.projects)}`,
    `- Related: ${wikilinks(links.related)}`,
    "",
    "## Revisit",
    "",
    "This note is eligible for weekly OLD SIGNAL review.",
    "",
    "## Content",
    "",
    raw || "_No raw content stored in Base._",
    "",
  ].filter((line) => line !== "").join("\n");
}

function writeIfChanged(file, content, dryRun) {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  if (dryRun) return true;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
  return true;
}

function commitAndPush(changed, noGit) {
  if (noGit || !changed) return;
  try {
    git(["add", "00_Inbox", "30_Research/Selected"], { stdio: "ignore" });
    try {
      git(["diff", "--cached", "--quiet"], { stdio: "ignore" });
      log("git: no promotion changes to commit");
      return;
    } catch {
      git(["commit", "-m", "intake: promote selected content"], { stdio: "ignore" });
      log("git: committed selected content");
    }
    git(["push", "origin", "main"], { stdio: "ignore" });
    log("git: pushed selected content");
  } catch (error) {
    log(`git: commit/push skipped: ${error.message}`);
  }
}

function promote({ dryRun = false, noGit = false } = {}) {
  const config = readConfig();
  const rows = listBaseRecords(config, Object.values(FIELD));
  let promoted = 0;
  let candidates = 0;
  for (const row of rows) {
    const fields = rowFields(row);
    if (!shouldPromote(fields)) continue;
    candidates += 1;
    const rel = promoteTarget(fields);
    const abs = path.join(VAULT, rel);
    const changed = writeIfChanged(abs, buildPromotionMarkdown(fields), dryRun);
    if (changed) promoted += 1;
    if (!dryRun) {
      runLarkCli([
        "base",
        "+record-upsert",
        "--as",
        "user",
        "--base-token",
        config.baseToken,
        "--table-id",
        config.tableId,
        "--record-id",
        rowId(row),
        "--json",
        JSON.stringify({
          [FIELD.status]: "promoted",
          [FIELD.obsidianPath]: rel,
          [FIELD.lastSync]: localDateTime(),
        }),
      ]);
    }
  }
  log(`promote: candidates=${candidates}; written=${promoted}; dry_run=${dryRun}`);
  commitAndPush(promoted, noGit || dryRun);
  markSuccess(dryRun ? "promote:dry-run" : "promote");
}

function status() {
  const config = readConfig();
  const state = readState();
  const rows = listBaseRecords(config, [FIELD.source, FIELD.status, FIELD.liked, FIELD.promote, FIELD.obsidianPath]);
  const counts = {};
  for (const row of rows) {
    const fields = rowFields(row);
    const source = cellText(fields[FIELD.source]) || "Unknown";
    const statusValue = cellText(fields[FIELD.status]) || "unknown";
    counts[source] = (counts[source] || 0) + 1;
    counts[`status:${statusValue}`] = (counts[`status:${statusValue}`] || 0) + 1;
    if (shouldPromote(fields)) counts.readyToPromote = (counts.readyToPromote || 0) + 1;
  }
  process.stdout.write(`${JSON.stringify({
	    baseUrl: config.baseUrl,
	    baseToken: config.baseToken,
	    tableId: config.tableId,
	    calibrationUntil: config.calibrationUntil || DEFAULT_CALIBRATION_UNTIL,
	    readwiseInMainView: readwiseInMainView(config),
	    total: rows.length,
	    counts,
	    lastRun: {
	      at: state.lastRunAt || null,
	      action: state.lastRunAction || null,
	      ok: Object.prototype.hasOwnProperty.call(state, "lastRunOk") ? state.lastRunOk : null,
	    },
	    lastError: state.lastError ? {
	      at: state.lastErrorAt || null,
	      action: state.lastErrorAction || null,
	      message: state.lastError.split("\n")[0],
	    } : null,
	  }, null, 2)}\n`);
}

function init(args) {
  const baseToken = args["base-token"];
  if (!baseToken) throw new Error("init requires --base-token");
  const tableId = createIntakeTable(baseToken);
  const views = createViews(baseToken, tableId);
	  const config = {
	    baseName: "OrbitOS Intake DB",
	    baseToken,
	    baseUrl: args["base-url"] || `https://my.feishu.cn/base/${baseToken}`,
	    tableName: "Content Inbox",
	    tableId,
	    calibrationUntil: DEFAULT_CALIBRATION_UNTIL,
	    views,
	    createdAt: nowIso(),
	    fieldNames: FIELD,
  };
  writeConfig(config);
  log(`init: table=${tableId}; config=${CONFIG_PATH}`);
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

async function main() {
  const args = parseArgs();
  const command = args._[0];
  if (!command || command === "help" || args.help) {
    usage();
    return;
  }
	  if (command === "init") init(args);
	  else if (command === "configure-views") configureViews({ dryRun: Boolean(args["dry-run"]), today: args.today || localDate() });
	  else if (command === "sync-vault") syncVault({ dryRun: Boolean(args["dry-run"]) });
	  else if (command === "promote") promote({ dryRun: Boolean(args["dry-run"]), noGit: Boolean(args["no-git"]) });
	  else if (command === "status") status();
  else throw new Error(`Unknown command: ${command}`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(thisFile)) {
  main().catch((error) => {
    markError(error, process.argv[2] || "unknown");
    log(`error: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

export {
  FIELD,
  SELECTS,
  baseRecordPayload,
  buildPromotionMarkdown,
	  inferRecord,
	  isTransientLarkError,
	  parseFrontmatter,
	  readwiseInMainView,
	  shouldPromote,
	  sourceFiles,
	  viewDefinitions,
	};
