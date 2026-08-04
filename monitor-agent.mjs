#!/usr/bin/env node
// monitor-agent runner: 给 monitor-agent-logic.mjs 接真线 ——
// timeline 缓存(GitHub) → 互动过滤 → DeepSeek 增量判断 → digest 写回 vault 00_Inbox/
// 手动: node monitor-agent.mjs
// 定时: com.evander.monitor-agent.plist（每日早/晚各一次，对应 morning/afternoon）
import { loadConfig } from "./lib/config.mjs";
import {
  processMonitorTask,
  setTimelineGetter, setTweetContentGetter, setGhCaller,
  setDeepSeekCaller, setStateVars,
} from "./monitor-agent-logic.mjs";

const cfg = loadConfig();
const GH_TOKEN = process.env.GITHUB_TOKEN || cfg.github_token || "";
const DS_KEY = process.env.DEEPSEEK_API_KEY || cfg.deepseek_api_key || "";
const REPO = `${cfg.github_owner}/${cfg.github_repo}`;
const BRANCH = cfg.github_branch || "main";
const API = `https://api.github.com/repos/${REPO}/contents`;

const ghHeaders = () => ({
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
});

// 网络抖动重试：指数退避 3 次，只对网络错误和 5xx 重试（4xx 是确定性结果，重试无意义）
// 背景：2026-08-03 18:30 定时跑曾因一次 fetch failed 整轮弃权
async function withRetry(fn, attempts = 3, baseMs = 1000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        console.error(`retry ${i + 1}/${attempts - 1} after: ${e.message}`);
        await new Promise(r => setTimeout(r, baseMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}

async function resilientFetch(url, opts) {
  return withRetry(async () => {
    const resp = await fetch(url, opts); // 网络错误直接 throw → 重试
    if (resp.status >= 500) throw new Error(`http ${resp.status}`); // 5xx → 重试
    return resp;
  });
}

// logic 模块约定：GET 返回 json（文件 {content} 或目录数组），PUT 写入。
// PUT 自动补 sha —— 已存在文件的更新不带 sha 会被 GitHub 拒绝。
async function ghCaller(method, path, body) {
  const url = `${API}/${encodeURIComponent(path)}`;
  if (method === "GET") {
    const resp = await resilientFetch(`${url}?ref=${BRANCH}`, { headers: ghHeaders() });
    if (!resp.ok) throw new Error(`GET ${path}: ${resp.status}`);
    return resp.json();
  }
  let sha;
  try { sha = (await ghCaller("GET", path, null)).sha; } catch { /* 新文件 */ }
  const resp = await resilientFetch(url, {
    method: "PUT",
    headers: ghHeaders(),
    body: JSON.stringify({ ...body, branch: BRANCH, ...(sha ? { sha } : {}) }),
  });
  const text = await resp.text(); // 先 text 后判 ok 再 parse，与 deepSeekCaller 同款防护
  if (!resp.ok) throw new Error(`PUT ${path}: ${resp.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

setGhCaller(ghCaller);
setStateVars({ OWNER: cfg.github_owner, REPO: cfg.github_repo, BRANCH });

setTimelineGetter(async () => {
  const file = await ghCaller("GET", "00_Inbox/.monitor-timeline-cache.json", null);
  const data = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  return data.tweets || [];
});

// 抓推文全文：缓存里已有 ≤500 字正文，够用，不再额外请求（null = 回退用缓存文本）
setTweetContentGetter(async () => null);

setDeepSeekCaller(async (messages) => {
  const resp = await resilientFetch(cfg.deepseek_url, {
    method: "POST",
    headers: { Authorization: `Bearer ${DS_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.deepseek_model, messages }),
  });
  // 先查 ok 再 parse：错误页可能是 HTML，直接 .json() 会抛 SyntaxError 被下游当"无增量"吞掉
  const text = await resp.text();
  if (!resp.ok) throw new Error(`deepseek: ${resp.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
});

async function main() {
  if (!GH_TOKEN) { console.error("no github token (env GITHUB_TOKEN or config github_token)"); process.exit(1); }
  if (!DS_KEY) { console.error("no deepseek key (env DEEPSEEK_API_KEY or config deepseek_api_key)"); process.exit(1); }

  const result = await processMonitorTask();
  if (result.action !== "write" || !result.monitor_path) {
    console.log("nothing to write");
    return;
  }
  const put = await ghCaller("PUT", result.monitor_path, {
    message: result.monitor_msg,
    content: result.monitor_b64,
  });
  console.log(
    `digest written: ${result.monitor_path} entries=${result.entries} ` +
    `scanned=${result.tweetsScanned} filtered=${result.tweetsAfterFilter} ` +
    `commit=${(put.commit?.sha || "").slice(0, 7)}`
  );
}

main().catch(e => {
  console.error("error:", e.message);
  process.exit(1);
});
