#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./lib/config.mjs";

const _cfg = loadConfig();
const VAULT = _cfg.vault_path;
const LARK_CLI = _cfg.lark_cli_path;
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const NO_GIT = args.has("--no-git") || DRY_RUN;

function nowIso() {
  return new Date().toISOString();
}

function log(message) {
  process.stdout.write(`[${nowIso()}] ${message}\n`);
}

function runLarkCli(argv) {
  const result = spawnSync(LARK_CLI, argv, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:${homedir()}/.npm-global/bin:${process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"}`,
      LARK_CLI_NO_PROXY: "1",
    },
    maxBuffer: 20 * 1024 * 1024,
  });

  const combined = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.error) {
    throw new Error(`${LARK_CLI} ${argv.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${LARK_CLI} ${argv.join(" ")} failed (${result.status}): ${combined.slice(0, 1000)}`);
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

function slugify(value, fallback = "feishu") {
  const cleaned = String(value || fallback)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#^[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
  return cleaned || fallback;
}

function safeYaml(value) {
  if (value == null || value === "") return '""';
  return JSON.stringify(String(value));
}

function parseFeishuTime(value) {
  if (!value) return new Date();
  if (/^\d+$/.test(String(value))) {
    const n = Number(value);
    return new Date(n > 10_000_000_000 ? n : n * 1000);
  }
  const normalized = String(value).replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})?$/, "$1T$2:00+08:00");
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function localDateParts(date) {
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
  return parts;
}

function dateString(date) {
  const p = localDateParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function timestampString(date) {
  const p = localDateParts(date);
  return `${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}${p.second}`;
}

function flattenPostBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  const out = [];
  for (const block of blocks) {
    if (!Array.isArray(block)) continue;
    for (const el of block) {
      if (!el || typeof el !== "object") continue;
      if (el.tag === "text") out.push(String(el.text || ""));
      else if (el.tag === "at") out.push(`@${el.user_id || el.name || ""}`);
      else if (el.tag === "a") out.push(String(el.text || el.href || ""));
      else if (el.tag === "br") out.push("\n");
      else if (typeof el.text === "string") out.push(el.text);
    }
    out.push("\n");
  }
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function stripContent(content) {
  if (!content) return "";
  let text = String(content).trim();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") {
      text = parsed;
    } else if (parsed.text) {
      text = parsed.text;
    } else if (parsed.content) {
      text = parsed.content;
    } else if (parsed.zh_cn) {
      // post-type rich message: {zh_cn: {title, content: [[...blocks...]]}}
      const post = parsed.zh_cn || parsed.en_us || parsed;
      const title = post.title ? `${post.title}\n\n` : "";
      const body = typeof post.content === "string" ? post.content : flattenPostBlocks(post.content);
      text = title + body;
    }
  } catch {
    // The shortcut / mget already renders many message types as plain strings.
  }
  return text
    .replace(/<at\b[^>]*>(.*?)<\/at>/g, "@$1")
    .replace(/<br\s*\/?>/g, "\n")
    .trim();
}

function titleFromMessage(message) {
  const content = stripContent(message.content);
  if (!content) return `${message.msg_type || "message"} ${message.message_id || ""}`.trim();
  return content.split(/\n/)[0].slice(0, 80);
}

function targetPath(message) {
  const created = parseFeishuTime(message.create_time);
  const shortId = String(message.message_id || "").split("_").at(-1)?.slice(-12) || "message";
  const slug = slugify(titleFromMessage(message), "feishu");
  return path.join(VAULT, "00_Inbox", `feishu-${timestampString(created)}-${slug}-${shortId}.md`);
}

function buildMarkdown(message, flag) {
  const created = parseFeishuTime(message.create_time || flag?.create_time || flag?.update_time);
  const content = stripContent(message.content);
  const title = titleFromMessage(message);
  const sender = message.sender?.name || message.sender?.id || "";
  const chatName = message.chat_name || message.chat?.name || "";

  const lines = [
    "---",
    "source: feishu",
    "capture: flag",
    `date: ${safeYaml(dateString(created))}`,
    `created: ${safeYaml(message.create_time || "")}`,
    `message_id: ${safeYaml(message.message_id || flag?.item_id || "")}`,
    `chat_id: ${safeYaml(message.chat_id || "")}`,
    `chat_name: ${safeYaml(chatName)}`,
    `sender: ${safeYaml(sender)}`,
    `message_type: ${safeYaml(message.msg_type || "")}`,
    `message_url: ${safeYaml(message.message_app_link || "")}`,
    `flag_type: ${safeYaml(flag?.flag_type || "")}`,
    `flag_updated: ${safeYaml(flag?.update_time || "")}`,
    "status: raw",
    "tags:",
    "  - feishu",
    "  - quick-capture",
    "---",
    `# ${title}`,
    "",
    "## Source",
    "",
    `- Sender: ${sender}`,
    chatName ? `- Chat: ${chatName}` : `- Chat ID: ${message.chat_id || ""}`,
    `- Message ID: ${message.message_id || flag?.item_id || ""}`,
    message.message_app_link ? `- Link: ${message.message_app_link}` : "",
    "",
    "## Content",
    "",
    content || `_${message.msg_type || "message"} content is not text; open the Feishu link for the original._`,
    "",
  ].filter((line) => line !== "");

  return lines.join("\n");
}

function writeIfChanged(file, content) {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  if (DRY_RUN) return true;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
  return true;
}

function preflightGitPull() {
  if (NO_GIT) return;
  try {
    git(["fetch", "--prune", "origin", "main"], { stdio: "ignore" });
    const dirty = git(["status", "--porcelain"]);
    if (!dirty) git(["pull", "--ff-only", "origin", "main"], { stdio: "ignore" });
    else log("git: skip pre-pull because vault has local changes");
  } catch (error) {
    log(`git: pre-pull skipped: ${error.message}`);
  }
}

function commitAndPush(changed) {
  if (NO_GIT) return;
  if (!changed) {
    log("git: no Feishu changes to commit");
    return;
  }
  try {
    git(["add", "00_Inbox/feishu-*.md"], { stdio: "ignore" });
    try {
      git(["diff", "--cached", "--quiet"], { stdio: "ignore" });
      log("git: no Feishu changes to commit");
      return;
    } catch {
      git(["commit", "-m", "feishu: sync flagged quick captures"], { stdio: "ignore" });
      log("git: committed Feishu captures");
    }
    git(["push", "origin", "main"], { stdio: "ignore" });
    log("git: pushed Feishu captures");
  } catch (error) {
    log(`git: commit/push skipped: ${error.message}`);
  }
}

function getMessageMap(flagResponse) {
  const messages = flagResponse?.data?.messages || [];
  const map = new Map();
  for (const message of messages) {
    if (message.message_id) map.set(message.message_id, message);
  }
  return map;
}

function fetchMissingMessages(ids) {
  if (!ids.length) return new Map();
  const output = runLarkCli(["im", "+messages-mget", "--as", "user", "--message-ids", ids.slice(0, 50).join(","), "--format", "json"]);
  const messages = output?.data?.messages || output?.data?.items || output?.messages || [];
  const map = new Map();
  for (const message of messages) {
    if (message.message_id) map.set(message.message_id, message);
  }
  return map;
}

function hasUsableContent(message) {
  return message && message.msg_type && message.content;
}

function extractFlaggedMessages(flagResponse) {
  const flags = flagResponse?.data?.flag_items || [];
  const messageMap = getMessageMap(flagResponse);
  const missingIds = [];
  const pairs = [];

  for (const flag of flags) {
    const inline = flag.message && typeof flag.message === "object" ? flag.message : null;
    const itemId = flag.item_id;
    // Prefer inline message only if it has real content; otherwise fall back to messageMap / fetch.
    let message = hasUsableContent(inline) ? inline : messageMap.get(itemId);
    if (!hasUsableContent(message) && String(itemId || "").startsWith("om_")) {
      missingIds.push(itemId);
    }
    pairs.push({ flag, message: hasUsableContent(message) ? message : null });
  }

  const fetched = fetchMissingMessages([...new Set(missingIds)]);
  return pairs.map((pair) => ({
    flag: pair.flag,
    message: pair.message || fetched.get(pair.flag.item_id),
  })).filter((pair) => pair.message);
}

function main() {
  if (!existsSync(path.join(VAULT, ".git"))) {
    throw new Error(`Vault git repo not found: ${VAULT}`);
  }

  preflightGitPull();

  const flagResponse = runLarkCli(["im", "+flag-list", "--as", "user", "--page-all", "--page-limit", "1000", "--format", "json"]);
  const pairs = extractFlaggedMessages(flagResponse);

  let changed = 0;
  for (const { flag, message } of pairs) {
    const file = targetPath(message);
    if (writeIfChanged(file, buildMarkdown(message, flag))) changed += 1;
  }

  log(`done: active_flags=${flagResponse?.data?.flag_items?.length || 0}; imported=${pairs.length}; changed=${changed}; dry_run=${DRY_RUN}`);
  commitAndPush(changed);
}

try {
  main();
} catch (error) {
  log(`error: ${error.stack || error.message}`);
  process.exitCode = 1;
}
