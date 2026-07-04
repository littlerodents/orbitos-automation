import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_INTERESTS, getPeriod, extractInferredInterests, mergeInterests,
  buildFilterMarkdown, shouldWriteFilter, readVaultBaseline,
  searchAndCompare, processFilterTask,
  setGhCaller, setExaSearcher, setDeepSeekCaller, setStateVars, resetRunners,
} from "../filter-agent-logic.mjs";

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = (rng, min, max) => Math.floor(rng() * (max - min + 1)) + min;
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

const VARS = { OWNER: "test", REPO: "test", BRANCH: "main" };

// ============================ Pure function tests ============================

test("BASE_INTERESTS: has 6 with weights", () => {
  assert.equal(BASE_INTERESTS.length, 6);
  assert.ok(BASE_INTERESTS.every(i => i.weight >= 1 && i.weight <= 3));
  assert.ok(BASE_INTERESTS.filter(i => i.weight === 3).length >= 4);
});

test("getPeriod: morning/afternoon/evening", () => {
  assert.equal(getPeriod(6), "morning");
  assert.equal(getPeriod(12), "afternoon");
  assert.equal(getPeriod(18), "evening");
  assert.equal(getPeriod(0), "morning");
  assert.equal(getPeriod(23), "evening");
});

test("extractInferredInterests: from topics", () => {
  const baseline = 'topics: ["AI", "agent"]\n## PATTERN\n这是关于blockchain的模式';
  const r = extractInferredInterests(baseline);
  assert.ok(r.includes("AI"));
  assert.ok(r.includes("agent"));
});

test("extractInferredInterests: empty baseline", () => {
  assert.deepEqual(extractInferredInterests(""), []);
});

test("extractInferredInterests: invalid topics JSON", () => {
  const r = extractInferredInterests('topics: [invalid]');
  assert.deepEqual(r, []);
});

test("mergeInterests: base + inferred deduped", () => {
  const merged = mergeInterests(BASE_INTERESTS, ["AI", "blockchain", "量子计算"]);
  assert.ok(merged.length >= 6);
  assert.ok(merged[0].weight >= merged[merged.length - 1].weight);
  const topics = merged.map(m => m.topic);
  assert.ok(!topics.includes("AI")); // "AI" is too short, might be deduped by base
});

test("mergeInterests: empty inferred", () => {
  const merged = mergeInterests(BASE_INTERESTS, []);
  assert.equal(merged.length, 6);
});

test("buildFilterMarkdown: with increments", () => {
  const md = buildFilterMarkdown([
    { topic: "AI agent", increment: "- [test](url) — new insight" },
    { topic: "LLM safety", increment: null },
  ], "2026-07-02", "morning");
  assert.ok(md.includes("type: filter-digest"));
  assert.ok(md.includes("# Filter — 2026-07-02 morning"));
  assert.ok(md.includes("## AI agent"));
  assert.ok(md.includes("new insight"));
  assert.ok(md.includes("（无新增）"));
});

test("buildFilterMarkdown: all empty", () => {
  const md = buildFilterMarkdown([
    { topic: "AI", increment: null },
  ], "2026-07-02", "afternoon");
  assert.ok(md.includes("（无新增）"));
});

test("shouldWriteFilter: has increment", () => {
  assert.equal(shouldWriteFilter([{ increment: "x" }]), true);
});

test("shouldWriteFilter: no increment", () => {
  assert.equal(shouldWriteFilter([{ increment: null }, { increment: "无新增" }]), false);
});

test("shouldWriteFilter: empty", () => {
  assert.equal(shouldWriteFilter([]), false);
});

// ============================ Logic function tests ============================

test("readVaultBaseline: empty vault", async () => {
  setGhCaller(async () => null);
  setStateVars(VARS);
  assert.equal(await readVaultBaseline(), "(vault empty)");
  resetRunners();
});

test("readVaultBaseline: with data", async () => {
  setGhCaller(async (m, path) => {
    if (path === "30_Research/Selected") return [{ name: "test.md", path: "30_Research/Selected/test.md" }];
    if (path === "20_Project") return [];
    if (path === "00_Inbox") return [{ name: "brief-2026-07-02.md", path: "00_Inbox/brief-2026-07-02.md" }];
    if (path.includes("test.md")) return { content: Buffer.from("---\ntopics: [\"AI\"]\n---\n# Test").toString("base64") };
    if (path.includes("brief")) return { content: Buffer.from("# Brief\n## PATTERN\npattern text").toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const b = await readVaultBaseline();
  assert.ok(b.includes("test.md"));
  assert.ok(b.includes("PATTERN"));
  resetRunners();
});

test("readVaultBaseline: ghCaller error → empty", async () => {
  setGhCaller(async () => { throw new Error("fail"); });
  setStateVars(VARS);
  assert.equal(await readVaultBaseline(), "(vault empty)");
  resetRunners();
});

test("searchAndCompare: has increment", async () => {
  setExaSearcher(async () => [{ url: "https://x.com", title: "X", text: "new AI stuff" }]);
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: "- [X](https://x.com) — new insight" } }] }));
  setStateVars(VARS);
  const r = await searchAndCompare({ topic: "AI", query: "AI", weight: 3 }, "baseline");
  assert.ok(r.increment);
  resetRunners();
});

test("searchAndCompare: no increment", async () => {
  setExaSearcher(async () => [{ url: "https://x.com", title: "X", text: "old stuff" }]);
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: "无新增" } }] }));
  setStateVars(VARS);
  const r = await searchAndCompare({ topic: "AI", query: "AI", weight: 3 }, "baseline");
  assert.equal(r.increment, null);
  resetRunners();
});

test("searchAndCompare: exa empty", async () => {
  setExaSearcher(async () => []);
  setStateVars(VARS);
  const r = await searchAndCompare({ topic: "AI", query: "AI", weight: 3 }, "baseline");
  assert.equal(r.increment, null);
  resetRunners();
});

test("searchAndCompare: exa error", async () => {
  setExaSearcher(async () => { throw new Error("net"); });
  setStateVars(VARS);
  const r = await searchAndCompare({ topic: "AI", query: "AI", weight: 3 }, "baseline");
  assert.equal(r.increment, null);
  resetRunners();
});

test("searchAndCompare: deepseek error", async () => {
  setExaSearcher(async () => [{ url: "https://x.com", title: "X", text: "stuff" }]);
  setDeepSeekCaller(async () => { throw new Error("ds"); });
  setStateVars(VARS);
  const r = await searchAndCompare({ topic: "AI", query: "AI", weight: 3 }, "baseline");
  assert.equal(r.increment, null);
  resetRunners();
});

test("searchAndCompare: deepseek no choices", async () => {
  setExaSearcher(async () => [{ url: "https://x.com", title: "X", text: "stuff" }]);
  setDeepSeekCaller(async () => ({}));
  setStateVars(VARS);
  const r = await searchAndCompare({ topic: "AI", query: "AI", weight: 3 }, "baseline");
  assert.equal(r.increment, null);
  resetRunners();
});

test("searchAndCompare: empty content", async () => {
  setExaSearcher(async () => [{ url: "https://x.com", title: "X", text: "stuff" }]);
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: "" } }] }));
  setStateVars(VARS);
  const r = await searchAndCompare({ topic: "AI", query: "AI", weight: 3 }, "baseline");
  assert.equal(r.increment, null);
  resetRunners();
});

// ============================ processFilterTask tests ============================

test("processFilterTask: all no increment → no_action", async () => {
  setGhCaller(async () => null);
  setExaSearcher(async () => []);
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: "无新增" } }] }));
  setStateVars(VARS);
  const r = await processFilterTask({ maxInterests: 2 });
  assert.equal(r.no_action, true);
  resetRunners();
});

test("processFilterTask: has increment → write", async () => {
  setGhCaller(async () => null);
  setExaSearcher(async () => [{ url: "https://x.com", title: "X", text: "new AI" }]);
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: "- [X](https://x.com) — new" } }] }));
  setStateVars(VARS);
  const r = await processFilterTask({ maxInterests: 2 });
  assert.equal(r.action, "write");
  assert.ok(r.filter_path.includes("filter-"));
  assert.ok(r.filter_b64);
  assert.ok(r.increments > 0);
  resetRunners();
});

test("processFilterTask: with vault baseline", async () => {
  setGhCaller(async (m, path) => {
    if (path === "30_Research/Selected") return [{ name: "test.md", path: "30_Research/Selected/test.md" }];
    if (path === "20_Project" || path === "00_Inbox") return [];
    if (path.includes("test.md")) return { content: Buffer.from("---\ntopics: [\"AI\"]\n---\n# Test").toString("base64") };
    return null;
  });
  setExaSearcher(async () => [{ url: "https://x.com", title: "X", text: "new" }]);
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: "- [X](https://x.com) — new" } }] }));
  setStateVars(VARS);
  const r = await processFilterTask({ maxInterests: 2 });
  assert.equal(r.action, "write");
  resetRunners();
});

// ============================ FUZZ ROUND 1 ============================

test("FUZZ ROUND 1 (seed 1): variable interests + search outcomes", async () => {
  const rng = mulberry32(1);
  const exaModes = ["has-results", "empty", "error"];
  const dsModes = ["increment", "no-increment", "error", "empty-content"];
  let sawWrite = 0, sawNoAction = 0;

  for (let i = 0; i < 50; i++) {
    const exaMode = pick(rng, exaModes);
    const dsMode = pick(rng, dsModes);
    setGhCaller(async () => null);
    setExaSearcher(async () => {
      if (exaMode === "has-results") return [{ url: "https://x.com/" + i, title: "T" + i, text: "content " + i }];
      if (exaMode === "empty") return [];
      throw new Error("exa error");
    });
    setDeepSeekCaller(async () => {
      if (dsMode === "increment") return { choices: [{ message: { content: "- [T](url) — increment" } }] };
      if (dsMode === "no-increment") return { choices: [{ message: { content: "无新增" } }] };
      if (dsMode === "error") throw new Error("ds");
      return { choices: [{ message: { content: "" } }] };
    });
    setStateVars(VARS);
    const r = await processFilterTask({ maxInterests: 2 });
    assert.ok(r.action === "write" || r.no_action === true);
    if (r.action === "write") sawWrite++; else sawNoAction++;
  }
  assert.ok(sawWrite > 0, "must see write");
  assert.ok(sawNoAction > 0, "must see no_action");
  resetRunners();
});

// ============================ FUZZ ROUND 2 ============================

test("FUZZ ROUND 2 (seed 2): variable vault baselines + interest counts", async () => {
  const rng = mulberry32(2);
  let sawWrite = 0, sawNoAction = 0;

  for (let i = 0; i < 50; i++) {
    const hasVault = rng() > 0.5;
    const interestCount = rand(rng, 1, 8);
    setGhCaller(async (m, path) => {
      if (!hasVault) return null;
      if (path === "30_Research/Selected") return [{ name: "test.md", path: "30_Research/Selected/test.md" }];
      if (path === "20_Project" || path === "00_Inbox") return [];
      if (path.includes("test.md")) return { content: Buffer.from("---\ntopics: [\"AI\"]\n---\n# Test").toString("base64") };
      return null;
    });
    setExaSearcher(async () => [{ url: "https://x.com", title: "X", text: "content" }]);
    setDeepSeekCaller(async () => ({ choices: [{ message: { content: rng() > 0.4 ? "- [X](url) — new" : "无新增" } }] }));
    setStateVars(VARS);
    const r = await processFilterTask({ maxInterests: interestCount });
    assert.ok(r.action === "write" || r.no_action === true);
    if (r.action === "write") sawWrite++; else sawNoAction++;
  }
  assert.ok(sawWrite > 0, "must see write");
  assert.ok(sawNoAction > 0, "must see no_action");
  resetRunners();
});
