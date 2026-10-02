#!/usr/bin/env node
// learning-fetcher: 三线学习流的数据采集
//   线1 AI Agent/技术: 复用 monitor 的 X 时间线缓存（不单独抓）
//   线2 Paul Graham: 抓 paulgraham.com/articles.html，检测新文章 + 维护精读队列
//   线3 独立开发者: 经 CDP 代理抓 4 个账号主页的最新推文
// 输出: ~/.config/orbitos-automation/learning-cache.json
// 手动: node learning-fetcher.mjs
// 定时: com.evander.orbitos-learning-fetcher（每天 10:50 + 20:50）

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { loadConfig } from "./lib/config.mjs";

const cfg = loadConfig();
const CDP = cfg.cdp_proxy_url;
const CACHE_PATH = join(homedir(), ".config/orbitos-automation/learning-cache.json");
const TAB_STATE = join(homedir(), ".config/orbitos-automation/learning-x-tab.json");

const DEVS = ["thedankoe", "marclou", "levelsio", "tdinh_me"];
const PG_QUEUE_TITLES = [
  "Keep Your Identity Small",
  "Life is Short",
  "The Lesson to Unlearn",
  "How to Think for Yourself",
  "The Right Kind of Stubborn",
  "Superlinear Returns",
  "How to Do Great Work",
  "How to Start a Startup",
];

function curl(path, method = "GET", body = null) {
  const args = ["-s", "--max-time", "90", "-X", method, `${CDP}${path}`];
  if (body) args.push("-d", body);
  return JSON.parse(execFileSync("curl", args, { encoding: "utf8" }));
}
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const PROBE = "(function(){var n=0;document.querySelectorAll('article').forEach(function(a){if(a.querySelector('[data-testid=tweetText]'))n++;});return n;})()";
async function waitArticles(targetId, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((curl(`/eval?target=${targetId}`, "POST", PROBE).value || 0) >= 1) return true; } catch {}
    sleep(2500);
  }
  return false;
}

const EXTRACT = `(function(){
  var out=[];
  document.querySelectorAll('article').forEach(function(a){
    var t=a.querySelector('[data-testid=tweetText]');
    if(!t)return;
    var link=a.querySelector("a[href*='/status/']");
    var time=a.querySelector('time');
    out.push({text:t.innerText.slice(0,400),url:link?link.href:'',t:time?time.dateTime:''});
  });
  return out;
})()`;

function readTab() { try { return JSON.parse(readFileSync(TAB_STATE, "utf8")).targetId || null; } catch { return null; } }
function saveTab(id) { try { writeFileSync(TAB_STATE, JSON.stringify({ targetId: id })); } catch {} }

async function getTab() {
  const targets = curl("/targets");
  const saved = readTab();
  if (saved && targets.some(t => t.targetId === saved)) return saved;
  const { targetId } = curl(`/new?url=${encodeURIComponent("https://x.com/thedankoe")}`);
  saveTab(targetId);
  return targetId;
}

async function scrapeDev(handle, tabId) {
  curl(`/navigate?target=${tabId}&url=${encodeURIComponent(`https://x.com/${handle}`)}`);
  await waitArticles(tabId);
  sleep(2000);
  try { return curl(`/eval?target=${tabId}`, "POST", EXTRACT).value || []; }
  catch { return []; }
}

async function fetchPg() {
  const resp = await fetch("https://www.paulgraham.com/articles.html");
  const html = await resp.text();
  const seen = new Set();
  const essays = [];
  for (const m of html.matchAll(/<a href="([a-z0-9]+\.html)">([^<]+)<\/a>/gi)) {
    const href = m[1], title = m[2].trim();
    if (["index", "articles", "books", "ideas", "hiring", "venturecapital", "spam", "quo", " rss", "rss"].includes(href.replace(".html", ""))) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    essays.push({ title, url: `https://www.paulgraham.com/${href}` });
  }
  return essays;
}

async function main() {
  const cache = (() => { try { return JSON.parse(readFileSync(CACHE_PATH, "utf8")); } catch { return { tweets: {}, pg: { seen: [], queue: [], currentIdx: 0 } }; }; })();

  // --- 独立开发者线：4 账号 ---
  try {
    const tabId = await getTab();
    for (const h of DEVS) {
      const tweets = await scrapeDev(h, tabId);
      const prev = new Set((cache.tweets[h] || []).map(t => t.url));
      const fresh = tweets.filter(t => t.url && !prev.has(t.url)).map(t => ({ ...t, fetched: new Date().toISOString() }));
      cache.tweets[h] = [...fresh, ...(cache.tweets[h] || [])].slice(0, 12);
      console.log(`${h}: +${fresh.length} (total ${cache.tweets[h].length})`);
    }
  } catch (e) { console.error(`dev scrape failed (non-fatal): ${e.message}`); }

  // --- PG 线：文章清单 + 精读队列 ---
  try {
    const essays = await fetchPg();
    const known = new Set(cache.pg.seen);
    const newOnes = essays.filter(e => !known.has(e.url));
    for (const e of newOnes) { cache.pg.seen.push(e.url); }
    if (newOnes.length) console.log(`pg: ${newOnes.length} new essay(s): ${newOnes.map(e => e.title).join(", ")}`);
    // 队列：按精选标题顺序解析出 URL；未匹配的跳过
    if (!cache.pg.queue.length) {
      const byTitle = new Map(essays.map(e => [e.title.toLowerCase(), e]));
      cache.pg.queue = PG_QUEUE_TITLES
        .map(t => byTitle.get(t.toLowerCase()))
        .filter(Boolean);
      console.log(`pg queue initialized: ${cache.pg.queue.length} essays`);
    }
    if (newOnes.length) cache.pg.newNotified = false;
  } catch (e) { console.error(`pg fetch failed (non-fatal): ${e.message}`); }

  cache.updated = new Date().toISOString();
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
  console.log("learning cache updated");
}
main().catch(e => { console.error(e); process.exit(1); });
