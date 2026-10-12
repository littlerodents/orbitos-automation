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
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.mjs";
const _cfg = loadConfig();

const VAULT = _cfg.vault_path;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, "orbitos-intake-base.config.json");
const STATE_PATH = path.join(ROOT, "orbitos-intake-base.state.json");
const LARK_CLI = _cfg.lark_cli_path;
const TIME_ZONE = "Asia/Shanghai";
const DEFAULT_CALIBRATION_UNTIL = "2026-05-31";
const MAX_SELECTED_TOPICS = 3;
const DERIVATION_VERSION = 2;

const FIELD = {
  title: "标题",
  source: "来源",
  sourceId: "来源 ID",
  sourceKey: "Source Key",
  type: "类型",
  status: "状态",
  liked: "我喜欢的内容",
  promote: "进入 Obsidian",
  sourcePath: "源文件路径",
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
  weeklyEligible: "周视图有效",
  derivationVersion: "派生版本",
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
	  orbitos-intake-base.mjs ensure-schema [--dry-run]
	  orbitos-intake-base.mjs configure-views [--dry-run] [--today YYYY-MM-DD]
	  orbitos-intake-base.mjs sync-vault [--dry-run]
	  orbitos-intake-base.mjs refresh-derived [--dry-run]
	  orbitos-intake-base.mjs reconcile-records [--dry-run]
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
  return /TLS handshake timeout|timeout awaiting response|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|temporarily unavailable|network|1254291|write conflict/i.test(String(error?.message || error || ""));
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
      PATH: `/usr/local/bin:/opt/homebrew/bin:${homedir()}/.npm-global/bin:${process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"}`,
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
    { name: FIELD.sourcePath, type: "text", description: "Source Markdown path; separate from the promoted note path" },
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
    { name: FIELD.weeklyEligible, type: "checkbox" },
    { name: FIELD.derivationVersion, type: "number" },
    { name: FIELD.lastSync, type: "datetime", style: { format: "yyyy-MM-dd HH:mm" } },
  ];
}

function normalizeFieldListResponse(response) {
  const fields = response?.data?.fields || response?.data?.items || response?.fields || response?.items;
  return Array.isArray(fields) ? fields : [];
}

function ensureSchema(config = readConfig(), { dryRun = false } = {}) {
  const response = runLarkCli([
    "base",
    "+field-list",
    "--as",
    "user",
    "--base-token",
    config.baseToken,
    "--table-id",
    config.tableId,
    "--limit",
    "200",
  ]);
  const existingNames = new Set(normalizeFieldListResponse(response).map((field) => field.name));
  const missing = tableFields().filter((field) => !existingNames.has(field.name));
  for (const field of missing) {
    if (dryRun) continue;
    runLarkCli([
      "base",
      "+field-create",
      "--as",
      "user",
      "--base-token",
      config.baseToken,
      "--table-id",
      config.tableId,
      "--json",
      JSON.stringify(field),
    ]);
  }
  log(`ensure-schema: existing=${existingNames.size}; created=${dryRun ? 0 : missing.length}; missing=${missing.map((field) => field.name).join(",") || "none"}; dry_run=${dryRun}`);
  if (!dryRun) markSuccess("ensure-schema");
  return missing.map((field) => field.name);
}

function localDate(date = new Date()) {
  return localDateTime(date).slice(0, 10);
}

function readwiseInMainView(config = {}, today = localDate()) {
  return String(today) <= String(config.calibrationUntil || DEFAULT_CALIBRATION_UNTIL);
}

function shiftDate(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function viewDefinitions(config = {}, today = localDate()) {
  const mainSources = readwiseInMainView(config, today) ? ["YouMind", "Readwise"] : ["YouMind"];
  return [
    {
      name: "00 当前可读",
      aliases: ["Grid View"],
      filter: {
        logic: "and",
        conditions: [
          [FIELD.status, "intersects", ["raw", "to_review"]],
          [FIELD.weeklyEligible, "==", true],
        ],
      },
      visibleFields: [FIELD.title, FIELD.summary, FIELD.source, FIELD.sourceTime, FIELD.liked, FIELD.promote],
    },
    {
      name: "00 每周只看",
      filter: {
        logic: "and",
        conditions: [
          [FIELD.status, "intersects", ["raw", "to_review"]],
          [FIELD.source, "intersects", mainSources],
          [FIELD.weeklyEligible, "==", true],
          [FIELD.sourceTime, ">", `ExactDate(${shiftDate(today, -7)})`],
        ],
      },
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

  const alias = views.find((view) => (def.aliases || []).includes(viewName(view)));
  if (alias) {
    const id = viewId(alias) || viewName(alias);
    runLarkCli([
      "base",
      "+view-rename",
      "--as",
      "user",
      "--base-token",
      config.baseToken,
      "--table-id",
      config.tableId,
      "--view-id",
      id,
      "--name",
      def.name,
    ]);
    return id;
  }

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
  if (!dryRun) ensureSchema(config);
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
    .replace(/<EMPTYPARAGRAPH>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownText(body) {
  return body
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*>]\s+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function markdownSections(body) {
  const sections = [];
  let current = { level: 0, title: "", lines: [] };
  for (const line of String(body || "").split("\n")) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (current.title || current.lines.some((item) => item.trim())) sections.push(current);
      current = { level: heading[1].length, title: cleanInline(heading[2]), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.title || current.lines.some((item) => item.trim())) sections.push(current);
  return sections;
}

function compactText(value, max = 280) {
  return cleanInline(String(value || "").replace(/\s+/g, " ")).slice(0, max).trim();
}

function stripTerminalPunctuation(value) {
  return String(value || "").replace(/[。！？!?；;：:,，.]+$/u, "").trim();
}

function sectionText(section) {
  return compactText((section?.lines || []).map((line) => line.replace(/^\s*[-*]\s+/, "")).join("\n"), 12000);
}

function metadataFreeText(body) {
  const sections = markdownSections(body);
  const useful = [];
  for (const section of sections) {
    const name = section.title.toLowerCase();
    if (section.level === 1) continue;
    if (["source", "来源", "metadata", "元数据"].includes(name)) continue;
    const text = sectionText(section)
      .replace(/(?:^|\s)(?:Board|YouMind ID|Type|URL|Author|Published|Captured|Updated):\s*\S*/gi, " ")
      .trim();
    if (text) useful.push(text);
  }
  if (useful.length) return useful.join("\n\n").trim();

  return compactText(String(body || "")
    .split("\n")
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .filter((line) => !/^\s*[-*]\s*(?:Board|YouMind ID|Type|URL|Author|Published|Captured|Updated):/i.test(line))
    .join("\n"), 12000);
}

function hasMeaningfulContent(value) {
  const semantic = cleanInline(value)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b(?:View Tweet|Read more|Source)\b/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return semantic.length >= 8;
}

function headlineFromText(value, max = 100) {
  const compact = cleanInline(value).replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
  const sentence = compact.match(/^(.{8,100}?)[.!?。！？](?=\s|[A-Z\p{Script=Han}]|$)/u)?.[1];
  return stripTerminalPunctuation(sentence || compact.slice(0, max));
}

function researchTopic(fileName, fallbackTitle, sections) {
  const baseName = path.basename(String(fileName || ""), path.extname(String(fileName || "")));
  const fromFile = baseName
    .replace(/^#(?:result|task)\s*/i, "")
    .replace(/^C\d+\s*/i, "")
    .replace(/^无新增\s*/i, "")
    .replace(/^researcher\s*/i, "")
    .trim();
  if (/^#(?:result|task)\b/i.test(baseName) && fromFile) return fromFile;
  const heading = sections.find((section) => section.level === 1 && !/^#?(?:result|task)\b/i.test(section.title));
  if (heading?.title) return heading.title;
  if (fromFile) return fromFile;
  return cleanInline(fallbackTitle)
    .replace(/^#?(?:result|task)\s*/i, "")
    .replace(/^C\d+\s*/i, "")
    .replace(/^无新增\s*/i, "")
    .replace(/^researcher\s*/i, "")
    .trim();
}

function cleanResearchLine(line) {
  return cleanInline(String(line || "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\d+\.\s*(?:\*\*)?[^：:]+(?:\*\*)?[：:]\s*/, ""));
}

function deriveResearchDisplay({ body, fileName, fallbackTitle }) {
  const sections = markdownSections(body);
  const signal = `${fileName || ""}\n${fallbackTitle || ""}\n${body || ""}`;
  const isTask = /(?:^|[/\s])#task\b/im.test(signal);
  const isResult = /(?:^|[/\s])#result\b/im.test(signal);
  if (!isTask && !isResult) return null;

  const topic = researchTopic(fileName, fallbackTitle, sections) || "未命名研究主题";
  const confidence = signal.match(/#result\s+(C\d+)/i)?.[1]?.toUpperCase() || "";
  const noNew = /无新增|完全重复\s*\(?0%?\)?/i.test(signal);
  const lines = String(body || "").split("\n").map(cleanResearchLine).filter(Boolean);
  const direction = lines.find((line) => /^搜索方向[：:]/.test(line));
  const resultLine = lines.find((line) => /^搜索(?!方向)[^：:]*?(?:未找到|结果)/.test(line))
    || lines.find((line) => /已有知识完全重复|无新增价值/.test(line));
  const action = lines.find((line) => /无需任何操作|继续忽略|可行动/.test(line));
  const summary = compactText([resultLine, direction, action].filter(Boolean).join("；") || metadataFreeText(body));

  if (isTask) {
    return {
      title: `[待研究] ${topic}`,
      summary: compactText(direction || metadataFreeText(body) || `待研究：${topic}`),
      topic,
      contentText: metadataFreeText(body),
      weeklyEligible: true,
    };
  }
  return {
    title: noNew ? `[无新增] ${topic}` : `[低置信度 ${confidence || "待核验"}] ${topic}`,
    summary,
    topic,
    contentText: metadataFreeText(body),
    weeklyEligible: !noNew,
  };
}

function deriveFilterDisplay({ body }) {
  const sections = markdownSections(body);
  const candidates = sections.filter((section) => section.level === 2).map((section) => {
    const bullets = section.lines
      .filter((line) => /^\s*[-*]\s+/.test(line))
      .map((line) => cleanInline(line.replace(/^\s*[-*]\s+/, "")))
      .filter(Boolean);
    return { title: section.title, bullets };
  }).filter((section) => section.bullets.length && !section.bullets.every((line) => /无新增/.test(line)));

  const first = candidates[0];
  if (!first) {
    return {
      title: "[无新增] Filter 摘要",
      summary: "本轮筛选没有发现可前置的新信息。",
      topic: "",
      contentText: metadataFreeText(body),
      weeklyEligible: false,
    };
  }
  const insights = first.bullets.map((line) => {
    const parts = line.split(/\s+[—–]\s+/);
    return parts.length > 1 ? parts.slice(1).join(" — ") : line;
  });
  const firstInsight = stripTerminalPunctuation(insights[0]);
  return {
    title: `${first.title}：${firstInsight}`.slice(0, 180),
    summary: compactText(insights.slice(0, 2).join("；")),
    topic: first.title,
    contentText: metadataFreeText(body),
    weeklyEligible: true,
  };
}

function deriveReminderDisplay({ body }) {
  const sections = markdownSections(body);
  const actions = sections
    .filter((section) => /今天必须推进/.test(section.title))
    .flatMap((section) => section.lines)
    .filter((line) => /^\s*\d+\.\s+/.test(line))
    .map((line) => cleanInline(line
      .replace(/^\s*\d+\.\s*/, "")
      .replace(/^P\d+\s+[^：:]+[：:]\s*/, "")))
    .filter(Boolean);
  if (!actions.length) return null;
  const first = headlineFromText(actions[0], 120);
  return {
    title: `超级个体提醒：${first}`.slice(0, 180),
    summary: compactText(actions.slice(0, 2).join("；")),
    topic: "超级个体提醒",
    contentText: metadataFreeText(body),
    weeklyEligible: true,
  };
}

function deriveDisplayFields({ data = {}, body = "", fileName = "", fallbackTitle = "" } = {}) {
  const research = deriveResearchDisplay({ body, fileName, fallbackTitle });
  if (research) return research;

  if (String(data.type || "") === "filter-digest" || /^filter-/i.test(path.basename(fileName))) {
    return deriveFilterDisplay({ body });
  }

  if (String(data.capture || "") === "flag" && /超级个体提醒/.test(`${fallbackTitle}\n${body}`)) {
    const reminder = deriveReminderDisplay({ body });
    if (reminder) return reminder;
  }

  const sections = markdownSections(body);
  const heading = sections.find((section) => section.level === 1)?.title;
  const baseTitle = cleanInline(data.title || data["Full Title"] || heading || fallbackTitle || "Untitled").slice(0, 120);
  const noText = /_?No text content returned by YouMind API\.?_?/i.test(body);
  const isYouMindGroup = String(data.youmind_type || "").toLowerCase() === "group";
  if (isYouMindGroup) {
    const board = cleanInline(data.board || "YouMind");
    return {
      title: `[空分组] ${board} / ${baseTitle}`,
      summary: "YouMind 分组占位，API 未返回正文；已从每周视图排除。",
      topic: board,
      contentText: "",
      weeklyEligible: false,
    };
  }
  if (noText) {
    return {
      title: `[无正文] ${baseTitle}`,
      summary: "YouMind API 未返回正文；已从每周视图排除。",
      topic: cleanInline(data.board || ""),
      contentText: "",
      weeklyEligible: false,
    };
  }

  const description = sections.find((section) => section.level === 2 && /^description$/i.test(section.title));
  const highlights = sections.find((section) => section.level === 2 && /^(highlights|高亮)$/i.test(section.title));
  const content = sections.find((section) => section.level === 2 && /^(content|正文)$/i.test(section.title));
  const contentText = sectionText(content) || sectionText(highlights) || sectionText(description) || metadataFreeText(body);
  const summarySource = sectionText(description) || sectionText(highlights) || contentText;
  const weeklyEligible = hasMeaningfulContent(contentText) || hasMeaningfulContent(summarySource);
  if (/(?:本期|本轮).{0,30}无(?:符合|新增|保留)[^。.!?]{0,30}(?:内容|标准|价值)/i.test(summarySource)) {
    return {
      title: `[无新增] ${baseTitle}`,
      summary: summarize(baseTitle, summarySource),
      topic: "",
      contentText,
      weeklyEligible: false,
    };
  }
  const displayTitle = /^(?:\[?no title\]?|untitled(?: youmind item)?)$/i.test(baseTitle)
    ? (headlineFromText(summarySource) || "[无标题] 待补充")
    : baseTitle;
  return {
    title: displayTitle,
    summary: weeklyEligible ? summarize(displayTitle, summarySource) : "仅包含链接、图片或元数据；已从每周视图排除。",
    topic: "",
    contentText,
    weeklyEligible,
  };
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
  const fallbackTitle = String(data.title || data["Full Title"] || titleFromBody(body, path.basename(file, ".md")));
  const derived = deriveDisplayFields({ data, body, fileName: path.basename(file), fallbackTitle });
  const title = derived.title;

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
    sourceId = rel;
  }
  if (data.source === "flomo" || lowerRel.includes("00_inbox/flomo/")) {
    source = "Flomo";
    type = data.flomo_type || "quick-thought";
    sourceId = data.flomo_id || rel;
  }
  if (String(data.type || "").includes("brief-feedback")) {
    type = "brief-feedback";
  }

  const tags = normalizeTags([data.tags, data.tag, source.toLowerCase(), type, data.board, data.project]);
  const aiTags = inferTags(`${title}\n${text}`).join(", ");
  const sourceTime = normalizeDateTime(data.created || data.date || data.time || statSync(file).mtime.toISOString());
  const url = data.url || extractMetadataUrl(body) || "";
  const author = data.author || extractMetadataLine(body, "Author") || data.from || "";
  const summary = derived.summary;

  return {
    title,
    source,
    sourceId: String(sourceId || rel),
    sourceKey: `${source}:${String(sourceId || rel)}`,
    type,
    status: "raw",
    liked: "unknown",
    promote: false,
    sourcePath: rel,
    obsidianPath: "",
    url: String(url || ""),
    author: String(author || ""),
    sourceTime,
    importedAt: localDateTime(),
    tags: tags.join(", "),
    aiTags,
    project: String(data.project || ""),
    topic: derived.topic,
    summary,
    raw: truncate(derived.contentText || text),
    hash: sha(markdown),
    weeklyEligible: derived.weeklyEligible,
    derivationVersion: DERIVATION_VERSION,
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
  const compact = cleanInline(text)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bView Tweet\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    [FIELD.sourcePath]: record.sourcePath,
    [FIELD.url]: record.url,
    [FIELD.author]: record.author,
    [FIELD.tags]: record.tags,
    [FIELD.aiTags]: record.aiTags,
    [FIELD.project]: record.project,
    [FIELD.topic]: record.topic,
    [FIELD.summary]: record.summary,
    [FIELD.raw]: record.raw,
    [FIELD.hash]: record.hash,
    [FIELD.weeklyEligible]: record.weeklyEligible,
    [FIELD.derivationVersion]: record.derivationVersion,
    [FIELD.lastSync]: record.lastSync,
  };
  if (record.sourceTime) payload[FIELD.sourceTime] = record.sourceTime;
  if (includeUserFields) {
    payload[FIELD.obsidianPath] = record.obsidianPath;
    if (record.importedAt) payload[FIELD.importedAt] = record.importedAt;
    payload[FIELD.status] = record.status;
    payload[FIELD.liked] = record.liked;
    payload[FIELD.promote] = record.promote;
  }
  return payload;
}

function listBaseRecords(config, fields = [FIELD.sourceKey, FIELD.hash, FIELD.sourcePath, FIELD.obsidianPath, FIELD.derivationVersion, FIELD.status, FIELD.liked, FIELD.promote]) {
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

function sourcePathFromFields(fields) {
  const explicit = cellText(fields[FIELD.sourcePath]);
  if (explicit) return explicit;
  const status = cellText(fields[FIELD.status]);
  const legacyPath = cellText(fields[FIELD.obsidianPath]);
  if (legacyPath && status !== "promoted") return legacyPath;
  const sourceKey = cellText(fields[FIELD.sourceKey]);
  const tail = sourceKey.slice(sourceKey.indexOf(":") + 1).replace(/:[0-9a-f]{24}$/i, "");
  const pathMatch = tail.match(/(?:^|.*?)(00_Inbox\/.*\.md|30_Research\/.*\.md)$/);
  return pathMatch?.[1] || (tail.includes("/") && tail.endsWith(".md") ? tail : "");
}

function classifyRecordLifecycle(fields, currentKeys, currentPaths) {
  const key = cellText(fields[FIELD.sourceKey]);
  if (currentKeys.has(key)) return "current";
  const sourcePath = sourcePathFromFields(fields);
  return sourcePath && currentPaths.has(sourcePath) ? "historical" : "removed";
}

function legacyMarkdown(fields) {
  const title = cellText(fields[FIELD.title]);
  const raw = cellText(fields[FIELD.raw]);
  const lines = raw.split("\n");
  const normalized = lines.map((line, index) => {
    const trimmed = line.trim();
    if (index === 0 && trimmed === title) return `# ${title}`;
    if (/^(Source|Metadata|Description|Highlights|Content|来源|元数据|高亮|正文)$/i.test(trimmed)) return `## ${trimmed}`;
    return line;
  });
  if (!normalized.some((line) => /^#\s+/.test(line)) && title) normalized.unshift(`# ${title}`, "");
  return normalized.join("\n");
}

function boardFromSourcePath(sourcePath) {
  const parts = String(sourcePath || "").split(path.sep);
  const index = parts.findIndex((part) => part === "YouMind");
  return index >= 0 ? parts[index + 1] || "YouMind" : "YouMind";
}

function deriveExistingFields(fields) {
  const sourcePath = sourcePathFromFields(fields);
  const fileName = path.basename(sourcePath || cellText(fields[FIELD.sourceKey]) || "record.md");
  const raw = cellText(fields[FIELD.raw]);
  const source = cellText(fields[FIELD.source]);
  const noText = /No text content returned by YouMind API/i.test(raw);
  const data = {
    source: source.toLowerCase(),
    type: /^filter-/i.test(fileName) ? "filter-digest" : "",
    youmind_type: source === "YouMind" && noText ? "group" : "",
    board: boardFromSourcePath(sourcePath),
  };
  const derived = deriveDisplayFields({
    data,
    body: legacyMarkdown(fields),
    fileName,
    fallbackTitle: cellText(fields[FIELD.title]),
  });
  return {
    [FIELD.title]: derived.title,
    [FIELD.topic]: derived.topic,
    [FIELD.summary]: derived.summary,
    [FIELD.raw]: truncate(derived.contentText || raw),
    [FIELD.sourcePath]: sourcePath,
    [FIELD.weeklyEligible]: derived.weeklyEligible,
    [FIELD.derivationVersion]: DERIVATION_VERSION,
    [FIELD.lastSync]: localDateTime(),
  };
}

function sameCellValue(actual, desired) {
  if (desired === undefined) return true;
  if (desired === null) return !cellText(actual);
  if (typeof desired === "boolean") return String(cellText(actual)).toLowerCase() === String(desired);
  if (typeof desired === "number") return Number(cellText(actual)) === desired;
  let actualText = cellText(actual);
  if (/^https?:\/\//i.test(String(desired))) {
    actualText = actualText.match(/^\[[^\]]*]\((https?:\/\/[^)]+)\)$/i)?.[1] || actualText;
  }
  const desiredText = String(desired);
  if (actualText === desiredText) return true;
  // 日期时间：Base 存 ISO（2026-05-11T08:00:00.000+08:00），本地算出的是
  // "YYYY-MM-DD HH:mm:ss"（Asia/Shanghai）——按时刻比较，避免每轮把全部行判成 diff。
  const actualEpoch = dateTimeEpoch(actualText);
  const desiredEpoch = dateTimeEpoch(desiredText);
  return actualEpoch !== null && desiredEpoch !== null && actualEpoch === desiredEpoch;
}

function dateTimeEpoch(text) {
  const t = String(text).trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:?\d{2}|Z)?$/.test(t)) return null;
  let normalized = t.replace(" ", "T");
  if (!/[+-]\d{2}:?\d{2}$|Z$/i.test(normalized)) normalized += "+08:00";
  const epoch = Date.parse(normalized);
  return Number.isFinite(epoch) ? epoch : null;
}

function needsRecordUpdate(fields, payload) {
  return recordDiffFields(fields, payload).length > 0;
}

function recordDiffFields(fields, payload) {
  return Object.entries(payload).filter(([name, value]) => !sameCellValue(fields[name], value)).map(([name]) => name);
}

function refreshDerived({ dryRun = false } = {}) {
  return reconcileRecords({ dryRun });
}

function hasSelectionSignal(fields) {
  const status = cellText(fields[FIELD.status]);
  const liked = cellText(fields[FIELD.liked]);
  const promote = String(cellText(fields[FIELD.promote])).toLowerCase() === "true";
  return status === "selected" || liked === "strong_like" || promote;
}

function stripLifecyclePrefix(title) {
  return String(title || "").replace(/^\[(?:历史版本|源文件已移除|已归档)]\s*/, "").trim();
}

function reconcileRecords({ dryRun = false } = {}) {
  const config = readConfig();
  if (!dryRun) ensureSchema(config);
  const rows = listBaseRecords(config, Object.values(FIELD));
  const localRecords = sourceFiles().map((file) => inferRecord(file));
  const byKey = new Map(localRecords.map((record) => [record.sourceKey, record]));
  const currentKeys = new Set(byKey.keys());
  const currentPaths = new Set(localRecords.map((record) => record.sourcePath));
  const counts = { current: 0, historical: 0, removed: 0, updated: 0, unchanged: 0, protected: 0 };
  const diffCounts = {};
  const diffSamples = [];

  for (const row of rows) {
    const fields = rowFields(row);
    const lifecycle = classifyRecordLifecycle(fields, currentKeys, currentPaths);
    counts[lifecycle] += 1;
    let payload;

    if (lifecycle === "current") {
      payload = baseRecordPayload(byKey.get(cellText(fields[FIELD.sourceKey])), false);
      const legacyPromotionPath = cellText(fields[FIELD.obsidianPath]);
      if (legacyPromotionPath && cellText(fields[FIELD.status]) !== "promoted") payload[FIELD.obsidianPath] = null;
    } else {
      const derived = deriveExistingFields(fields);
      const baseTitle = stripLifecyclePrefix(derived[FIELD.title] || cellText(fields[FIELD.title]) || "Untitled");
      const prefix = lifecycle === "historical" ? "历史版本" : "源文件已移除";
      const reason = lifecycle === "historical"
        ? "该来源已有当前版本，本条保留作历史追溯。"
        : "本地源文件已不存在，本条保留作历史追溯。";
      payload = {
        ...derived,
        [FIELD.title]: `[${prefix}] ${baseTitle}`.slice(0, 180),
        [FIELD.summary]: compactText(`${reason}${derived[FIELD.summary] || ""}`),
        [FIELD.weeklyEligible]: false,
      };
      if (!hasSelectionSignal(fields) && ["raw", "to_review"].includes(cellText(fields[FIELD.status]))) {
        payload[FIELD.status] = "archived";
      } else if (hasSelectionSignal(fields)) {
        counts.protected += 1;
      }
      if (cellText(fields[FIELD.obsidianPath]) && cellText(fields[FIELD.status]) !== "promoted") payload[FIELD.obsidianPath] = null;
    }

    delete payload[FIELD.lastSync];
    const diffFields = recordDiffFields(fields, payload);
    if (!diffFields.length) {
      counts.unchanged += 1;
      continue;
    }
    for (const field of diffFields) diffCounts[field] = (diffCounts[field] || 0) + 1;
    if (dryRun && diffSamples.length < 8 && diffFields.some((field) => [FIELD.title, FIELD.topic].includes(field))) {
      diffSamples.push({
        lifecycle,
        key: cellText(fields[FIELD.sourceKey]),
        fields: diffFields,
        title: [cellText(fields[FIELD.title]), payload[FIELD.title]],
        topic: [cellText(fields[FIELD.topic]), payload[FIELD.topic]],
      });
    }
    if (!dryRun) {
      payload[FIELD.lastSync] = localDateTime();
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
        JSON.stringify(payload),
      ], { attempts: 3 });
    }
    counts.updated += 1;
  }

  const diffs = Object.entries(diffCounts).sort((a, b) => b[1] - a[1]).map(([field, count]) => `${field}:${count}`).join(",") || "none";
  log(`reconcile-records: current=${counts.current}; historical=${counts.historical}; removed=${counts.removed}; updated=${counts.updated}; unchanged=${counts.unchanged}; protected=${counts.protected}; diffs=${diffs}; dry_run=${dryRun}`);
  if (diffSamples.length) log(`reconcile-records: diff_samples=${JSON.stringify(diffSamples)}`);
  if (!dryRun) markSuccess("reconcile-records");
}

function syncVault({ dryRun = false } = {}) {
  const config = readConfig();
  if (!dryRun) ensureSchema(config);
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
    const samePath = sourcePathFromFields(fields) === record.sourcePath;
    const sameVersion = Number(cellText(fields[FIELD.derivationVersion])) === DERIVATION_VERSION;
    const needsPathMigration = Boolean(cellText(fields[FIELD.obsidianPath])) && cellText(fields[FIELD.status]) !== "promoted";
    if (sameHash && samePath && sameVersion && !needsPathMigration) {
      unchanged += 1;
      continue;
    }
    if (!dryRun) {
      const payload = baseRecordPayload(record, false);
      if (needsPathMigration) payload[FIELD.obsidianPath] = null;
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
        JSON.stringify(payload),
      ], { attempts: 3 });
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
	  else if (command === "ensure-schema") ensureSchema(readConfig(), { dryRun: Boolean(args["dry-run"]) });
	  else if (command === "configure-views") configureViews({ dryRun: Boolean(args["dry-run"]), today: args.today || localDate() });
	  else if (command === "sync-vault") syncVault({ dryRun: Boolean(args["dry-run"]) });
	  else if (command === "refresh-derived") refreshDerived({ dryRun: Boolean(args["dry-run"]) });
	  else if (command === "reconcile-records") reconcileRecords({ dryRun: Boolean(args["dry-run"]) });
	  else if (command === "promote") promote({ dryRun: Boolean(args["dry-run"]), noGit: Boolean(args["no-git"]) });
	  else if (command === "status") status();
  else throw new Error(`Unknown command: ${command}`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(thisFile)) {
  main().catch((error) => {
    try {
      markError(error, process.argv[2] || "unknown");
    } catch (stateError) {
      log(`warn: could not persist error state: ${stateError.message}`);
    }
    log(`error: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

export {
	  CONFIG_PATH,
	  DERIVATION_VERSION,
	  FIELD,
	  ROOT,
	  SELECTS,
	  STATE_PATH,
  baseRecordPayload,
  buildPromotionMarkdown,
	  classifyRecordLifecycle,
	  deriveDisplayFields,
	  ensureSchema,
	  inferRecord,
	  isTransientLarkError,
	  parseFrontmatter,
	  readwiseInMainView,
	  refreshDerived,
	  sameCellValue,
	  shouldPromote,
	  sourcePathFromFields,
	  sourceFiles,
	  viewDefinitions,
	};
