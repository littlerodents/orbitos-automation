#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

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

const API_KEY = getApiKey();

async function post(endpoint, body = {}) {
  const response = await fetch(`${API_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${endpoint} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
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
  return item?.url || item?.source_url || item?.webpage?.url || item?.webpage?.normalized_url || "";
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

  const plain = item?.content?.plain;
  if (typeof plain === "string" && plain.trim()) return markdownEscape(plain);

  const description = item?.webpage?.description;
  if (typeof description === "string" && description.trim()) return markdownEscape(description);

  const raw = item?.content?.raw;
  if (typeof raw === "string" && raw.trim() && raw.length < 20000) return markdownEscape(raw);

  return "";
}

function buildMarkdown({ board, kind, item }) {
  const title = item.title || item.webpage?.title || "Untitled YouMind Item";
  const url = pickUrl(item);
  const author = pickAuthor(item);
  const content = extractMainContent(item);
  const description = markdownEscape(item.webpage?.description || item.overview || "");
  const sourceType = item.type || item.entity_type || kind;
  const date = isoDate(item.created_at || item.updated_at);

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
    `created: ${safeYaml(item.created_at)}`,
    `updated: ${safeYaml(item.updated_at)}`,
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
    item.published_at ? `- Published: ${item.published_at}` : "",
    item.created_at ? `- Captured: ${item.created_at}` : "",
    item.updated_at ? `- Updated: ${item.updated_at}` : "",
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
  const date = isoDate(item.created_at || item.updated_at);
  const shortId = String(item.id || "").split("-").at(-1) || String(item.id || "").slice(-8);
  return path.join(OUT_ROOT, boardName, kind === "craft" ? "Crafts" : "Materials", `${date} ${title} ${shortId}.md`);
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

async function fetchItemsForBoard(board) {
  const [materialRefs, craftRefs] = await Promise.all([
    post("listMaterials", { board_id: board.id }).catch((error) => {
      log(`warn: listMaterials failed for ${board.name}: ${error.message}`);
      return [];
    }),
    post("listCrafts", { board_id: board.id }).catch((error) => {
      log(`warn: listCrafts failed for ${board.name}: ${error.message}`);
      return [];
    }),
  ]);

  const materials = [];
  for (const ref of Array.isArray(materialRefs) ? materialRefs : []) {
    try {
      materials.push(await post("getMaterial", { id: ref.id }));
    } catch (error) {
      log(`warn: getMaterial failed for ${ref.id}: ${error.message}`);
    }
  }

  const crafts = [];
  for (const ref of Array.isArray(craftRefs) ? craftRefs : []) {
    try {
      crafts.push(await post("getCraft", { id: ref.id }));
    } catch (error) {
      log(`warn: getCraft failed for ${ref.id}: ${error.message}`);
    }
  }

  return { materials, crafts };
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

  let written = 0;
  let seen = 0;

  for (const board of boards) {
    const { materials, crafts } = await fetchItemsForBoard(board);
    log(`board: ${board.name}; materials=${materials.length}; crafts=${crafts.length}`);

    for (const item of materials) {
      seen += 1;
      const file = targetPath({ board, kind: "material", item });
      const changed = writeIfChanged(file, buildMarkdown({ board, kind: "material", item }));
      if (changed) written += 1;
    }

    for (const item of crafts) {
      seen += 1;
      const file = targetPath({ board, kind: "craft", item });
      const changed = writeIfChanged(file, buildMarkdown({ board, kind: "craft", item }));
      if (changed) written += 1;
    }
  }

  log(`done: boards=${boards.length}; items=${seen}; changed=${written}; dry_run=${DRY_RUN}`);
  commitAndPush();
}

main().catch((error) => {
  log(`error: ${error.stack || error.message}`);
  process.exitCode = 1;
});
