#!/usr/bin/env node
// monitor-timeline-fetcher: CDP scrapes X timeline → writes to GitHub cache file
// Runs via launchd every 30 min. No API key needed — uses Chrome's cookies via CDP proxy.

import { execFileSync } from "node:child_process";
import { loadConfig } from "./lib/config.mjs";

const _cfg = loadConfig();
const CDP_PROXY = _cfg.cdp_proxy_url;
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = _cfg.github_owner + "/" + _cfg.github_repo;
const BRANCH = _cfg.github_branch || "main";
const CACHE_PATH = "00_Inbox/.monitor-timeline-cache.json";
const SIGNALS_PATH = "00_Inbox/.monitor-tab-signals.json";

function curl(path, method = "GET", body = null) {
  const args = ["-s", "-X", method, `${CDP_PROXY}${path}`];
  if (body) args.push("-d", body);
  return JSON.parse(execFileSync("curl", args, { encoding: "utf8" }));
}

async function main() {
  // 1. Get all targets — find X home tab + extract active authors from open tweet tabs
  const targets = curl("/targets");
  const allXTabs = targets.filter(t => t.url && /x\.com/.test(t.url));
  const xTab = allXTabs.find(t => t.url.includes("x.com/home"));
  
  // Extract authors from open tweet status tabs (e.g. x.com/thedankoe/status/...)
  const activeAuthors = [...new Set(
    allXTabs
      .map(t => (t.url || "").match(/x\.com\/(\w+)\/status/))
      .filter(Boolean)
      .map(m => m[1])
  )];
  
  if (!xTab) {
    console.log("no X home tab found, skipping timeline scrape");
    if (activeAuthors.length > 0) {
      await writeTabSignals(activeAuthors);
      console.log(`tab signals cached: ${activeAuthors.length} authors (no home tab)`);
    }
    process.exit(0);
  }
  const targetId = xTab.targetId;

  // 2. Scrape timeline from DOM
  const scrapeResult = curl(`/eval?target=${targetId}`, "POST",
    `(function() {
      var articles = document.querySelectorAll("article");
      var result = [];
      articles.forEach(function(article, i) {
        if (i >= 50) return;
        var tweetText = article.querySelector("[data-testid=tweetText]")?.textContent || "";
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
  const tweets = JSON.parse(tweetsJson);

  // 3. Write to GitHub cache file
  const contentB64 = Buffer.from(JSON.stringify({
    fetched_at: new Date().toISOString(),
    tweet_count: tweets.length,
    tweets: tweets,
  })).toString("base64");

  // Get existing file sha (if exists) for update
  let sha = "";
  try {
    const resp = JSON.parse(execFileSync("curl", [
      "-s", "-H", `Authorization: Bearer ${GH_TOKEN}`,
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
    "-s", "-X", "PUT",
    "-H", `Authorization: Bearer ${GH_TOKEN}`,
    "-H", "Accept: application/vnd.github+json",
    "-H", "Content-Type: application/json",
    "-d", body,
    `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(CACHE_PATH)}`
  ], { encoding: "utf8" }));

  console.log(`timeline cached: ${tweets.length} tweets, commit: ${(putResp.commit?.sha || "").slice(0, 7)}`);
  
  // 4. Write tab signals (active authors from open tabs)
  await writeTabSignals(activeAuthors);
  console.log(`tab signals cached: ${activeAuthors.length} active authors`);
}

async function writeTabSignals(activeAuthors) {
  const contentB64 = Buffer.from(JSON.stringify({
    updated_at: new Date().toISOString(),
    active_authors: activeAuthors,
  })).toString("base64");

  let sha = "";
  try {
    const resp = JSON.parse(execFileSync("curl", [
      "-s", "-H", `Authorization: Bearer ${GH_TOKEN}`,
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
  execFileSync("curl", [
    "-s", "-X", "PUT",
    "-H", `Authorization: Bearer ${GH_TOKEN}`,
    "-H", "Accept: application/vnd.github+json",
    "-H", "Content-Type: application/json",
    "-d", body,
    `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(SIGNALS_PATH)}`
  ], { encoding: "utf8" });
}

main().catch(e => {
  console.error("error:", e.message);
  process.exit(1);
});
