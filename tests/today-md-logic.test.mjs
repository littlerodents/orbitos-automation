import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTldr, extractResearcherSummary, extractAnalystSignposts,
  extractFilterDigest, extractMonitorEntries, extractFeishuFlags,
  isRecentFile, buildTodayMd,
  readBrief, readResearcherNotes, readAnalystNote, readFilterDigests,
  readMonitorDigests, readFeishuFlags, processTodayTask,
  setGhCaller, setStateVars, resetRunners,
} from "../today-md-logic.mjs";

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

const BRIEF = `---\ntype: daily-brief\ndate: 2026-07-05\n---\n# Brief — 2026-07-05\n\n## TL;DR\n今天的关键是 AI agent 组织架构。\n两个来源指向同一方向。\n\n## CONNECTIONS\n一些连接\n\n## QUESTION\n一个问题`;

const RESEARCHER = `---\ntype: selected-content\nsource: researcher-agent\nconfidence: C3\nsource_key: researcher-2026-07-05-test\n---\n\n# Test Topic\n\n增量发现：这是一个新发现的内容。\n\n## 来源\n- [link](url)`;

const ANALYST = `---\ntype: selected-content\nsource: analyst-agent\n---\n\n# Analyst — 2026-07-05\n\n## 路标 1：Agent架构\n- 信号强度：中\n- 判断：两篇互补，指向组织设计方向\n\n## 噪音\n- bad-note：不相关`;

const FILTER = `---\ntype: filter-digest\n---\n\n# Filter — 2026-07-05 morning\n\n## AI agent 协作\n- [title](url) — 新洞察\n- [title2](url) — 另一个\n\n## LLM 安全\n（无新增）`;

const MONITOR = `---\ntype: following-monitor\n---\n\n# Following Monitor — 2026-07-05 上午\n\n## @sama — OpenAI 方向\nlikes=5100 retweets=1200\nSam说下一步是不说话\n增量：跟agent gate相关\n\n## @dankoe — 专注力\nlikes=2000\n专注力三层协议`;

// ============================ Pure function tests ============================

test("extractTldr: from ## TL;DR", () => {
  const t = extractTldr(BRIEF);
  assert.ok(t.includes("AI agent 组织架构"));
  assert.ok(!t.includes("## CONNECTIONS"));
});

test("extractTldr: fallback to CONNECTIONS", () => {
  const brief = "---\n---\n# Brief\n\n## CONNECTIONS\n连接内容";
  const t = extractTldr(brief);
  assert.ok(t.includes("连接内容"));
});

test("extractTldr: fallback to body", () => {
  const t = extractTldr("---\n---\n# Brief\n\ntop level content");
  assert.ok(t.includes("top level content"));
});

test("extractTldr: null → default", () => {
  assert.equal(extractTldr(null), "今天还没有 brief");
  assert.equal(extractTldr(""), "今天还没有 brief");
});

test("extractResearcherSummary: extract key + body", () => {
  const r = extractResearcherSummary(RESEARCHER, "researcher-2026-07-05-test.md");
  assert.equal(r.link, "researcher-2026-07-05-test");
  assert.ok(r.summary.includes("新发现"));
});

test("extractResearcherSummary: null → null", () => {
  assert.equal(extractResearcherSummary(null, "x"), null);
});

test("extractAnalystSignposts: parse 路标", () => {
  const sp = extractAnalystSignposts(ANALYST);
  assert.equal(sp.length, 1);
  assert.ok(sp[0].direction.includes("Agent架构"));
  assert.ok(sp[0].judgment.includes("互补"));
});

test("extractAnalystSignposts: empty", () => {
  assert.deepEqual(extractAnalystSignposts(null), []);
  assert.deepEqual(extractAnalystSignposts("# No signposts"), []);
});

test("extractFilterDigest: parse sections", () => {
  const d = extractFilterDigest(FILTER);
  assert.equal(d.length, 1); // only sections with content
  assert.ok(d[0].topic.includes("AI agent"));
});

test("extractFilterDigest: empty", () => {
  assert.deepEqual(extractFilterDigest(null), []);
});

test("extractMonitorEntries: parse entries", () => {
  const e = extractMonitorEntries(MONITOR);
  assert.equal(e.length, 2);
  assert.ok(e[0].author.includes("sama"));
});

test("extractMonitorEntries: no content", () => {
  const e = extractMonitorEntries("---\n---\n\n# Monitor\n\n无高互动新内容");
  assert.equal(e.length, 0);
});

test("extractMonitorEntries: null", () => {
  assert.deepEqual(extractMonitorEntries(null), []);
});

test("extractFeishuFlags: with files", () => {
  const f = extractFeishuFlags([{ name: "feishu-2026-07-05-test.md" }, { name: "other.md" }]);
  assert.equal(f.length, 1);
  assert.equal(f[0].count, 1);
});

test("extractFeishuFlags: empty", () => {
  assert.deepEqual(extractFeishuFlags(null), []);
  assert.deepEqual(extractFeishuFlags([]), []);
});

test("isRecentFile: within 24h", () => {
  const now = new Date("2026-07-05T12:00:00Z");
  assert.ok(isRecentFile("researcher-2026-07-05-test.md", 24, now));
});

test("isRecentFile: older than 24h", () => {
  const now = new Date("2026-07-05T12:00:00Z");
  assert.ok(!isRecentFile("researcher-2026-07-03-test.md", 24, now));
});

test("isRecentFile: no date", () => {
  assert.ok(!isRecentFile("test.md", 24));
});

test("buildTodayMd: all sections", () => {
  const md = buildTodayMd({
    date: "2026-07-05",
    tldr: "AI is great",
    researcher: [{ link: "test", summary: "new finding" }],
    analyst: [{ direction: "Agent架构", judgment: "互补" }],
    filter: [{ topic: "AI agent", summary: "insight" }],
    monitor: [{ author: "@sama", summary: "new direction" }],
    feishuFlags: [{ count: 3, latest: "feishu-2026-07-05-test" }],
  });
  assert.ok(md.includes("type: daily-hub"));
  assert.ok(md.includes("# 今天 — 2026-07-05"));
  assert.ok(md.includes("AI is great"));
  assert.ok(md.includes("深度研究"));
  assert.ok(md.includes("跨篇路标"));
  assert.ok(md.includes("外部信息"));
  assert.ok(md.includes("关注对象"));
  assert.ok(md.includes("3 条标记未处理"));
});

test("buildTodayMd: empty sections → fallback", () => {
  const md = buildTodayMd({
    date: "2026-07-05",
    tldr: "今天还没有 brief",
    researcher: [],
    analyst: [],
    filter: [],
    monitor: [],
    feishuFlags: [],
  });
  assert.ok(md.includes("今天还没有新的 AI 产出"));
  assert.ok(md.includes("空 — 在飞书里 flag"));
});

test("buildTodayMd: some sections", () => {
  const md = buildTodayMd({
    date: "2026-07-05",
    tldr: "brief here",
    researcher: [{ link: "r1", summary: "finding" }],
    analyst: [],
    filter: [],
    monitor: [],
    feishuFlags: [],
  });
  assert.ok(md.includes("深度研究"));
  assert.ok(!md.includes("跨篇路标"));
  assert.ok(!md.includes("今天还没有新的 AI 产出"));
});

// ============================ Logic function tests ============================

test("readBrief: exists", async () => {
  setGhCaller(async (m, path) => {
    if (path.includes("brief-2026-07-05")) return { content: Buffer.from(BRIEF).toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const b = await readBrief("2026-07-05");
  assert.ok(b.includes("TL;DR"));
  resetRunners();
});

test("readBrief: not found → null", async () => {
  setGhCaller(async () => null);
  setStateVars(VARS);
  assert.equal(await readBrief("2026-07-05"), null);
  resetRunners();
});

test("readResearcherNotes: with recent files", async () => {
  setGhCaller(async (m, path) => {
    if (path === "30_Research/Selected") return [{ name: "researcher-2026-07-05-test.md", path: "30_Research/Selected/researcher-2026-07-05-test.md" }];
    if (path.includes("test.md")) return { content: Buffer.from(RESEARCHER).toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const r = await readResearcherNotes("2026-07-05", 24);
  assert.equal(r.length, 1);
  assert.ok(r[0].link.includes("test"));
  resetRunners();
});

test("readResearcherNotes: no files", async () => {
  setGhCaller(async () => []);
  setStateVars(VARS);
  assert.equal((await readResearcherNotes("2026-07-05", 24)).length, 0);
  resetRunners();
});

test("readAnalystNote: exists", async () => {
  setGhCaller(async (m, path) => {
    if (path.includes("analyst-2026-07-05")) return { content: Buffer.from(ANALYST).toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const sp = await readAnalystNote("2026-07-05");
  assert.equal(sp.length, 1);
  resetRunners();
});

test("readAnalystNote: not found → empty", async () => {
  setGhCaller(async () => null);
  setStateVars(VARS);
  assert.equal((await readAnalystNote("2026-07-05")).length, 0);
  resetRunners();
});

test("readFilterDigests: with files", async () => {
  setGhCaller(async (m, path) => {
    if (path === "00_Inbox") return [{ name: "filter-2026-07-05-morning.md", path: "00_Inbox/filter-2026-07-05-morning.md" }];
    if (path.includes("filter-")) return { content: Buffer.from(FILTER).toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const d = await readFilterDigests("2026-07-05");
  assert.ok(d.length > 0);
  resetRunners();
});

test("readFilterDigests: no files", async () => {
  setGhCaller(async () => []);
  setStateVars(VARS);
  assert.equal((await readFilterDigests("2026-07-05")).length, 0);
  resetRunners();
});

test("readMonitorDigests: with files", async () => {
  setGhCaller(async (m, path) => {
    if (path === "00_Inbox") return [{ name: "monitor-2026-07-05-morning.md", path: "00_Inbox/monitor-2026-07-05-morning.md" }];
    if (path.includes("monitor-")) return { content: Buffer.from(MONITOR).toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const d = await readMonitorDigests("2026-07-05");
  assert.ok(d.length > 0);
  resetRunners();
});

test("readMonitorDigests: no files", async () => {
  setGhCaller(async () => []);
  setStateVars(VARS);
  assert.equal((await readMonitorDigests("2026-07-05")).length, 0);
  resetRunners();
});

test("readFeishuFlags: with files", async () => {
  setGhCaller(async (m, path) => {
    if (path === "00_Inbox") return [{ name: "feishu-2026-07-05-test.md" }];
    return null;
  });
  setStateVars(VARS);
  const f = await readFeishuFlags();
  assert.equal(f.length, 1);
  resetRunners();
});

test("readFeishuFlags: no files", async () => {
  setGhCaller(async () => []);
  setStateVars(VARS);
  assert.equal((await readFeishuFlags()).length, 0);
  resetRunners();
});

// ============================ processTodayTask tests ============================

test("processTodayTask: all sources available", async () => {
  setGhCaller(async (m, path) => {
    if (path.includes("brief-")) return { content: Buffer.from(BRIEF).toString("base64") };
    if (path === "30_Research/Selected") return [
      { name: "researcher-2026-07-05-test.md", path: "30_Research/Selected/researcher-2026-07-05-test.md" },
      { name: "analyst-2026-07-05-pattern.md", path: "30_Research/Selected/analyst-2026-07-05-pattern.md" },
    ];
    if (path === "00_Inbox") return [
      { name: "filter-2026-07-05-morning.md", path: "00_Inbox/filter-2026-07-05-morning.md" },
      { name: "monitor-2026-07-05-morning.md", path: "00_Inbox/monitor-2026-07-05-morning.md" },
      { name: "feishu-2026-07-05-test.md" },
    ];
    if (path === "Today.md") return { sha: "existing-sha" };
    if (path.includes("researcher-")) return { content: Buffer.from(RESEARCHER).toString("base64") };
    if (path.includes("analyst-")) return { content: Buffer.from(ANALYST).toString("base64") };
    if (path.includes("filter-")) return { content: Buffer.from(FILTER).toString("base64") };
    if (path.includes("monitor-")) return { content: Buffer.from(MONITOR).toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const r = await processTodayTask();
  assert.equal(r.action, "write");
  assert.equal(r.path, "Today.md");
  assert.equal(r.sha, "existing-sha");
  assert.ok(r.sections.tldr);
  assert.ok(r.sections.researcher > 0);
  assert.ok(r.sections.analyst > 0);
  assert.ok(r.sections.filter > 0);
  assert.ok(r.sections.monitor > 0);
  assert.ok(r.sections.feishuFlags > 0);
  const md = Buffer.from(r.b64, "base64").toString("utf8");
  assert.ok(md.includes("# 今天"));
  assert.ok(md.includes("TL;DR"));
  assert.ok(md.includes("深度研究"));
  resetRunners();
});

test("processTodayTask: empty vault → fallback text", async () => {
  setGhCaller(async () => null);
  setStateVars(VARS);
  const r = await processTodayTask();
  assert.equal(r.action, "write");
  assert.equal(r.sha, "");
  const md = Buffer.from(r.b64, "base64").toString("utf8");
  assert.ok(md.includes("今天还没有 brief"));
  assert.ok(md.includes("今天还没有新的 AI 产出"));
  resetRunners();
});

test("processTodayTask: ghCaller error → fallback", async () => {
  setGhCaller(async () => { throw new Error("network"); });
  setStateVars(VARS);
  const r = await processTodayTask();
  assert.equal(r.action, "write");
  const md = Buffer.from(r.b64, "base64").toString("utf8");
  assert.ok(md.includes("今天还没有 brief"));
  resetRunners();
});

// ============================ FUZZ ROUND 1 ============================
// Variable vault content + section combinations

test("FUZZ ROUND 1 (seed 1): variable vault content invariants", async () => {
  const rng = mulberry32(1);
  let sawAll = 0, sawEmpty = 0, sawPartial = 0;

  for (let i = 0; i < 200; i++) {
    const hasBrief = rng() > 0.3;
    const hasResearcher = rng() > 0.5;
    const hasAnalyst = rng() > 0.6;
    const hasFilter = rng() > 0.5;
    const hasMonitor = rng() > 0.5;
    const hasFeishu = rng() > 0.7;

    setGhCaller(async (m, path) => {
      if (path.includes("brief-") && hasBrief) return { content: Buffer.from(BRIEF).toString("base64") };
      if (path === "30_Research/Selected") {
        const list = [];
        if (hasResearcher) list.push({ name: "researcher-2026-07-05-t.md", path: "30_Research/Selected/researcher-2026-07-05-t.md" });
        if (hasAnalyst) list.push({ name: "analyst-2026-07-05-pattern.md", path: "30_Research/Selected/analyst-2026-07-05-pattern.md" });
        return list;
      }
      if (path === "00_Inbox") {
        const list = [];
        if (hasFilter) list.push({ name: "filter-2026-07-05-morning.md", path: "00_Inbox/filter-2026-07-05-morning.md" });
        if (hasMonitor) list.push({ name: "monitor-2026-07-05-morning.md", path: "00_Inbox/monitor-2026-07-05-morning.md" });
        if (hasFeishu) list.push({ name: "feishu-2026-07-05-test.md" });
        return list;
      }
      if (path === "Today.md") return hasBrief && rng() > 0.5 ? { sha: "x" } : null;
      if (path.includes("researcher-") && hasResearcher) return { content: Buffer.from(RESEARCHER).toString("base64") };
      if (path.includes("analyst-") && hasAnalyst) return { content: Buffer.from(ANALYST).toString("base64") };
      if (path.includes("filter-") && hasFilter) return { content: Buffer.from(FILTER).toString("base64") };
      if (path.includes("monitor-") && hasMonitor) return { content: Buffer.from(MONITOR).toString("base64") };
      return null;
    });
    setStateVars(VARS);

    const r = await processTodayTask();
    assert.equal(r.action, "write");
    assert.equal(r.path, "Today.md");
    const md = Buffer.from(r.b64, "base64").toString("utf8");
    assert.ok(md.includes("# 今天"));
    assert.ok(md.includes("TL;DR"));
    assert.ok(md.includes("AI 帮你发现"));

    const filled = [hasResearcher, hasAnalyst, hasFilter, hasMonitor].filter(Boolean).length;
    if (filled === 4) sawAll++;
    else if (filled === 0) sawEmpty++;
    else sawPartial++;

    if (filled === 0) assert.ok(md.includes("今天还没有新的 AI 产出"));
  }
  assert.ok(sawAll > 0, "must see all sections");
  assert.ok(sawEmpty > 0, "must see empty");
  assert.ok(sawPartial > 0, "must see partial");
  resetRunners();
});

// ============================ FUZZ ROUND 2 ============================
// Variable file content + edge cases

test("FUZZ ROUND 2 (seed 2): variable file content + edge cases", async () => {
  const rng = mulberry32(2);
  const briefVariants = [
    "---\n---\n# Brief\n\n## TL;DR\nstandard tldr content",
    "---\n---\n# Brief\n\n## CONNECTIONS\nfallback content here",
    "---\n---\n# Brief\n\nno sections at all",
    "",
    null,
  ];
  let sawWrite = 0;

  for (let i = 0; i < 50; i++) {
    const briefContent = pick(rng, briefVariants);
    setGhCaller(async (m, path) => {
      if (path.includes("brief-")) return briefContent ? { content: Buffer.from(briefContent).toString("base64") } : null;
      if (path === "30_Research/Selected" || path === "00_Inbox") return [];
      if (path === "Today.md") return rng() > 0.5 ? { sha: "old" } : null;
      return null;
    });
    setStateVars(VARS);

    const r = await processTodayTask();
    assert.equal(r.action, "write");
    const md = Buffer.from(r.b64, "base64").toString("utf8");
    assert.ok(md.includes("# 今天"));
    assert.ok(md.includes("AI 帮你发现"));
    assert.ok(md.includes("标记要看"));
    sawWrite++;
  }
  assert.equal(sawWrite, 50);
  resetRunners();
});
