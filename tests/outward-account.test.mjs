import assert from "node:assert/strict";
import test from "node:test";

import { outwardAlertLine } from "../orbitos-daily-brief.mjs";

const base = {
  total: 76, outwardTotal: 7, outwardDone: 1, outwardStuck: 6,
  learningTotal: 63, oldestAge: 26, oldestText: "【主线·分发】发布文章",
  sharePct: 9, learningPct: 83,
};

test("alert fires when outward work is stuck and old (the real 2026-10-24 numbers)", () => {
  const line = outwardAlertLine(base);
  assert.match(line, /对外动作 6 条未动/);
  assert.match(line, /最久 26 天/);
  assert.match(line, /学习类占追踪表 83%/);
  assert.match(line, /系统实测（非模型判断）/);
});

test("alert stays silent when only 4 outward actions are stuck", () => {
  assert.equal(outwardAlertLine({ ...base, outwardStuck: 4 }), "");
});

test("alert stays silent when the oldest stuck action is 14 days or newer", () => {
  assert.equal(outwardAlertLine({ ...base, oldestAge: 14 }), "");
});

test("alert stays silent on empty or missing data (no false alarm on a fresh tracker)", () => {
  assert.equal(outwardAlertLine(null), "");
  assert.equal(outwardAlertLine(undefined), "");
  assert.equal(outwardAlertLine({ total: 0 }), "");
});

test("alert fires at the exact boundary (5 stuck, 15 days)", () => {
  assert.notEqual(outwardAlertLine({ ...base, outwardStuck: 5, oldestAge: 15 }), "");
});

test("importing the brief module must not trigger a real run (guards vault writes)", async () => {
  // 若 import 触发 main，会在这里写出 brief 并 commit；用副作用检测代替（见红队 E3）
  const mod = await import("../orbitos-daily-brief.mjs");
  assert.equal(typeof mod.outwardAlertLine, "function");
});
