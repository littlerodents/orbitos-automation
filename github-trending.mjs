#!/usr/bin/env node
// github-trending: GitHub Trending 快照 → 日报"工具风向"输入（2026-10-24）
//   只做三件事：抓 daily/weekly 榜、解析、与上次快照 diff 出"新上榜"。
//   快照只留一份（~/.config/orbitos-automation/github-trending.json），不写 vault ——
//   trending 的价值在"变化"，不在"当前列表"，落盘会变成只增不减的噪音。
// 用法:
//   node github-trending.mjs --brief-lines     # 给日报用的文本块（默认）
//   node github-trending.mjs --json            # 结构化输出（调试/测试）
//   node github-trending.mjs --no-cache        # 不读写快照（纯当前榜）
// 设计约束: 抓取失败一律返回空（非致命），绝不让 trending 拖垮日报。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const STATE_DIR = join(homedir(), ".config", "orbitos-automation");
const STATE_FILE = join(STATE_DIR, "github-trending.json");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36";
const KEEP_DAYS = 30;

function log(msg) {
  process.stdout.write(`[trending] ${msg}\n`);
}

function todayStr(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

// --- 解析（不依赖 DOM 库；GitHub 结构变了就只用当前榜，不抛错） ---

export function parseTrendingHtml(html) {
  const raw = String(html || "");
  const articles = raw.split('<article class="Box-row">').slice(1);
  const repos = [];
  for (const chunk of articles) {
    const a = chunk.split("</article>")[0];
    // 只在 <h2> 里取仓库名：卡片外层还有 /sponsors/xxx 按钮，按全卡匹配会误判
    const h2 = (a.match(/<h2[\s\S]*?<\/h2>/) || [""])[0];
    const full = [...h2.matchAll(/href="\/([\w.\-]+\/[\w.\-]+)"/g)]
      .map((m) => m[1])
      .find((h) => !h.startsWith("login") && !h.startsWith("sponsors"));
    if (!full) continue;
    const descMatch = a.match(/<p class="col-9 color-fg-muted my-1[^"]*">\s*([\s\S]*?)\s*<\/p>/);
    const desc = descMatch
      ? descMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
      : "";
    const lang = (a.match(/itemprop="programmingLanguage">([^<]+)</) || [])[1] || "";
    const stars = (a.match(new RegExp(`href="/${full.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/stargazers"[\\s\\S]*?</svg>\\s*([\\d,]+)`)) || [])[1] || "";
    const gain = a.match(/([\d,]+)\s+stars\s+(today|this week)/);
    repos.push({
      repo: full,
      stars: stars.replace(/,/g, ""),
      gain: gain ? `${gain[1]}/${gain[2] === "today" ? "日" : "周"}` : "",
      lang,
      desc: desc.slice(0, 220),
    });
  }
  return repos;
}

export async function fetchTrendingHtml(since = "daily", { timeoutMs = 30000 } = {}) {
  const resp = await fetch(`https://github.com/trending?since=${since}`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`github trending http ${resp.status}`);
  return await resp.text();
}

// --- 快照 diff：判定"新上榜" ---

export function loadState(file = STATE_FILE) {
  try {
    const d = JSON.parse(readFileSync(file, "utf8"));
    if (d && typeof d.repos === "object") return { repos: d.repos, lastRun: d.lastRun || null };
  } catch { /* 无快照 = 首跑 */ }
  return { repos: {}, lastRun: null };
}

export function pruneState(state, today) {
  const cutoff = new Date(`${today}T00:00:00+08:00`).getTime() - KEEP_DAYS * 86400e3;
  const repos = {};
  for (const [name, v] of Object.entries(state.repos || {})) {
    const seen = v?.lastSeen ? new Date(`${v.lastSeen}T00:00:00+08:00`).getTime() : 0;
    if (seen >= cutoff) repos[name] = v;
  }
  return { ...state, repos };
}

// 首见日期 == 今天 → 新上榜。同日重跑保持标记一致。
export function markSeen(state, repos, today) {
  const next = { ...state, repos: { ...state.repos } };
  for (const r of repos) {
    const prev = next.repos[r.repo];
    next.repos[r.repo] = {
      firstSeen: prev?.firstSeen || today,
      lastSeen: today,
      bestGain: r.gain || prev?.bestGain || "",
    };
  }
  next.lastRun = new Date().toISOString();
  return next;
}

export function isNewToday(state, repo, today) {
  return state?.repos?.[repo]?.firstSeen === today;
}

// --- 给日报的文本块 ---

export function buildTrendingSection({ daily = [], weekly = [], state = null, today, limit = 10 } = {}) {
  const top = daily.slice(0, limit);
  const weeklyTop = weekly.slice(0, 5);
  if (!top.length && !weeklyTop.length) return "";

  const hasBaseline = Boolean(state && Object.keys(state.repos || {}).length);
  const fresh = hasBaseline ? top.filter((r) => isNewToday(state, r.repo, today)) : [];
  const lines = [];
  lines.push(hasBaseline
    ? `（快照 ${today}；daily top${top.length}，其中 ${fresh.length} 个今日新上榜）`
    : `（快照 ${today}；daily top${top.length}，首次快照无对比基线）`);
  top.forEach((r, i) => {
    const tag = isNewToday(state, r.repo, today) ? " ★新" : "";
    const head = `${i + 1}. ${r.repo} ${r.stars ? `${Number(r.stars).toLocaleString("en-US")}★` : ""}${r.gain ? ` +${r.gain}` : ""}${r.lang ? ` [${r.lang}]` : ""}${tag}`;
    lines.push(head);
    if (r.desc) lines.push(`   ${r.desc}`);
  });
  if (weeklyTop.length) {
    lines.push("本周高增速（weekly，仅参考量级）：");
    weeklyTop.forEach((r) => {
      const tag = isNewToday(state, r.repo, today) ? " ★新" : "";
      lines.push(`- ${r.repo}${r.gain ? ` +${r.gain}` : ""}${r.lang ? ` [${r.lang}]` : ""}${tag}`);
    });
  }
  return lines.join("\n");
}

// 非致命入口：任何异常 → 空串（日报照常生成）
export async function gatherTrendingForBrief({ today = todayStr(), useCache = true, stateFile = STATE_FILE } = {}) {
  try {
    const [dailyHtml, weeklyHtml] = await Promise.all([
      fetchTrendingHtml("daily"),
      fetchTrendingHtml("weekly").catch(() => ""),
    ]);
    const daily = parseTrendingHtml(dailyHtml);
    const weekly = weeklyHtml ? parseTrendingHtml(weeklyHtml) : [];
    if (!daily.length) return "";

    const prev = useCache ? loadState(stateFile) : { repos: {}, lastRun: null };
    const text = buildTrendingSection({ daily, weekly, state: prev, today });

    if (useCache) {
      const next = pruneState(markSeen(prev, [...daily, ...weekly], today), today);
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(stateFile, JSON.stringify(next, null, 1));
    }
    return text;
  } catch (error) {
    log(`non-fatal: ${String(error.message || error).slice(0, 160)}`);
    return "";
  }
}

// --- CLI ---

async function main() {
  const args = new Set(process.argv.slice(2));
  const today = todayStr();
  const useCache = !args.has("--no-cache");

  if (args.has("--json")) {
    const [d, w] = await Promise.all([
      fetchTrendingHtml("daily"),
      fetchTrendingHtml("weekly").catch(() => ""),
    ]);
    const daily = parseTrendingHtml(d);
    const weekly = w ? parseTrendingHtml(w) : [];
    const prev = useCache ? loadState() : { repos: {} };
    const text = buildTrendingSection({ daily, weekly, state: prev, today });
    if (useCache && daily.length) {
      const next = pruneState(markSeen(prev, [...daily, ...weekly], today), today);
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify(next, null, 1));
    }
    process.stdout.write(`${JSON.stringify({ today, daily, weekly, brief: text }, null, 1)}\n`);
    return;
  }

  const text = await gatherTrendingForBrief({ today, useCache });
  if (!text) {
    log("no data (fetch failed or empty)");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${text}\n`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(thisFile)) {
  main().catch((error) => {
    log(`fatal: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
