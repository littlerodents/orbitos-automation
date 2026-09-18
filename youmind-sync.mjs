#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./lib/config.mjs";
const _cfg = loadConfig();
const VAULT = _cfg.vault_path;;
const OUT_ROOT = path.join(VAULT, "30_Research", "YouMind");
const API_BASE = "https://youmind.com/openapi/v1";
const KEYCHAIN_SERVICE = "orbitos-youmind-api-key";
const KEYCHAIN_ACCOUNT = "evander";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const NO_GIT = args.has("--no-git") || DRY_RUN;
const DEFAULT_LOOKBACK_DAYS = 14;

function numberArg(name, fallback, argv = process.argv.slice(2)) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  const index = argv.indexOf(name);
  const raw = inline ? inline.slice(name.length + 1) : (index >= 0 ? argv[index + 1] : "");
  if (raw === "" || raw == null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const LOOKBACK_DAYS = numberArg("--lookback-days", DEFAULT_LOOKBACK_DAYS);

function nowIso() {
  return new Date().toISOString();
}

function log(message) {
  process.stdout.write(`[${nowIso()}] ${message}\n`);
}

function getApiKey() {
  if (process.env.YOUMIND_API_KEY) return process.env.YOUMIND_API_KEY.trim();
  try {
    return execFileSync("security", [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`YouMind API key not found. Set YOUMIND_API_KEY or Keychain service ${KEYCHAIN_SERVICE}.`);
  }
}

let cachedApiKey = "";

function apiKey() {
  if (!cachedApiKey) cachedApiKey = getApiKey();
  return cachedApiKey;
}

function isTransientYouMindError(error) {
  const status = Number(error?.status || 0);
  return error instanceof TypeError
    || [408, 425, 429].includes(status)
    || status >= 500
    || /fetch failed|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(String(error?.message || error || ""));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postOnce(endpoint, body = {}) {
  const response = await fetch(`${API_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${endpoint} failed (${response.status}): ${text.slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

async function post(endpoint, body = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await postOnce(endpoint, body);
    } catch (error) {
      lastError = error;
      if (attempt === 3 || !isTransientYouMindError(error)) throw error;
      log(`warn: ${endpoint} transient failure; retry=${attempt}/2: ${error.message.split("\n")[0]}`);
      await delay(attempt * 1000);
    }
  }
  throw lastError;
}

function git(args, options = {}) {
  const output = execFileSync("git", ["-C", VAULT, ...args], {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function safeYaml(value) {
  if (value == null || value === "") return '""';
  return JSON.stringify(String(value));
}

function slugify(value, fallback = "untitled") {
  const cleaned = String(value || fallback)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#^[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return cleaned || fallback;
}

function isoDate(value) {
  if (!value) return "undated";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "undated";
  return date.toISOString().slice(0, 10);
}

function parseJsonMaybe(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function markdownEscape(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function pickUrl(item) {
  return item?.url || item?.source_url || item?.sourceUrl || item?.webpage?.url || item?.webpage?.normalized_url || item?.webpage?.normalizedUrl || "";
}

function pickAuthor(item) {
  if (Array.isArray(item?.authors) && item.authors.length) {
    return item.authors.map((a) => a?.name).filter(Boolean).join(", ");
  }
  const extra = parseJsonMaybe(item?.extra);
  return extra?.tweet?.user?.name || "";
}

function extractTweetThread(item) {
  const raw = parseJsonMaybe(item?.content?.raw);
  const extra = parseJsonMaybe(item?.extra);
  const source = raw || extra;
  if (!source) return "";

  const tweets = [];
  if (source.mainTweet) tweets.push(source.mainTweet);
  if (source.tweet && !source.mainTweet) tweets.push(source.tweet);
  if (Array.isArray(source.commentTweets)) tweets.push(...source.commentTweets);

  const blocks = tweets
    .map((tweet, index) => {
      const author = tweet?.user?.name ? ` by ${tweet.user.name}` : "";
      const created = tweet?.created_at ? ` (${tweet.created_at})` : "";
      const text = markdownEscape(tweet?.full_text || tweet?.text || "");
      if (!text) return "";
      return `### Tweet ${index + 1}${author}${created}\n\n${text}`;
    })
    .filter(Boolean);

  return blocks.join("\n\n");
}

function extractMainContent(item) {
  const tweetThread = extractTweetThread(item);
  if (tweetThread) return tweetThread;

  if (typeof item?.content === "string" && item.content.trim()) return markdownEscape(item.content);

  const plain = item?.content?.plain;
  if (typeof plain === "string" && plain.trim()) return markdownEscape(plain);

  const description = item?.webpage?.description;
  if (typeof description === "string" && description.trim()) return markdownEscape(description);

  const raw = item?.content?.raw;
  if (typeof raw === "string" && raw.trim() && raw.length < 20000) return markdownEscape(raw);

  return "";
}

function itemCreatedAt(item) {
  return item?.created_at || item?.createdAt || "";
}

function itemUpdatedAt(item) {
  return item?.updated_at || item?.updatedAt || "";
}

function itemPublishedAt(item) {
  return item?.published_at || item?.publishedAt || "";
}

function buildMarkdown({ board, kind, item }) {
  const title = item.title || item.webpage?.title || "Untitled YouMind Item";
  const url = pickUrl(item);
  const author = pickAuthor(item);
  const content = extractMainContent(item);
  const description = markdownEscape(item.webpage?.description || item.overview || "");
  const sourceType = item.type || item.entity_type || kind;
  const createdAt = itemCreatedAt(item);
  const updatedAt = itemUpdatedAt(item);
  const publishedAt = itemPublishedAt(item);
  const date = isoDate(createdAt || updatedAt);

  const lines = [
    "---",
    "source: youmind",
    `date: ${safeYaml(date === "undated" ? "" : date)}`,
    `type: ${safeYaml(kind)}`,
    `youmind_type: ${safeYaml(sourceType)}`,
    `youmind_id: ${safeYaml(item.id)}`,
    `board: ${safeYaml(board.name)}`,
    `board_id: ${safeYaml(board.id)}`,
    `url: ${safeYaml(url)}`,
    `author: ${safeYaml(author)}`,
    `created: ${safeYaml(createdAt)}`,
    `updated: ${safeYaml(updatedAt)}`,
    "tags:",
    "  - youmind",
    kind === "craft" ? "  - youmind-craft" : "  - web-reading",
    "---",
    `# ${title}`,
    "",
    "## Source",
    "",
    `- Board: ${board.name}`,
    `- YouMind ID: ${item.id}`,
    `- Type: ${sourceType}`,
    url ? `- URL: ${url}` : "- URL:",
    author ? `- Author: ${author}` : "- Author:",
    publishedAt ? `- Published: ${publishedAt}` : "",
    createdAt ? `- Captured: ${createdAt}` : "",
    updatedAt ? `- Updated: ${updatedAt}` : "",
  ].filter((line) => line !== "");

  if (description && description !== content) {
    lines.push("", "## Description", "", description);
  }

  lines.push("", "## Content", "", content || "_No text content returned by YouMind API._", "");
  return lines.join("\n");
}

function targetPath({ board, kind, item }) {
  const boardName = slugify(board.name, "Board");
  const title = slugify(item.title || item.webpage?.title || item.id, "Untitled");
  const date = isoDate(itemCreatedAt(item) || itemUpdatedAt(item));
  const shortId = String(item.id || "").split("-").at(-1) || String(item.id || "").slice(-8);
  return path.join(OUT_ROOT, boardName, kind === "craft" ? "Crafts" : "Materials", `${date} ${title} ${shortId}.md`);
}

function captureBody(markdown) {
  const marker = "\n## Content\n";
  const index = String(markdown || "").indexOf(marker);
  return (index >= 0 ? String(markdown).slice(index + marker.length) : String(markdown || "")).trim();
}

function shouldReplaceCapture(existing, candidate) {
  if (existing === candidate) return false;
  const existingBody = captureBody(existing);
  const candidateBody = captureBody(candidate);
  if (!existingBody) return Boolean(candidateBody);
  return candidateBody.length >= existingBody.length;
}

function writeCapture(file, content) {
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8");
    if (existing === content) return { changed: false, preserved: false };
    if (!shouldReplaceCapture(existing, content)) return { changed: false, preserved: true };
  }
  if (DRY_RUN) return { changed: true, preserved: false };
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
  return { changed: true, preserved: false };
}

function walkMarkdown(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return walkMarkdown(file);
    return entry.isFile() && entry.name.endsWith(".md") ? [file] : [];
  });
}

function existingYouMindIndex(root = OUT_ROOT) {
  const files = new Map();
  for (const file of walkMarkdown(root)) {
    const match = readFileSync(file, "utf8").match(/^youmind_id:\s*["']?([^"'\n]+)["']?\s*$/m);
    if (match?.[1]) files.set(match[1].trim(), file);
  }
  return files;
}

function existingYouMindIds(root = OUT_ROOT) {
  return new Set(existingYouMindIndex(root).keys());
}

function itemTimestamp(item) {
  return Math.max(Date.parse(itemUpdatedAt(item) || 0), Date.parse(itemCreatedAt(item) || 0));
}

function selectBoardFiles(files, existingIds = new Set(), cutoff = 0) {
  if (!Array.isArray(files)) throw new Error("listFiles returned non-array response");
  const selected = files.filter((item) => item?.type !== "group" && (existingIds.has(item?.id) || itemTimestamp(item) >= cutoff));
  const craftTypes = new Set(["document", "slides", "slide", "presentation", "pod", "podcast"]);
  const crafts = selected.filter((item) => craftTypes.has(String(item?.type || "").toLowerCase()));
  const craftIds = new Set(crafts.map((item) => item.id));
  return {
    materials: selected.filter((item) => !craftIds.has(item.id)),
    crafts,
    discovered: files.length,
    groups: files.filter((item) => item?.type === "group").length,
    selected: selected.length,
  };
}

async function fetchItemsForBoard(board, { postFn = post, existingIds = new Set(), cutoff = 0 } = {}) {
  const files = await postFn("listFiles", { boardId: board.id });
  return selectBoardFiles(files, existingIds, cutoff);
}

function preflightGitPull() {
  if (NO_GIT) return;
  try {
    git(["fetch", "--prune", "origin", "main"], { stdio: "ignore" });
    const dirty = git(["status", "--porcelain"]);
    if (!dirty) {
      git(["pull", "--ff-only", "origin", "main"], { stdio: "ignore" });
    } else {
      log("git: skip pre-pull because vault has local changes");
    }
  } catch (error) {
    log(`git: pre-pull skipped: ${error.message}`);
  }
}

function commitAndPush() {
  if (NO_GIT) return;
  try {
    git(["add", "30_Research/YouMind"], { stdio: "ignore" });
    try {
      git(["diff", "--cached", "--quiet"], { stdio: "ignore" });
      log("git: no YouMind changes to commit");
      return;
    } catch {
      git(["commit", "-m", "youmind: sync captured materials"], { stdio: "ignore" });
      log("git: committed YouMind sync");
    }
    try {
      git(["push", "origin", "main"], { stdio: "ignore" });
      log("git: pushed YouMind sync");
    } catch (error) {
      log(`git: push failed; Obsidian Git/manual sync can retry later: ${error.message}`);
    }
  } catch (error) {
    log(`git: commit skipped: ${error.message}`);
  }
}

async function main() {
  if (!existsSync(path.join(VAULT, ".git"))) {
    throw new Error(`Vault git repo not found: ${VAULT}`);
  }

  preflightGitPull();

  const boards = await post("listBoards", {});
  if (!Array.isArray(boards)) throw new Error("listBoards returned non-array response");

  const existingIndex = existingYouMindIndex();
  const existingIds = new Set(existingIndex.keys());
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  let written = 0;
  let preserved = 0;
  let seen = 0;
  let discovered = 0;
  let groups = 0;
  const failures = [];

  for (const board of boards) {
    let result;
    try {
      result = await fetchItemsForBoard(board, { existingIds, cutoff });
    } catch (error) {
      failures.push(`${board.name}: ${error.message}`);
      log(`error: listFiles failed for ${board.name}: ${error.message}`);
      continue;
    }
    const { materials, crafts } = result;
    discovered += result.discovered;
    groups += result.groups;
    log(`board: ${board.name}; discovered=${result.discovered}; groups_skipped=${result.groups}; selected=${result.selected}; materials=${materials.length}; crafts=${crafts.length}`);

    for (const item of materials) {
      seen += 1;
      const file = existingIndex.get(item.id) || targetPath({ board, kind: "material", item });
      const result = writeCapture(file, buildMarkdown({ board, kind: "material", item }));
      if (result.changed) written += 1;
      if (result.preserved) preserved += 1;
    }

    for (const item of crafts) {
      seen += 1;
      const file = existingIndex.get(item.id) || targetPath({ board, kind: "craft", item });
      const result = writeCapture(file, buildMarkdown({ board, kind: "craft", item }));
      if (result.changed) written += 1;
      if (result.preserved) preserved += 1;
    }
  }

  log(`done: boards=${boards.length}; discovered=${discovered}; groups_skipped=${groups}; selected=${seen}; changed=${written}; preserved_richer=${preserved}; lookback_days=${LOOKBACK_DAYS}; dry_run=${DRY_RUN}`);
  if (failures.length) throw new Error(`YouMind sync incomplete (${failures.length}/${boards.length} boards failed): ${failures.join(" | ")}`);
  commitAndPush();
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(thisFile)) {
  main().catch((error) => {
    log(`error: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

export {
  buildMarkdown,
  existingYouMindIds,
  existingYouMindIndex,
  fetchItemsForBoard,
  isTransientYouMindError,
  numberArg,
  selectBoardFiles,
  shouldReplaceCapture,
  targetPath,
};
