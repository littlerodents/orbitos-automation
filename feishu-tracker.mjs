#!/usr/bin/env node
// feishu-tracker (简化版 v2): 飞书追踪表唯一权威，只做三件事
//   1. 每日总结行 upsert（日期/TL;DR/行动完成/新增书签；不碰用户手动的 精读打卡/备注）
//   2. 行动追踪卡龄刷新（起始日期记在本地 state 文件，表里只留 4 列）
//   3. --weekly 时追加周复盘行
// 不再有 Action_Queue.md 双向同步、不再有 30 分钟轮询（每天 8:00 日报后由
// orbitos-daily-brief.mjs 调用一次，周日随周报调用）。
// 手动: node feishu-tracker.mjs [--weekly]

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { loadConfig } from "./lib/config.mjs";

const cfg = loadConfig();
const VAULT = cfg.vault_path;
const LARK = cfg.lark_cli_path;
const T = JSON.parse(readFileSync(join(homedir(), ".config/orbitos-automation/tracker.config.json"), "utf8"));
const STATE_PATH = join(homedir(), ".config/orbitos-automation/tracker-state.json");
const weekly = process.argv.includes("--weekly");

const DAY = 86400e3;
const todayStr = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const todayMs = new Date(`${todayStr}T00:00:00+08:00`).getTime();

// launchd 无 PATH：lark-cli shebang 依赖 node，必须注入
const SAFE_PATH = `/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/Users/evander/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`;
function lark(args) {
  const r = spawnSync(LARK, [...args, "--as", "user", "--format", "json"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${SAFE_PATH}:${process.env.PATH || ""}` },
  });
  if (r.status !== 0) throw new Error(`lark-cli exit ${r.status}: ${(r.stderr || r.stdout || "").slice(0, 300)}`);
  const out = JSON.parse(r.stdout);
  if (!out.ok) throw new Error(`lark-cli error: ${out.error?.message || "?"}`);
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

function batchUpdate(tableId, updateRecords) {
  if (!Object.keys(updateRecords).length) return;
  lark(["base", "+record-batch-update", "--base-token", T.base_token, "--table-id", tableId,
    "--json", JSON.stringify({ update_records: updateRecords })]);
}

function batchCreate(tableId, createRecords) {
  if (!createRecords.length) return;
  lark(["base", "+record-batch-create", "--base-token", T.base_token, "--table-id", tableId,
    "--json", JSON.stringify({ create_records: createRecords })]);
}

const s = v => (Array.isArray(v) ? v[0] : v) ?? "";
const dstr = v => String(v ?? "").slice(0, 10);
const norm = t => String(t ?? "").replace(/[\s()[\]（）：:，,。.·、\-—/？?"“”']/g, "");

// ---------- 行动卡龄（起始日期在 state 文件，新行动首见日记为今天） ----------
function loadState() { try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return { start_dates: {} }; } }
function startDateFor(text, state) {
  const key = norm(text).slice(0, 8);
  if (state.start_dates[key]) return state.start_dates[key];
  state.start_dates[key] = todayStr;
  try { writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch {}
  return todayStr;
}

function refreshAges() {
  const state = loadState();
  const rows = listRows(T.action_table);
  const updates = {};
  for (const r of rows) {
    const status = s(r.状态);
    if (status === "已完成" || status === "已放弃") continue;
    const start = startDateFor(s(r.行动), state);
    const age = Math.max(0, Math.round((todayMs - new Date(`${start}T00:00:00+08:00`).getTime()) / DAY));
    if (Number(r.卡龄天数) !== age) updates[r._id] = { 卡龄天数: age };
  }
  batchUpdate(T.action_table, updates);
  return rows;
}

// ---------- 每日数据 ----------
function readBriefTldr(ds) {
  try {
    const raw = readFileSync(join(VAULT, `00_Inbox/brief-${ds}.md`), "utf8");
    return (raw.match(/## TL;DR\n+(.+)/) || [])[1]?.trim() || "";
  } catch { return ""; }
}

function countBookmarks(ds) {
  let n = 0;
  try {
    const dir = join(VAULT, "30_Research/Selected");
    for (const f of readdirSync(dir).filter(f => f === `bookmarks-${ds}.md`)) {
      n += (readFileSync(join(dir, f), "utf8").match(/^### /gm) || []).length;
    }
  } catch {}
  return n;
}

// ---------- 每日总结行（6 列；精读打卡/备注归用户，不写入） ----------
function upsertDailyRow(actionRows) {
  const rows = listRows(T.daily_table);
  const done = actionRows.filter(r => s(r.状态) === "已完成").length;
  const fields = {
    "TL;DR": readBriefTldr(todayStr),
    行动完成: `${done}/${actionRows.length}`,
    新增书签: countBookmarks(todayStr),
  };
  const todayRow = rows.find(r => dstr(r.日期) === todayStr);
  if (todayRow) {
    batchUpdate(T.daily_table, { [todayRow._id]: fields });
    console.log(`daily row updated: ${todayStr}`);
  } else {
    batchCreate(T.daily_table, [{ 日期: todayMs, ...fields }]);
    console.log(`daily row created: ${todayStr}`);
  }
}

// ---------- 周复盘行 ----------
function upsertWeeklyRow(actionRows) {
  const rows = listRows(T.daily_table);
  const key = `周复盘 ${todayStr}`;
  if (rows.some(r => s(r["TL;DR"]) === key)) return console.log("weekly row exists");
  const weekAgo = todayMs - 6 * DAY;
  const inWeek = rows.filter(r => {
    const t = dstr(r.日期);
    if (t.length !== 10 || t === todayStr) return false;
    const ms = new Date(`${t}T00:00:00+08:00`).getTime();
    return ms >= weekAgo && ms <= todayMs;
  });
  const bmN = inWeek.reduce((a, r) => a + (Number(r.新增书签) || 0), 0);
  const readDays = inWeek.filter(r => r.精读打卡 === true).length;
  const done = actionRows.filter(r => s(r.状态) === "已完成").length;
  batchCreate(T.daily_table, [{
    日期: todayMs, "TL;DR": key,
    行动完成: `${done}/${actionRows.length}`,
    新增书签: bmN,
    备注: `本周精读 ${readDays} 天`,
  }]);
  console.log(`weekly row created: ${key}`);
}

async function main() {
  const actionRows = refreshAges();
  if (weekly) upsertWeeklyRow(actionRows);
  else upsertDailyRow(actionRows);
  console.log(`tracker sync done (actions=${actionRows.length})`);
}
main().catch(e => { console.error(e); process.exit(1); });
