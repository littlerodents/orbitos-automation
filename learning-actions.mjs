#!/usr/bin/env node
// learning-actions: 每日学习行动生成（三线各一条，进飞书行动追踪表）
//   [学习·Agent]   从最新书签整理 strong 项挑 1 条
//   [学习·PG]      本周精读篇目（周一开新篇，其余天提醒进度）
//   [学习·独立开发] 4 账号最新推文挑最有料 1 条
// 旧学习行动未读 → 自动改"已过期"（不污染 00 该做 视图，不累计卡龄）
// 手动: node learning-actions.mjs
// 定时: 由 orbitos-daily-brief.mjs 尾部调用（日报生成后）

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { loadConfig } from "./lib/config.mjs";

const cfg = loadConfig();
const VAULT = cfg.vault_path;
const SAFE_PATH = `/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/Users/evander/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`;
const T = JSON.parse(readFileSync(join(homedir(), ".config/orbitos-automation/tracker.config.json"), "utf8"));
const CACHE = join(homedir(), ".config/orbitos-automation/learning-cache.json");
const PG_STATE = join(homedir(), ".config/orbitos-automation/pg-progress.json");

const DAY = 86400e3;
const todayStr = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const todayMs = new Date(`${todayStr}T00:00:00+08:00`).getTime();
const dstr = v => String(v ?? "").slice(0, 10);
const s = v => (Array.isArray(v) ? v[0] : v) ?? "";

function lark(args) {
  const r = spawnSync(cfg.lark_cli_path, [...args, "--as", "user", "--format", "json"], {
    encoding: "utf8", env: { ...process.env, PATH: `${SAFE_PATH}:${process.env.PATH || ""}` },
  });
  if (r.status !== 0) throw new Error(`lark-cli exit ${r.status}`);
  const out = JSON.parse(r.stdout);
  if (!out.ok) throw new Error(out.error?.message || "?");
  return out.data ?? out;
}
function listRows(tableId) {
  const d = lark(["base", "+record-list", "--base-token", T.base_token, "--table-id", tableId]);
  const cols = d.fields || [];
  return (d.data || []).map((vals, i) => {
    const rec = { _id: d.record_id_list?.[i] };
    cols.forEach((c, j) => { rec[c] = vals[j]; });
    return rec;
  });
}
function batchUpdate(updates) { if (Object.keys(updates).length) lark(["base", "+record-batch-update", "--base-token", T.base_token, "--table-id", T.action_table, "--json", JSON.stringify({ update_records: updates })]); }
function batchCreate(recs) { if (recs.length) lark(["base", "+record-batch-create", "--base-token", T.base_token, "--table-id", T.action_table, "--json", JSON.stringify({ create_records: recs })]); }

// ---------- 线1：Agent/技术（最新书签 strong） ----------
function pickAgent() {
  try {
    const dir = join(VAULT, "30_Research/Selected");
    const files = readdirSync(dir).filter(f => /^bookmarks-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, 3);
    for (const f of files) {
      const raw = readFileSync(join(dir, f), "utf8");
      const blocks = raw.split(/(?=^### \[)/m).filter(b => b.startsWith("### [strong]"));
      if (blocks.length) {
        const b = blocks[0];
        const title = (b.match(/### \[strong\]\s*(.+)/) || [])[1]?.trim() || "strong 书签";
        const link = (b.match(/原文: (\S+)/) || [])[1] || "";
        const actionable = (b.match(/- 可做: (.+)/m) || [])[1]?.trim() || "精读并提炼可复用点";
        return { 行动: `[学习·Agent] 精读：${title.slice(0, 60)} → ${actionable.slice(0, 60)}${link ? `（原文: ${link}）` : ""}`, 状态: ["未动"], 开始卡于: Date.now(), 为什么这么做: "为什么：三线学习流·Agent 技术线——最近书签整理的 strong 信号。\n最优性：经 DeepSeek 对比全批书签筛出，直接改变打法的资料。\n时间账：精读约 15-30 分钟，读完勾已完成。" };
      }
    }
  } catch {}
  return null;
}

// ---------- 线2：PG（每周一篇精读） ----------
function pgProgress() {
  try { return JSON.parse(readFileSync(PG_STATE, "utf8")); } catch { return { currentIdx: 0, startedOn: null, finished: [] }; }
}
function pickPg() {
  const cache = (() => { try { return JSON.parse(readFileSync(CACHE, "utf8")); } catch { return { pg: { queue: [] } }; }; })();
  const queue = cache.pg?.queue || [];
  if (!queue.length) return null;
  const st = pgProgress();
  // 本周篇目：没开始或上周开未完成 → 从 currentIdx 开新篇（周一或首次运行）
  const dow = new Date(todayMs).getDay();
  const isMonday = dow === 1;
  if (!st.startedOn || (isMonday && !st.finishedThisWeek)) {
    // 换新篇条件：startedOn 是上周或更早 且（已完成标记 finishedThisWeek 或 已拖超过7天）
    if (st.startedOn) {
      const ageDays = Math.round((todayMs - new Date(`${st.startedOn}T00:00:00+08:00`).getTime()) / DAY);
      if (ageDays > 7 || st.finishedThisWeek) st.currentIdx = Math.min(st.currentIdx + 1, queue.length - 1);
    }
    st.startedOn = todayStr;
    st.finishedThisWeek = false;
  }
  const essay = queue[st.currentIdx];
  writeFileSync(PG_STATE, JSON.stringify(st, null, 1));
  return { 行动: `[学习·PG] 本周精读：《${essay.title}》（${essay.url}）→ 读完写 3 句话笔记存 40_Wiki`, 状态: ["未动"], 开始卡于: Date.now(), 为什么这么做: `为什么：三线学习流·Paul Graham 线——每周 1-2 篇精读（你定的节奏），队列第 ${st.currentIdx + 1}/${queue.length} 篇。\n最优性：精选入门队列（从短到长），读完进 40_Wiki 变成可复用知识。\n时间账：每天读一节 15-20 分钟；读完把本条改已完成。` };
}

// ---------- 线3：独立开发者（4 账号最新推） ----------
function pickDev() {
  try {
    const cache = JSON.parse(readFileSync(CACHE, "utf8"));
    const names = { thedankoe: "Dan Koe", marclou: "Marc Lou", levelsio: "Pieter Levels", tdinh_me: "Tony Dinh" };
    // 取所有账号最新 1-2 条，挑文本最长（最可能有干货）的
    const cands = [];
    for (const [h, list] of Object.entries(cache.tweets || {})) {
      for (const t of (list || []).slice(0, 2)) {
        if (t.text && t.text.length > 80) cands.push({ h, name: names[h] || h, ...t });
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.text.length - a.text.length);
    const c = cands[0];
    return { 行动: `[学习·独立开发] 读 ${c.name} 的推文：${c.text.replace(/\s+/g, " ").slice(0, 70)}…（原文: ${c.url}）→ 提炼 1 条可偷的打法`, 状态: ["未动"], 开始卡于: Date.now(), 为什么这么做: `为什么：三线学习流·独立开发者线——你指定的四位老师之一 ${c.name}。\n最优性：从其最新推文中选信息量最大的一条。\n时间账：10 分钟读完 + 1 句笔记。` };
  } catch {}
  return null;
}

async function main() {
  const rows = listRows(T.action_table);
  // 1) 过期昨天的学习行动
  const updates = {};
  for (const r of rows) {
    const text = s(r.行动);
    if (text.startsWith("[学习·") && s(r.状态) === "未动" && dstr(r.开始卡于) !== todayStr) {
      updates[r._id] = { 状态: ["已过期"] };
    }
  }
  batchUpdate(updates);
  // 2) 今天的学习行动（幂等：今天已有就跳过）
  const todayLearn = rows.filter(r => s(r.行动).startsWith("[学习·") && dstr(r.开始卡于) === todayStr);
  const have = new Set(todayLearn.map(r => s(r.行动).match(/^\[学习·([^\]]+)\]/)?.[1]));
  const creates = [];
  for (const [line, item] of [["Agent", pickAgent()], ["PG", pickPg()], ["独立开发", pickDev()]]) {
    if (item && !have.has(line)) creates.push(item);
  }
  batchCreate(creates);
  console.log(`learning actions: expired=${Object.keys(updates).length}, created=${creates.length}, existing=${todayLearn.length}`);
}
main().catch(e => { console.error(e); process.exit(1); });
