#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VAULT = "/Users/evander/Obsidian/OrbitOS";
const OUT_DIR = path.join(VAULT, "00_Inbox", "Flomo");

function nowIso() {
  return new Date().toISOString();
}

function log(message) {
  process.stdout.write(`[${nowIso()}] ${message}\n`);
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
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function usage() {
  process.stdout.write(`Usage:
  flomo-import.mjs <flomo-export.html|json|md> [--dry-run] [--no-git]

Imports Flomo export files into OrbitOS/00_Inbox/Flomo.
After import, the OrbitOS intake loop will sync those notes into Feishu Base.
`);
}

function localDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
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

function dayString(date = new Date()) {
  return localDateTime(date).slice(0, 10);
}

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function slugify(value, fallback = "flomo") {
  const cleaned = String(value || fallback)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#^[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70);
  return cleaned || fallback;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripHtml(value) {
  return decodeHtml(String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeDate(value) {
  if (!value) return new Date();
  const raw = String(value).trim();
  const cleaned = raw
    .replace("年", "-")
    .replace("月", "-")
    .replace("日", "")
    .replace(/^(\d{4}-\d{1,2}-\d{1,2})\s+(\d{1,2}:\d{2})(?::\d{2})?$/, "$1T$2:00+08:00");
  const date = new Date(cleaned);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function memoFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const content = obj.content || obj.text || obj.memo || obj.description || obj.html;
  if (!content || typeof content !== "string") return null;
  const cleaned = stripHtml(content);
  if (!cleaned || cleaned.length < 2) return null;
  const created = obj.created_at || obj.createdAt || obj.create_time || obj.created || obj.time || obj.updated_at;
  const id = obj.id || obj.slug || obj.memo_id || sha(`${created || ""}:${cleaned}`);
  return {
    id: String(id),
    content: cleaned,
    created: normalizeDate(created),
    tags: [...new Set([...cleaned.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]))],
  };
}

function walkJson(value, out = []) {
  const memo = memoFromObject(value);
  if (memo) out.push(memo);
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) walkJson(item, out);
  }
  return out;
}

function tryParseJsonExport(text) {
  try {
    return walkJson(JSON.parse(text));
  } catch {
    return [];
  }
}

function tryParseEmbeddedJson(text) {
  const candidates = [];
  const nextData = text.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextData) candidates.push(decodeHtml(nextData[1]));
  for (const match of text.matchAll(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/g)) candidates.push(match[1]);
  for (const candidate of candidates) {
    const memos = tryParseJsonExport(candidate);
    if (memos.length) return memos;
  }
  return [];
}

function parsePlainTextFallback(text) {
  const body = stripHtml(text);
  const chunks = body
    .split(/\n\s*(?=\d{4}[-年]\d{1,2}[-月]\d{1,2}|20\d{2}\/\d{1,2}\/\d{1,2})/g)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 5);

  return chunks.map((chunk) => {
    const dateMatch = chunk.match(/^(\d{4}(?:[-年\/]\d{1,2}){2}(?:日)?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/);
    const content = dateMatch ? chunk.slice(dateMatch[0].length).trim() : chunk;
    return {
      id: sha(chunk),
      content,
      created: normalizeDate(dateMatch?.[1]),
      tags: [...new Set([...content.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]))],
    };
  }).filter((memo) => memo.content.length > 2);
}

function extractFlomoMemosFromText(text) {
  const directJson = tryParseJsonExport(text);
  if (directJson.length) return uniqueMemos(directJson);
  const embeddedJson = tryParseEmbeddedJson(text);
  if (embeddedJson.length) return uniqueMemos(embeddedJson);
  return uniqueMemos(parsePlainTextFallback(text));
}

function uniqueMemos(memos) {
  const seen = new Set();
  const out = [];
  for (const memo of memos) {
    const key = memo.id || sha(memo.content);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...memo, id: key });
  }
  return out;
}

function yaml(value) {
  if (value == null || value === "") return '""';
  return JSON.stringify(String(value));
}

function buildMarkdown(memo) {
  const title = memo.content.split("\n").find(Boolean)?.slice(0, 90) || "Flomo Memo";
  return [
    "---",
    "source: flomo",
    `flomo_id: ${yaml(memo.id)}`,
    `date: ${yaml(dayString(memo.created))}`,
    `created: ${yaml(localDateTime(memo.created))}`,
    "status: raw",
    "tags:",
    "  - flomo",
    ...memo.tags.map((tag) => `  - ${tag}`),
    "---",
    `# ${title}`,
    "",
    "## Content",
    "",
    memo.content,
    "",
  ].join("\n");
}

function targetPath(memo) {
  const title = slugify(memo.content.split("\n").find(Boolean), "flomo");
  return path.join(OUT_DIR, `${dayString(memo.created)} ${title} ${sha(memo.id)}.md`);
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

function git(args, options = {}) {
  const output = execFileSync("git", ["-C", VAULT, ...args], {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function commitAndPush(changed, noGit) {
  if (noGit || !changed) return;
  try {
    git(["add", "00_Inbox/Flomo"], { stdio: "ignore" });
    try {
      git(["diff", "--cached", "--quiet"], { stdio: "ignore" });
      log("git: no Flomo changes to commit");
      return;
    } catch {
      git(["commit", "-m", "flomo: import exported memos"], { stdio: "ignore" });
      log("git: committed Flomo import");
    }
    git(["push", "origin", "main"], { stdio: "ignore" });
    log("git: pushed Flomo import");
  } catch (error) {
    log(`git: commit/push skipped: ${error.message}`);
  }
}

function main() {
  const args = parseArgs();
  const file = args._[0];
  if (!file || args.help) {
    usage();
    return;
  }
  if (!existsSync(file)) throw new Error(`Flomo export not found: ${file}`);
  const text = readFileSync(file, "utf8");
  const memos = extractFlomoMemosFromText(text);
  let changed = 0;
  for (const memo of memos) {
    if (writeIfChanged(targetPath(memo), buildMarkdown(memo), Boolean(args["dry-run"]))) changed += 1;
  }
  log(`flomo-import: memos=${memos.length}; changed=${changed}; dry_run=${Boolean(args["dry-run"])}`);
  commitAndPush(changed, Boolean(args["no-git"] || args["dry-run"]));
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))) {
  try {
    main();
  } catch (error) {
    log(`error: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

export { extractFlomoMemosFromText };
