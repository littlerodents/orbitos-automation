import assert from "node:assert/strict";
import test from "node:test";

import { planBookmarkActions } from "../bookmark-organizer.mjs";

function batch(n, prefix = "f") {
  return Array.from({ length: n }, (_, i) => ({
    file: `${prefix}${i}.md`,
    fm: { url: `https://x.com/u/status/${i}` },
  }));
}

function byIdFrom(map) {
  return new Map(Object.entries(map));
}

test("strong + actionable becomes a tracker action (the case that was silently missing)", () => {
  const b = batch(1);
  const byId = byIdFrom({ "f0.md": { signal: "strong", actionable: "重构三个 skill", essence: "工业级 Skill 方法论。", why: "直接提高工程质量" } });
  const plan = planBookmarkActions(b, byId, 3, 1000);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.candidates, 1);
  assert.match(plan.actions[0]["行动"], /精读：《工业级 Skill 方法论》→ 重构三个 skill/);
  assert.match(plan.actions[0]["行动"], /status\/0/);
  assert.deepEqual(plan.actions[0]["状态"], ["未动"]);
  assert.equal(plan.actions[0]["开始卡于"], 1000);
  assert.match(plan.actions[0]["为什么这么做"], /最优性/);
});

test("medium and weak never enter the tracker, even with an actionable field", () => {
  const b = batch(3);
  const byId = byIdFrom({
    "f0.md": { signal: "medium", actionable: "做点什么", essence: "A" },
    "f1.md": { signal: "weak", actionable: "做点什么", essence: "B" },
    "f2.md": { signal: "strong", actionable: "做 C", essence: "C" },
  });
  const plan = planBookmarkActions(b, byId);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.candidates, 1);
});

test("strong without actionable is dropped and NOT counted as pushed", () => {
  const b = batch(1);
  const byId = byIdFrom({ "f0.md": { signal: "strong", actionable: "", essence: "只有观点" } });
  const plan = planBookmarkActions(b, byId);
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.candidates, 0);
});

test("cap of 3 is enforced and the truncation is reported (no silent loss)", () => {
  const b = batch(5);
  const byId = byIdFrom(Object.fromEntries(b.map((x, i) => [x.file, { signal: "strong", actionable: `做${i}`, essence: `E${i}` }])));
  const plan = planBookmarkActions(b, byId, 3);
  assert.equal(plan.actions.length, 3);
  assert.equal(plan.candidates, 5);
  assert.equal(plan.truncated, 2, "超额部分必须计数，不能静默丢弃");
});

test("missing analysis for a file does not throw or fabricate an action", () => {
  const b = batch(2);
  const plan = planBookmarkActions(b, byIdFrom({}));
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.candidates, 0);
});
