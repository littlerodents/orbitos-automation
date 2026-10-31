import assert from "node:assert/strict";
import test from "node:test";

import { shiftDayStr, streakDays } from "../orbitos-daily-brief.mjs";

const TODAY = "2026-10-31";
const A = "【主线·分发】发布 safety-eval 文章：打开公众号后台";

test("streak counts consecutive days the same action was recommended", () => {
  const state = { "2026-10-30": [A], "2026-10-29": [A], "2026-10-28": [A] };
  assert.equal(streakDays(state, A, TODAY), 3);
});

test("streak stops at the first gap", () => {
  const state = { "2026-10-30": [A], "2026-10-29": ["别的事"], "2026-10-28": [A] };
  assert.equal(streakDays(state, A, TODAY), 1);
});

test("fingerprint ignores whitespace differences (LLM rewrites padding)", () => {
  const padded = "【主线·分发】发布 safety-eval 文章： 打开公众号后台   →  粘贴";
  const state = { "2026-10-30": [padded] };
  assert.equal(streakDays(state, A, TODAY), 1);
});

test("no history means zero streak (first-time recommendation is allowed)", () => {
  assert.equal(streakDays({}, A, TODAY), 0);
});

test("only counts yesterday backwards, not today itself", () => {
  const state = { [TODAY]: [A], "2026-10-30": [A] };
  assert.equal(streakDays(state, A, TODAY), 1);
});

test("lookback cap prevents ancient history from blocking forever", () => {
  const state = {};
  for (let i = 1; i <= 10; i += 1) {
    state[shiftDayStr(TODAY, -i)] = [A];
  }
  assert.equal(streakDays(state, A, TODAY, 4), 4);
});

test("shiftDayStr keeps the Asia/Shanghai calendar day (no UTC drift)", () => {
  assert.equal(shiftDayStr("2026-10-31", -1), "2026-10-30");
  assert.equal(shiftDayStr("2026-11-01", -1), "2026-10-31");
  assert.equal(shiftDayStr("2026-03-01", -1), "2026-02-28");
});
