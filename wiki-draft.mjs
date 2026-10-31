#!/usr/bin/env node
// wiki-draft: 从本周产物里抽 1-2 条值得沉淀的概念，生成 Wiki 草稿（2026-10-31）
// 方案 B：系统起草，主人改。草稿标 status: draft，改完自己改成 evergreen。
// 原则：
//   1) 只抽「可复用的概念/框架/判断」，不抽日志、待办、进度
//   2) 宁可少也不要滥：每周最多 2 条，抽不出就明确说"无"
//   3) 已有同名/近似条目的不重复生成
// 用法: node wiki-draft.mjs [--dry-run] [--lookback 7]

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./lib/config.mjs";

const cfg = loadConfig();
const VAULT = cfg.vault_path;
const DS_KEY = process.env.DEEPSEEK_API_KEY || cfg.deepseek_api_key || "";
const WIKI_DIR = join(VAULT, "40_Wiki");
const INBOX = join(VAULT, "00_Inbox");
const DAILY = join(VAULT, "10_Daily");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const li = process.argv.indexOf("--lookback");
const LOOKBACK = li > -1 ? Number(process.argv[li + 1]) || 7 : 7;

function log(m) { process.stdout.write(`[wiki-draft] ${m}\n`); }

function recentFiles(dir, days, filter = () => true) {
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - days * 86400e3;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && filter(f))
    .map((f) => ({ f, p: join(dir, f), m: statSafe(join(dir, f)) }))
    .filter((x) => x.m >= cutoff)
    .sort((a, b) => b.m - a.m);
}
function statSafe(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

async function callDeepSeek(messages) {
  const resp = await fetch(cfg.deepseek_url, {
    method: "POST",
    headers: { Authorization: `Bearer ${DS_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.deepseek_model, messages, temperature: 0.3 }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`deepseek ${resp.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// 已有的 Wiki 条目（用于去重）
function existingWikiTitles() {
  if (!existsSync(WIKI_DIR)) return new Set();
  return new Set(readdirSync(WIKI_DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)));
}

function readHead(p, max = 2500) {
  try { return readFileSync(p, "utf8").slice(0, max); } catch { return ""; }
}

async function main() {
  if (!DS_KEY) { console.error("no deepseek key"); process.exit(1); }
  if (!existsSync(WIKI_DIR)) mkdirSync(WIKI_DIR, { recursive: true });

  // 输入：本周的周报 + 日报（不含待办内容，只给结论段）
  const weeklies = recentFiles(DAILY, LOOKBACK, (f) => /^(personal|company)-W/.test(f));
  const briefs = recentFiles(INBOX, LOOKBACK, (f) => /^brief-/.test(f)).slice(0, 5);
  if (!weeklies.length && !briefs.length) return log("本周无产物，跳过");

  const corpus = [
    ...weeklies.map((x) => `--- ${x.f} ---\n${readHead(x.p, 3000)}`),
    ...briefs.map((x) => `--- ${x.f} ---\n${readHead(x.p, 1200)}`),
  ].join("\n\n");

  const existing = [...existingWikiTitles()];
  const system = `你从 Evander 的周报/日报里提取「值得长期记住的概念」。
他的主线：一人公司(OPC)、程序化SEO、个人AI基础设施、AI agent 工程。

只提取「可复用的概念/框架/判断」，例如：
- 一个反直觉的判断（"X 不是 Y，而是 Z"）
- 一个可复用的方法论（"做 X 时先做 Y"）
- 一个被验证过的取舍（"宁可 A 也不要 B，因为 C"）

禁止提取：
- 待办事项、进度汇报、卡点提醒
- 具体项目的临时决定
- 泛泛的鸡汤

已有条目（不要重复）：${existing.join("、") || "（空）"}

输出 JSON 数组，最多 2 条，抽不出就输出 []：
[{"title":"≤12 字的条目标题","essence":"一句话核心，≤40 字","body":"150-250 字的展开：这个判断是什么、为什么成立、在什么条件下不成立","why":"为什么值得长期记住，≤40 字"}]
只输出 JSON，不要 markdown 代码块。`;

  const resp = await callDeepSeek([
    { role: "system", content: system },
    { role: "user", content: `本周材料：\n\n${corpus}\n\n请提取值得长期记住的概念。` },
  ]);

  let content = (resp.choices?.[0]?.message?.content || "").trim().replace(/^```(json)?\n?|```$/g, "");
  let items = [];
  try { items = JSON.parse(content); } catch { log(`LLM 输出非 JSON，跳过：${content.slice(0, 150)}`); process.exit(0); }
  if (!Array.isArray(items) || !items.length) return log("本周无值得沉淀的概念（LLM 返回空）");

  const created = [];
  for (const it of items.slice(0, 2)) {
    const title = String(it.title || "").trim();
    if (!title) continue;
    if (existingWikiTitles().has(title)) { log(`已存在，跳过：${title}`); continue; }

    const dateStr = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
    const sourceFile = weeklies[0]?.f.replace(/\.md$/, "") || briefs[0]?.f.replace(/\.md$/, "") || "";
    const md = `---
type: wiki
status: draft
created: ${dateStr}
source: "${sourceFile ? `[[${sourceFile}]]` : ""}"
tags:
  - draft
---

# ${title}

${it.essence || ""}

## 展开

${it.body || ""}

## 为什么值得记

${it.why || ""}

## 我的补充

<!-- 这一节留给你：改完把 status 改成 evergreen，或直接删掉这条 -->
`;
    const path = join(WIKI_DIR, `${title}.md`);
    if (dryRun) {
      log(`[dry-run] 会创建 40_Wiki/${title}.md`);
      log(`  essence: ${it.essence || ""}`);
    } else {
      writeFileSync(path, md);
      created.push(title);
      log(`✓ 40_Wiki/${title}.md`);
    }
  }

  if (!created.length && !dryRun) log("没有新草稿");
  else if (created.length) log(`本周生成 ${created.length} 条草稿，待你审阅（status: draft）`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
