import assert from "node:assert/strict";
import test from "node:test";

import { decideGate, decideReminder, planOutwardWork } from "../outward-actions.mjs";

const TODAY = "2026-10-25";
const YDAY = "2026-10-24";

function row(start, status, text = "[对外·私聊] 私聊 1 个目标用户") {
  return { _id: `${start}-${status}`, text, status, start };
}

test("gate allows when yesterday's outward action is done", () => {
  const g = decideGate([row(YDAY, "已完成")], TODAY);
  assert.equal(g.gate, "allow");
  assert.equal(g.reason, "done");
  assert.equal(g.streak, 0);
});

test("gate withholds when yesterday's outward action expired undone", () => {
  const g = decideGate([row(YDAY, "已过期")], TODAY);
  assert.equal(g.gate, "withhold");
  assert.equal(g.streak, 1);
  assert.equal(g.yesterday, YDAY);
});

test("gate allows when there is no record at all (fresh install must not punish)", () => {
  const g = decideGate([], TODAY);
  assert.equal(g.gate, "allow");
  assert.equal(g.reason, "no-record");
});

test("gate allows on an excused day", () => {
  const g = decideGate([row(YDAY, "已过期")], TODAY, [YDAY]);
  assert.equal(g.gate, "allow");
  assert.equal(g.reason, "excused");
});

test("streak counts consecutive undone days and stops at the last done day", () => {
  const rows = [
    row("2026-10-23", "已完成"),
    row("2026-10-24", "已过期"),
    row("2026-10-22", "已过期"),
  ];
  // 昨天(10-24)未完成 → 1；10-23 已完成 → 停
  assert.equal(decideGate(rows, TODAY).streak, 1);

  const rows2 = [
    row("2026-10-24", "已过期"),
    row("2026-10-23", "已过期"),
    row("2026-10-22", "已过期"),
    row("2026-10-21", "已完成"),
  ];
  assert.equal(decideGate(rows2, TODAY).streak, 3);
});

test("streak stops at an excused gap and ignores non-outward rows", () => {
  const rows = [
    row("2026-10-24", "已过期"),
    row("2026-10-23", "已过期"),
    row("2026-10-22", "已完成", "[学习·Agent] 读书"),
  ];
  // 10-23 未完成 → streak 2；10-22 只有学习行动（无对外记录）→ 停
  assert.equal(decideGate(rows, TODAY).streak, 2);
  assert.equal(decideGate(rows, TODAY, ["2026-10-23"]).streak, 1);
});

test("reminder prioritises the outward action over reading", () => {
  const r = decideReminder({ outwardPending: true, readingPending: true });
  assert.equal(r.type, "outward");
  assert.match(r.text, /今天对外动作为 0/);
  assert.match(r.text, /明天的日报不会生成/);

  assert.equal(decideReminder({ outwardPending: false, readingPending: true }).type, "reading");
  assert.equal(decideReminder({ outwardPending: false, readingPending: false }).type, "silent");
});

test("plan creates today's action once and expires yesterday's undone one", () => {
  const rows = [row(YDAY, "未动")];
  const plan = planOutwardWork(rows, TODAY);
  assert.equal(plan.expire.length, 1);
  assert.equal(plan.expire[0].start, YDAY);
  assert.ok(plan.create, "today's action is created");
  assert.match(plan.create["行动"], /^\[对外·私聊\]/);
  assert.deepEqual(plan.create["状态"], ["未动"]);

  // 幂等：今天已存在 → 不再创建
  const again = planOutwardWork([row(YDAY, "已过期"), row(TODAY, "未动")], TODAY);
  assert.equal(again.create, null);
  assert.equal(again.hasToday, true);
});

test("plan never expires today's own action", () => {
  const plan = planOutwardWork([row(TODAY, "未动")], TODAY);
  assert.equal(plan.expire.length, 0);
  assert.equal(plan.create, null);
});

// ---- 扣留页（brief 侧）----
import { buildWithheldBrief } from "../orbitos-daily-brief.mjs";

test("withheld brief states the fact, the cost, and the single exit — no daily-brief content", () => {
  const inp = {
    dateStr: "2026-10-25",
    outwardAccount: {
      total: 76, outwardTotal: 7, outwardDone: 1, outwardStuck: 6,
      learningTotal: 63, oldestAge: 26, oldestText: "【主线·分发】定向私聊 1/20",
      sharePct: 9, learningPct: 83,
    },
  };
  const text = buildWithheldBrief(inp, { gate: "withhold", reason: "not-done", streak: 3, yesterday: "2026-10-24" });

  assert.match(text, /今天没有日报/);
  assert.match(text, /连续 3 天/);
  assert.match(text, /2026-10-24/);
  assert.match(text, /私聊 1 个目标用户/);
  assert.match(text, /明天.*恢复/s);
  // 扣留页不得冒充日报
  assert.doesNotMatch(text, /## TL;DR/);
  assert.doesNotMatch(text, /## 学习增量/);
  assert.doesNotMatch(text, /## 工具风向/);
});

test("withheld brief omits the streak phrase on the first miss", () => {
  const inp = { dateStr: "2026-10-25", outwardAccount: { total: 10, outwardTotal: 1, learningTotal: 9, oldestAge: 2, oldestText: "x", sharePct: 10, learningPct: 90 } };
  const text = buildWithheldBrief(inp, { gate: "withhold", reason: "not-done", streak: 1, yesterday: "2026-10-24" });
  assert.doesNotMatch(text, /连续 1 天/);
});
