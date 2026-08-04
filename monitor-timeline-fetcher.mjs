#!/usr/bin/env node
// monitor-timeline-fetcher: CDP scrapes X timeline → writes to GitHub cache file
// Runs via launchd hourly. No API key needed — uses Chrome's cookies via CDP proxy.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "./lib/config.mjs";

// 托管 tab 状态：长期复用同一个 x.com/home tab + 同一条调试会话。
// Chrome 每次新 attach 都弹“允许调试”确认框；复用会话 = 只在创建时申请一次。
const STATE_FILE = `${process.env.HOME}/.config/orbitos-automation/managed-x-tab.json`;

const _cfg = loadConfig();
const CDP_PROXY = _cfg.cdp_proxy_url;
const GH_TOKEN = process.env.GITHUB_TOKEN || _cfg.github_token || "";
const REPO = _cfg.github_owner + "/" + _cfg.github_repo;
const BRANCH = _cfg.github_branch || "main";
const CACHE_PATH = "00_Inbox/.monitor-timeline-cache.json";
const SIGNALS_PATH = "00_Inbox/.monitor-tab-signals.json";

function curl(path, method = "GET", body = null) {
  const args = ["-s", "--max-time", "90", "-X", method, `${CDP_PROXY}${path}`];
  if (body) args.push("-d", body);
  return JSON.parse(execFileSync("curl", args, { encoding: "utf8" }));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 轮询等推文渲染出来（X 是 SPA，load 事件≠内容就绪）
// 探针数的是"有正文或有 status 链接"的 article —— 骨架占位节点不算（2026-08-04 踩坑：
// 骨架屏有 article 节点但没内容，探针被骗过后抓出 0 条）
const READY_PROBE = "(function(){var n=0;document.querySelectorAll('article').forEach(function(a){if(a.querySelector('[data-testid=tweetText]')||a.querySelector(\"a[href*='/status/']\"))n++;});return n;})()";

async function waitForArticles(targetId, minCount = 1, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let articles = 0;
  while (Date.now() < deadline) {
    try {
      const r = curl(`/eval?target=${targetId}`, "POST", READY_PROBE);
      articles = r.value || 0;
      if (articles >= minCount) break;
    } catch { /* 页面还没准备好，继续等 */ }
    sleep(2500);
  }
  return articles;
}

function readManagedTab() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")).targetId || null; }
  catch { return null; }
}

function writeManagedTab(targetId) {
  try { writeFileSync(STATE_FILE, JSON.stringify({ targetId, created_at: new Date().toISOString() })); } catch {}
}

// 找/建托管 tab：已存在就复用并刷新（复用缓存会话，零新 attach、零弹窗）；
// 不存在（首次/被主人关掉/浏览器重启）才新开一个 —— 只有这时会触发一次“允许调试”
async function getManagedTab(targets) {
  const saved = readManagedTab();
  if (saved && targets.some(t => t.targetId === saved)) {
    curl(`/navigate?target=${saved}&url=${encodeURIComponent("https://x.com/home")}`);
    return { targetId: saved, reused: true };
  }
  const { targetId } = curl(`/new?url=${encodeURIComponent("https://x.com/home")}`);
  writeManagedTab(targetId);
  return { targetId, reused: false };
}

async function main() {
  // 1. targets：读 tab 信号（纯枚举，不 attach）+ 定位托管 tab
  const targets = curl("/targets");
  const allXTabs = targets.filter(t => t.url && /x\.com/.test(t.url));
  
  // Extract authors from open tweet status tabs (e.g. x.com/thedankoe/status/...)
  const activeAuthors = [...new Set(
    allXTabs
      .map(t => (t.url || "").match(/x\.com\/(\w+)\/status/))
      .filter(Boolean)
      .map(m => m[1])
  )];
  
  // 2. 托管 tab：永远用自己的，绝不 attach 主人手动开的 tab（避免在主人 tab 上弹确认框）
  const managed = await getManagedTab(targets);
  const targetId = managed.targetId;
  console.log(managed.reused ? `reusing managed tab ${targetId.slice(0, 8)}` : `created managed tab ${targetId.slice(0, 8)}`);
  const rendered = await waitForArticles(targetId, 5, 30000);
  if (rendered === 0) {
    console.log("no tweets rendered (login wall? approval pending?), cache not overwritten");
    process.exit(0);
  }

  // 3. Scrape timeline from DOM
  const scrapeResult = curl(`/eval?target=${targetId}`, "POST",
    `(function() {
      var articles = document.querySelectorAll("article");
      var result = [];
      articles.forEach(function(article, i) {
        if (i >= 50) return;
        var tweetText = article.querySelector("[data-testid=tweetText]")?.textContent || "";
        if (!tweetText) {
          // 长文推（long-form）没有 tweetText 节点：从 innerText 兜底，
          // 去掉"名字+@handle"头部和纯数字互动行（如 9 / 28 / 306 / 30万）
          var lines = (article.innerText || "").split("\\n").map(function(s){return s.trim();}).filter(Boolean);
          if (lines.length > 1 && lines[1].charAt(0) === "@") lines.splice(0, 2);
          lines = lines.filter(function(l){ return !/^[0-9.,K万]+$/.test(l) && l.charAt(0) !== "·"; });
          tweetText = lines.join(" ").slice(0, 500);
        }
        var userName = "";
        var userLinks = article.querySelectorAll("a[role=link] span");
        userLinks.forEach(function(s) { if (!userName && s.textContent && s.textContent.length > 0) userName = s.textContent; });
        var timeEl = article.querySelector("time");
        var time = timeEl ? timeEl.getAttribute("datetime") : "";
        var linkEl = article.querySelector("a[href*='/status/']");
        var link = linkEl ? linkEl.href.split("/analytics")[0] : "";
        var groups = article.querySelectorAll("[role=group] button");
        var engagement = [];
        groups.forEach(function(g) { engagement.push(g.getAttribute("aria-label") || ""); });
        // Parse engagement numbers
        var likes = 0, retweets = 0, replies = 0;
        engagement.forEach(function(e) {
          var m = e.match(/([\\d,.]+)\\s*(喜欢|like)/i); if (m) likes = parseInt(m[1].replace(/[,.]/g,"")) || 0;
          m = e.match(/([\\d,.]+)\\s*(转帖|retweet)/i); if (m) retweets = parseInt(m[1].replace(/[,.]/g,"")) || 0;
          m = e.match(/([\\d,.]+)\\s*(回复|repl)/i); if (m) replies = parseInt(m[1].replace(/[,.]/g,"")) || 0;
        });
        if (tweetText || link) {
          result.push({
            id: link.split("/status/")[1] || "",
            author: userName,
            text: tweetText.slice(0, 500),
            likes: likes,
            retweets: retweets,
            replies: replies,
            quotes: 0,
            views: 0,
            created_at: time,
            url: link
          });
        }
      });
      return JSON.stringify(result);
    })()`
  );

  const tweetsJson = scrapeResult.value || "[]";
  if (!scrapeResult.value) console.log("DEBUG scrape raw:", JSON.stringify(scrapeResult).slice(0, 300));
  const tweets = JSON.parse(tweetsJson);

  // 0 条不覆盖上次的好缓存
  if (tweets.length === 0) {
    console.log("0 tweets scraped, cache not overwritten");
    process.exit(0);
  }

  // 4. Write to GitHub cache file
  const contentB64 = Buffer.from(JSON.stringify({
    fetched_at: new Date().toISOString(),
    tweet_count: tweets.length,
    tweets: tweets,
  })).toString("base64");

  // Get existing file sha (if exists) for update
  let sha = "";
  try {
    const resp = JSON.parse(execFileSync("curl", [
      "-s", "--max-time", "30", "-H", `Authorization: Bearer ${GH_TOKEN}`,
      "-H", "Accept: application/vnd.github+json",
      `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(CACHE_PATH)}?ref=${BRANCH}`
    ], { encoding: "utf8" }));
    sha = resp.sha || "";
  } catch {}

  // PUT to GitHub
  const body = JSON.stringify({
    message: "monitor: timeline cache update",
    content: contentB64,
    branch: BRANCH,
    ...(sha ? { sha } : {})
  });
  const putResp = JSON.parse(execFileSync("curl", [
    "-s", "--max-time", "30", "-X", "PUT",
    "-H", `Authorization: Bearer ${GH_TOKEN}`,
    "-H", "Accept: application/vnd.github+json",
    "-H", "Content-Type: application/json",
    "-d", body,
    `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(CACHE_PATH)}`
  ], { encoding: "utf8" }));

  if (!putResp.commit?.sha) {
    console.error("GitHub PUT failed:", putResp.message || JSON.stringify(putResp).slice(0, 200));
    process.exit(1);
  }
  console.log(`timeline cached: ${tweets.length} tweets, commit: ${putResp.commit.sha.slice(0, 7)}`);
  
  // 5. Write tab signals (active authors from open tabs)
  await writeTabSignals(activeAuthors);
  console.log(`tab signals cached: ${activeAuthors.length} active authors`);

  // 托管 tab 刻意不关：保住这条已批准的调试会话，下次复用 = 不再弹确认框
}

async function writeTabSignals(activeAuthors) {
  const contentB64 = Buffer.from(JSON.stringify({
    updated_at: new Date().toISOString(),
    active_authors: activeAuthors,
  })).toString("base64");

  let sha = "";
  try {
    const resp = JSON.parse(execFileSync("curl", [
      "-s", "--max-time", "30", "-H", `Authorization: Bearer ${GH_TOKEN}`,
      "-H", "Accept: application/vnd.github+json",
      `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(SIGNALS_PATH)}?ref=${BRANCH}`
    ], { encoding: "utf8" }));
    sha = resp.sha || "";
  } catch {}

  const body = JSON.stringify({
    message: "monitor: tab signals update",
    content: contentB64,
    branch: BRANCH,
    ...(sha ? { sha } : {})
  });
  const putResp = JSON.parse(execFileSync("curl", [
    "-s", "--max-time", "30", "-X", "PUT",
    "-H", `Authorization: Bearer ${GH_TOKEN}`,
    "-H", "Accept: application/vnd.github+json",
    "-H", "Content-Type: application/json",
    "-d", body,
    `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(SIGNALS_PATH)}`
  ], { encoding: "utf8" }));
  if (!putResp.commit?.sha) {
    console.error("tab signals PUT failed:", putResp.message || JSON.stringify(putResp).slice(0, 200));
    process.exit(1);
  }
}

main().catch(e => {
  console.error("error:", e.message);
  process.exit(1);
});
