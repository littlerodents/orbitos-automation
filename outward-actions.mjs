#!/usr/bin/env node
// outward-actions: 每日「对外动作」生成 + 过期 + 豁免（2026-10-25）
//   为什么存在：追踪表 83% 是学习类、9% 是对外类（对外 6 条卡 26 天）。
//   这个模块每天只在追踪表放 1 条对外动作——做完打勾，没做次日日报会被扣留。
// 用法:
//   node outward-actions.mjs                 # 幂等：过昨天的期 + 建今天的（intake-loop 每 10 分钟调）
//   node outward-actions.mjs --status        # 只打印昨天的完成情况（调试）
//   node outward-actions.mjs --excuse 出差   # 今天豁免（出差/生病）：仍生成行动，但不参与扣留判定
// 状态: ~/.config/orbitos-automation/outward-gate.json（豁免日 + 最近一次生成日）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { loadConfig } from "./lib/config.mjs";

const cfg = loadConfig();
const SAFE_PATH = `/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/Users/evander/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`;
const STATE_DIR = join(homedir(), ".config", "orbitos-automation");
const GATE_STATE = join(STATE_DIR, "outward-gate.json");
const TRACKER = join(STATE_DIR, "tracker.config.json");

export const OUTWARD_PREFIX = "[对外·";
export const OUTWARD_TAG = "[对外·私聊]";

function todayStr(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}
function shiftDay(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00+08:00`);
  d.setDate(d.getDate() + delta);
  return todayStr(d);
}

function lark(args) {
  const r = spawnSync(cfg.lark_cli_path, [...args, "--as", "user", "--format", "json"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${SAFE_PATH}:${process.env.PATH || ""}` },
  });
  if (r.status !== 0) throw new Error(`lark-cli exit ${r.status}: ${(r.stderr || "").slice(0, 200)}`);
  const out = JSON.parse(r.stdout || "{}");
  if (!out.ok) throw new Error(out.error?.message || "lark error");
  return out.data ?? out;
}

export function loadGateState() {
  try {
    const d = JSON.parse(readFileSync(GATE_STATE, "utf8"));
    return { excused: Array.isArray(d.excused) ? d.excused : [], lastCreated: d.lastCreated || null };
  } catch {
    return { excused: [], lastCreated: null };
  }
}

function saveGateState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  // 只保留最近 90 天的豁免日，文件不无限增长
  const cutoff = shiftDay(todayStr(), -90);
  const excused = [...new Set(state.excused)].filter((d) => d >= cutoff).sort();
  writeFileSync(GATE_STATE, JSON.stringify({ ...state, excused }, null, 1));
}

// ---------------- 纯函数（可测，不碰网络） ----------------

// 昨天的对外动作是否完成 → 决定今天的日报放不放行
export function decideGate(actions, today, excused = []) {
  const yesterday = shiftDay(today, -1);
  const mine = (actions || []).filter((a) => String(a.text || "").startsWith(OUTWARD_PREFIX));
  if (excused.includes(yesterday)) {
    return { gate: "allow", reason: "excused", streak: 0, yesterday };
  }
  const yRows = mine.filter((a) => a.start === yesterday);
  if (!yRows.length) {
    // 系统刚上线 / 昨天没生成记录：不因无记录而惩罚
    return { gate: "allow", reason: "no-record", streak: 0, yesterday };
  }
  const done = yRows.some((a) => a.status === "已完成");
  if (done) {
    return { gate: "allow", reason: "done", streak: 0, yesterday };
  }
  // 连续未完成天数：从昨天往前数（只数有记录且未完成、且未豁免的天）
  let streak = 0;
  let cursor = yesterday;
  for (let i = 0; i < 30; i += 1) {
    if (excused.includes(cursor)) break;
    const rows = mine.filter((a) => a.start === cursor);
    if (!rows.length) break;
    if (rows.some((a) => a.status === "已完成")) break;
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }
  return { gate: "withhold", reason: "not-done", streak, yesterday };
}

// 21:00 提醒：对外优先于读书
export function decideReminder({ outwardPending, readingPending }) {
  if (outwardPending) {
    return {
      type: "outward",
      text: [
        "⏰ 今天对外动作为 0。",
        "",
        "私聊 1 个目标用户（10 分钟）：发一句「我在做 safety-eval，想听你 10 分钟吐槽」→ 记下对方原话。",
        "",
        "**没做的话，明天的日报不会生成。**",
      ].join("\n"),
    };
  }
  if (readingPending) return { type: "reading", text: null }; // 文案由调用方按最短学习行动拼
  return { type: "silent", text: null };
}

function buildAction(today) {
  return {
    行动: `${OUTWARD_TAG} 私聊 1 个目标用户（从「定向私聊 1/20」名单挑）→ 发一句「我在做 safety-eval，想听你 10 分钟吐槽」→ 把对方原话回填到这条`,
    状态: ["未动"],
    开始卡于: Date.now(),
    为什么这么做:
      "为什么：追踪表 83% 是学习、9% 是对外；对外 6 条已卡 26 天。这条是唯一每天强制的对外动作。\n最优性：不看资料、不做系统，只发一条消息——5 分钟能开始。\n时间账：10 分钟；没做则次日日报被扣留（这是设计，不是故障）。",
  };
}

// ---------------- 主流程 ----------------

export function planOutwardWork(rows, today, excused = []) {
  const mine = (rows || []).filter((r) => String(r.text || "").startsWith(OUTWARD_PREFIX));
  const expire = mine.filter((r) => r.status === "未动" && r.start && r.start !== today);
  const hasToday = mine.some((r) => r.start === today);
  return { expire, create: hasToday ? null : buildAction(today), hasToday };
}

async function main() {
  const args = process.argv.slice(2);
  const today = todayStr();
  const state = loadGateState();

  const T = JSON.parse(readFileSync(TRACKER, "utf8"));
  const d = lark(["base", "+record-list", "--base-token", T.base_token, "--table-id", T.action_table]);
  const cols = d.fields || [];
  const rows = (d.data || []).map((vals, i) => {
    const rec = { _id: d.record_id_list?.[i] };
    cols.forEach((c, j) => { rec[c] = vals[j]; });
    return {
      _id: rec._id,
      text: String((Array.isArray(rec["行动"]) ? rec["行动"][0] : rec["行动"]) ?? ""),
      status: String((Array.isArray(rec["状态"]) ? rec["状态"][0] : rec["状态"]) ?? ""),
      start: String(rec["开始卡于"] ?? "").slice(0, 10),
    };
  });

  if (args.includes("--excuse")) {
    const reason = args[args.indexOf("--excuse") + 1] || "未说明";
    if (!state.excused.includes(today)) state.excused.push(today);
    saveGateState(state);
    console.log(`excused ${today} (${reason}) — 今天的对外动作不参与扣留判定`);
    return;
  }

  if (args.includes("--status")) {
    console.log(JSON.stringify(decideGate(rows, today, state.excused), null, 1));
    return;
  }

  const plan = planOutwardWork(rows, today, state.excused);
  const updates = {};
  for (const r of plan.expire) updates[r._id] = { 状态: ["已过期"] };
  if (Object.keys(updates).length) {
    lark(["base", "+record-batch-update", "--base-token", T.base_token, "--table-id", T.action_table, "--json", JSON.stringify({ update_records: updates })]);
  }
  if (plan.create) {
    lark(["base", "+record-batch-create", "--base-token", T.base_token, "--table-id", T.action_table, "--json", JSON.stringify({ create_records: [plan.create] })]);
    state.lastCreated = today;
    saveGateState(state);
  }
  const gate = decideGate(rows, today, state.excused);
  console.log(`outward-actions: today=${today} expired=${plan.expire.length} created=${plan.create ? 1 : 0} yesterday_gate=${gate.gate} streak=${gate.streak}`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(thisFile)) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
