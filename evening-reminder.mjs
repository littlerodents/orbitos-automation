#!/usr/bin/env node
// evening-reminder: 21:00 学习重提醒
//   今日精读打卡没勾 → 飞书轻提醒（附今天最短的一条学习行动链接）
//   已勾 → 静默退出（不打扰）
// 手动: node evening-reminder.mjs
// 定时: com.evander.orbitos-evening-reminder（每天 21:00）

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { loadConfig } from "./lib/config.mjs";

const cfg = loadConfig();
const SAFE_PATH = `/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/Users/evander/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`;
const T = JSON.parse(readFileSync(join(homedir(), ".config/orbitos-automation/tracker.config.json"), "utf8"));
const todayStr = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const dstr = v => String(v ?? "").slice(0, 10);
const s = v => (Array.isArray(v) ? v[0] : v) ?? "";

function lark(args) {
  const r = spawnSync(cfg.lark_cli_path, [...args, "--as", "user", "--format", "json"], {
    encoding: "utf8", env: { ...process.env, PATH: `${SAFE_PATH}:${process.env.PATH || ""}` },
  });
  if (r.status !== 0) return null;
  try { const out = JSON.parse(r.stdout); return out.ok ? (out.data ?? out) : null; } catch { return null; }
}

function dm(text) {
  lark(["im", "+messages-send", "--as", "user", "--user-id", cfg.feishu_user_id, "--markdown", text]);
  console.log("reminder sent");
}

function main() {
  // 1) 今日打卡状态
  const d = lark(["base", "+record-list", "--base-token", T.base_token, "--table-id", T.daily_table]);
  if (!d) return console.log("daily table unreadable, skip");
  const cols = d.fields || [];
  const di = cols.indexOf("日期");
  const todayRow = (d.data || []).find(r => dstr(r[di]) === todayStr);
  if (todayRow && todayRow[cols.indexOf("精读打卡")] === true) return console.log("checked in, stay silent");

  // 2) 找今天的学习行动，挑最短的
  const a = lark(["base", "+record-list", "--base-token", T.base_token, "--table-id", T.action_table]);
  if (!a) return console.log("action table unreadable, skip");
  const acols = a.fields || [];
  const ai = acols.indexOf("行动"), si = acols.indexOf("状态"), ki = acols.indexOf("开始卡于");
  const learn = (a.data || [])
    .map(r => ({ text: s(r[ai]), status: s(r[si]), start: dstr(r[ki]) }))
    .filter(r => r.text.startsWith("[学习·") && r.status === "未动" && r.start === todayStr);
  if (!learn.length) return dm("⏰ 今天还没读书（精读打卡未勾）。今天的阅读队列还没生成或已过期——随便挑一条旧的补上也行，10 分钟就够。");

  // 按文本长度当"最短"的代理（带分钟数的优先取分钟数）
  const withMin = learn.map(r => ({ ...r, min: (r.text.match(/(\d+)[- ]?分钟/) || [])[1] ? Number(r.text.match(/(\d+)[- ]?分钟/)[1]) : 99 }));
  withMin.sort((x, y) => x.min - y.min);
  const pick = withMin[0];
  dm(`⏰ 今天还没读书（精读打卡未勾）。最短的一条只要 ${pick.min === 99 ? "10" : pick.min} 分钟：\n\n${pick.text.slice(0, 150)}\n\n读完去追踪表勾一下精读打卡 📖`);
}
main();
