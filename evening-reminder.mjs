#!/usr/bin/env node
// evening-reminder: 21:00 提醒（2026-10-25 改为「教练」模式）
//   1) 今天的对外动作没做 → 只发对外提醒，并预告「明天日报不会生成」（硬约束）
//   2) 对外已做、精读打卡没勾 → 发学习提醒（附最短的一条）
//   3) 都完成 → 静默
//   跟打卡状态无关：对外优先。
// 手动: node evening-reminder.mjs
// 定时: com.evander.orbitos-evening-reminder（每天 21:00）

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { loadConfig } from "./lib/config.mjs";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { OUTWARD_PREFIX, decideReminder } from "./outward-actions.mjs";

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
  // 0) 对外动作优先（2026-10-25）：没做就只发这一条，并预告硬约束
  const a = lark(["base", "+record-list", "--base-token", T.base_token, "--table-id", T.action_table]);
  if (!a) return console.log("action table unreadable, skip");
  const acols = a.fields || [];
  const ai = acols.indexOf("行动"), si = acols.indexOf("状态"), ki = acols.indexOf("开始卡于");
  const allActs = (a.data || []).map(r => ({ text: s(r[ai]), status: s(r[si]), start: dstr(r[ki]) }));
  const outwardToday = allActs.filter(r => r.text.startsWith(OUTWARD_PREFIX) && r.start === todayStr);
  const outwardPending = outwardToday.some(r => r.status !== "已完成");

  // 1) 今日打卡状态
  const d = lark(["base", "+record-list", "--base-token", T.base_token, "--table-id", T.daily_table]);
  const checkedIn = (() => {
    if (!d) return false;
    const cols = d.fields || [];
    const di = cols.indexOf("日期");
    const todayRow = (d.data || []).find(r => dstr(r[di]) === todayStr);
    return Boolean(todayRow && todayRow[cols.indexOf("精读打卡")] === true);
  })();

  const learn = allActs.filter(r => r.text.startsWith("[学习·") && r.status === "未动" && r.start === todayStr);
  const decision = decideReminder({ outwardPending, readingPending: !checkedIn });

  if (decision.type === "outward") return dm(decision.text);
  if (decision.type === "silent") return console.log("all done, stay silent");
  if (checkedIn) return console.log("reading checked in, stay silent");
  if (!learn.length) return dm("⏰ 今天还没读书（精读打卡未勾）。今天的阅读队列还没生成或已过期——随便挑一条旧的补上也行，10 分钟就够。");

  // 按文本长度当"最短"的代理（带分钟数的优先取分钟数）
  const withMin = learn.map(r => ({ ...r, min: (r.text.match(/(\d+)[- ]?分钟/) || [])[1] ? Number(r.text.match(/(\d+)[- ]?分钟/)[1]) : 99 }));
  withMin.sort((x, y) => x.min - y.min);
  const pick = withMin[0];
  dm(`⏰ 今天还没读书（精读打卡未勾）。最短的一条只要 ${pick.min === 99 ? "10" : pick.min} 分钟：\n\n${pick.text.slice(0, 150)}\n\n读完去追踪表勾一下精读打卡 📖`);
}
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(thisFile)) {
  main();
}
