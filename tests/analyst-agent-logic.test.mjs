import assert from "node:assert/strict";
import test from "node:test";

import {
  isRecentFile, extractNoteTitle, extractConfidence, extractTopics,
  isNoiseNote, buildAnalystMarkdown, shouldWriteAnalystNote,
  readSelectedNotes, readProjectContext, analyzePatterns, processAnalystTask,
  setGhCaller, setDeepSeekCaller, setStateVars, resetRunners,
} from "../analyst-agent-logic.mjs";

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

function makeNote(name, opts = {}) {
  const content = `---\ntype: selected-content\nsource: researcher-agent\nconfidence: ${opts.confidence || "C3"}\ndate: 2026-07-02\ntopics: [${(opts.topics || ["AI"]).map(t => JSON.stringify(t)).join(", ")}]\n---\n\n# ${opts.title || name}\n\n${opts.body || "some content"}`;
  return { name, fileName: name + ".md", path: "30_Research/Selected/" + name + ".md", content, title: opts.title || name, confidence: opts.confidence || "C3", topics: opts.topics || ["AI"], isNoise: opts.isNoise || false };
}

// ============================ Pure function tests ============================

test("isRecentFile: within 3 days", () => {
  const now = new Date("2026-07-02T12:00:00Z");
  assert.equal(isRecentFile("researcher-2026-07-01-test.md", 3, now), true);
  assert.equal(isRecentFile("researcher-2026-06-30-test.md", 3, now), true);
});
test("isRecentFile: older than 3 days", () => {
  const now = new Date("2026-07-02T12:00:00Z");
  assert.equal(isRecentFile("researcher-2026-06-28-test.md", 3, now), false);
});
test("isRecentFile: no date", () => { assert.equal(isRecentFile("test.md", 3), false); });
test("extractNoteTitle: from H1", () => { assert.equal(extractNoteTitle("# My Title\ncontent"), "My Title"); });
test("extractNoteTitle: fallback", () => { assert.equal(extractNoteTitle("no h1", "researcher-2026-07-01-test.md"), "2026-07-01-test"); });
test("extractConfidence: found", () => { assert.equal(extractConfidence("---\nconfidence: C4\n---"), "C4"); });
test("extractConfidence: missing", () => { assert.equal(extractConfidence("# Test"), ""); });
test("extractTopics: found", () => { assert.deepEqual(extractTopics('topics: ["AI", "agent"]'), ["AI", "agent"]); });
test("extractTopics: missing", () => { assert.deepEqual(extractTopics("# Test"), []); });
test("extractTopics: invalid", () => { assert.deepEqual(extractTopics('topics: [invalid]'), []); });
test("isNoiseNote: C1", () => { assert.equal(isNoiseNote("#result C1\nfail"), true); });
test("isNoiseNote: C3 no increment", () => { assert.equal(isNoiseNote("#result C3 无新增"), true); });
test("isNoiseNote: normal", () => { assert.equal(isNoiseNote("# Test\nnormal"), false); });

test("buildAnalystMarkdown: signposts + noise", () => {
  const md = buildAnalystMarkdown({
    signposts: [{ direction: "Agent架构", strength: "中", evidence: ["a + b"], judgment: "互补", suggestion: "搜更多" }],
    noise: [{ note: "bad-note", reason: "不相关" }],
    topics: ["AI"],
  }, "2026-07-02", ["a", "b", "bad-note"]);
  assert.ok(md.includes("source: analyst-agent"));
  assert.ok(md.includes("路标 1"));
  assert.ok(md.includes("噪音"));
  assert.ok(md.includes("[[bad-note]]"));
});
test("buildAnalystMarkdown: only noise", () => {
  const md = buildAnalystMarkdown({ signposts: [], noise: [{ note: "x", reason: "r" }], topics: [] }, "2026-07-02", ["x"]);
  assert.ok(md.includes("噪音"));
  assert.ok(!md.includes("路标"));
});
test("buildAnalystMarkdown: empty", () => {
  const md = buildAnalystMarkdown({ signposts: [], noise: [], topics: [] }, "2026-07-02", []);
  assert.ok(md.includes("# Analyst — 2026-07-02"));
});
test("buildAnalystMarkdown: signpost missing fields", () => {
  const md = buildAnalystMarkdown({ signposts: [{ direction: "Test" }], noise: [], topics: [] }, "2026-07-02", []);
  assert.ok(md.includes("路标 1：Test"));
  assert.ok(md.includes("弱"));
});

test("shouldWriteAnalystNote: has signposts", () => {
  assert.equal(shouldWriteAnalystNote([{}, {}], { signposts: [{}], noise: [] }), true);
});
test("shouldWriteAnalystNote: noise + >2 notes", () => {
  assert.equal(shouldWriteAnalystNote([{}, {}, {}], { signposts: [], noise: [{}] }), true);
});
test("shouldWriteAnalystNote: noise + ≤2 notes", () => {
  assert.equal(shouldWriteAnalystNote([{}, {}], { signposts: [], noise: [{}] }), false);
});
test("shouldWriteAnalystNote: empty", () => {
  assert.equal(shouldWriteAnalystNote([{}], { signposts: [], noise: [] }), false);
});
test("shouldWriteAnalystNote: null", () => {
  assert.equal(shouldWriteAnalystNote([{}], null), false);
});

// ============================ Logic function tests ============================

test("readSelectedNotes: empty dir", async () => {
  setGhCaller(async () => []);
  setStateVars(VARS);
  assert.equal((await readSelectedNotes(3)).length, 0);
  resetRunners();
});
test("readSelectedNotes: with files", async () => {
  setGhCaller(async (m, path) => {
    if (path === "30_Research/Selected") return [
      { name: "researcher-2026-07-02-test.md", path: "30_Research/Selected/researcher-2026-07-02-test.md" },
      { name: "analyst-2026-07-01-pattern.md", path: "30_Research/Selected/analyst-2026-07-01-pattern.md" },
      { name: "researcher-2026-06-20-old.md", path: "30_Research/Selected/researcher-2026-06-20-old.md" },
    ];
    if (path.includes("2026-07-02-test")) return { content: Buffer.from("---\nconfidence: C4\ntopics: [\"AI\"]\n---\n# Test\ncontent").toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const notes = await readSelectedNotes(3);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "Test");
  resetRunners();
});
test("readSelectedNotes: ghCaller error", async () => {
  setGhCaller(async (m, path) => {
    if (path === "30_Research/Selected") return [{ name: "researcher-2026-07-02-test.md", path: "30_Research/Selected/researcher-2026-07-02-test.md" }];
    throw new Error("network");
  });
  setStateVars(VARS);
  assert.equal((await readSelectedNotes(3)).length, 0);
  resetRunners();
});
test("readSelectedNotes: null list", async () => {
  setGhCaller(async () => null);
  setStateVars(VARS);
  assert.equal((await readSelectedNotes(3)).length, 0);
  resetRunners();
});
test("readProjectContext: with data", async () => {
  setGhCaller(async (m, path) => {
    if (path === "20_Project") return [{ name: "proj.md", path: "20_Project/proj.md" }];
    if (path === "00_Inbox") return [{ name: "brief-2026-07-02.md", path: "00_Inbox/brief-2026-07-02.md" }];
    if (path.includes("proj")) return { content: Buffer.from("# Proj\ntype: project").toString("base64") };
    if (path.includes("brief")) return { content: Buffer.from("# Brief\n## PATTERN\npattern text").toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const ctx = await readProjectContext();
  assert.ok(ctx.includes("proj.md"));
  assert.ok(ctx.includes("PATTERN"));
  resetRunners();
});
test("readProjectContext: empty", async () => {
  setGhCaller(async () => null);
  setStateVars(VARS);
  assert.equal(await readProjectContext(), "(no project context)");
  resetRunners();
});
test("readProjectContext: brief no PATTERN", async () => {
  setGhCaller(async (m, path) => {
    if (path === "20_Project") return [];
    if (path === "00_Inbox") return [{ name: "brief-2026-07-02.md", path: "00_Inbox/brief-2026-07-02.md" }];
    if (path.includes("brief")) return { content: Buffer.from("# Brief\nno pattern").toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const ctx = await readProjectContext();
  assert.ok(!ctx.includes("PATTERN"));
  resetRunners();
});
test("analyzePatterns: empty notes", async () => {
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"signposts":[],"noise":[]}' } }] }));
  setStateVars(VARS);
  const r = await analyzePatterns([], "ctx");
  assert.deepEqual(r.signposts, []);
  resetRunners();
});
test("analyzePatterns: with signposts", async () => {
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"signposts":[{"direction":"Agent","strength":"弱（2篇）","evidence":["a","b"],"judgment":"互补","suggestion":""}],"noise":[{"note":"bad","reason":"不相关"}],"topics":["AI"]}' } }] }));
  setStateVars(VARS);
  const r = await analyzePatterns([makeNote("researcher-2026-07-02-a"), makeNote("researcher-2026-07-02-b")], "ctx");
  assert.equal(r.signposts.length, 1);
  assert.equal(r.noise.length, 1);
  resetRunners();
});
test("analyzePatterns: deepseek error", async () => {
  setDeepSeekCaller(async () => { throw new Error("fail"); });
  setStateVars(VARS);
  const r = await analyzePatterns([makeNote("researcher-2026-07-02-x")], "ctx");
  assert.deepEqual(r.signposts, []);
  assert.ok(r.error);
  resetRunners();
});
test("analyzePatterns: invalid JSON", async () => {
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: "not json" } }] }));
  setStateVars(VARS);
  const r = await analyzePatterns([makeNote("researcher-2026-07-02-x")], "ctx");
  assert.deepEqual(r.signposts, []);
  resetRunners();
});
test("analyzePatterns: no choices", async () => {
  setDeepSeekCaller(async () => ({}));
  setStateVars(VARS);
  const r = await analyzePatterns([makeNote("researcher-2026-07-02-x")], "ctx");
  assert.deepEqual(r.signposts, []);
  resetRunners();
});

// ============================ processAnalystTask tests ============================

test("processAnalystTask: no notes → no_action", async () => {
  setGhCaller(async () => []);
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"signposts":[],"noise":[]}' } }] }));
  setStateVars(VARS);
  const r = await processAnalystTask();
  assert.equal(r.no_action, true);
  resetRunners();
});
test("processAnalystTask: has signposts → write", async () => {
  setGhCaller(async (m, path) => {
    if (path === "30_Research/Selected") return [{ name: "researcher-2026-07-02-test.md", path: "30_Research/Selected/researcher-2026-07-02-test.md" }];
    if (path === "20_Project" || path === "00_Inbox") return [];
    if (path.includes("test.md")) return { content: Buffer.from("---\nconfidence: C4\ntopics: [\"AI\"]\n---\n# Test\ncontent").toString("base64") };
    return null;
  });
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"signposts":[{"direction":"Agent","strength":"弱（2篇）","evidence":["test"],"judgment":"方向明确","suggestion":""}],"noise":[],"topics":["AI"]}' } }] }));
  setStateVars(VARS);
  const r = await processAnalystTask();
  assert.equal(r.action, "write");
  assert.ok(r.analyst_path.includes("analyst-"));
  assert.equal(r.signposts, 1);
  resetRunners();
});
test("processAnalystTask: no signposts + ≤2 notes → no_action", async () => {
  setGhCaller(async (m, path) => {
    if (path === "30_Research/Selected") return [{ name: "researcher-2026-07-02-test.md", path: "30_Research/Selected/researcher-2026-07-02-test.md" }];
    if (path === "20_Project" || path === "00_Inbox") return [];
    if (path.includes("test.md")) return { content: Buffer.from("---\nconfidence: C4\ntopics: [\"AI\"]\n---\n# Test\ncontent").toString("base64") };
    return null;
  });
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"signposts":[],"noise":[]}' } }] }));
  setStateVars(VARS);
  const r = await processAnalystTask();
  assert.equal(r.no_action, true);
  resetRunners();
});
test("processAnalystTask: noise only + >2 notes → write", async () => {
  setGhCaller(async (m, path) => {
    if (path === "30_Research/Selected") return ["a", "b", "c"].map(n => ({ name: "researcher-2026-07-02-" + n + ".md", path: "30_Research/Selected/researcher-2026-07-02-" + n + ".md" }));
    if (path === "20_Project" || path === "00_Inbox") return [];
    if (path.endsWith(".md")) return { content: Buffer.from("---\nconfidence: C4\ntopics: [\"AI\"]\n---\n# Note\ncontent").toString("base64") };
    return null;
  });
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"signposts":[],"noise":[{"note":"c","reason":"不相关"}],"topics":[]}' } }] }));
  setStateVars(VARS);
  const r = await processAnalystTask();
  assert.equal(r.action, "write");
  assert.equal(r.noise, 1);
  resetRunners();
});

// ============================ FUZZ ROUND 1 ============================

test("FUZZ ROUND 1 (seed 1): variable notes + pattern invariants", async () => {
  const rng = mulberry32(1);
  const topics = [["AI", "agent"], ["blockchain"], ["health"], ["AI", "org"], ["product"]];
  const confs = ["C0", "C1", "C2", "C3", "C4"];
  let sawWrite = 0, sawNoAction = 0;

  for (let i = 0; i < 50; i++) {
    const count = rand(rng, 0, 5);
    const notes = [];
    for (let j = 0; j < count; j++) {
      notes.push(makeNote("researcher-2026-07-02-n" + j, { topics: pick(rng, topics), confidence: pick(rng, confs), isNoise: rng() > 0.7 }));
    }
    setGhCaller(async (m, path) => {
      if (path === "30_Research/Selected") return notes.map(n => ({ name: n.fileName, path: n.path }));
      if (path === "20_Project" || path === "00_Inbox") return [];
      if (path.endsWith(".md")) { const n = notes.find(x => path.includes(x.name)); return n ? { content: Buffer.from(n.content).toString("base64") } : null; }
      return null;
    });
    const hasSp = rng() > 0.4;
    const sp = hasSp ? [{ direction: "d" + i, strength: "弱（2篇）", evidence: ["researcher-2026-07-02-n0", "researcher-2026-07-02-n1"], judgment: "x", suggestion: "" }] : [];
    const ns = rng() > 0.5 ? [{ note: "researcher-2026-07-02-n0", reason: "不相关" }] : [];
    setDeepSeekCaller(async () => ({ choices: [{ message: { content: JSON.stringify({ signposts: sp, noise: ns, topics: ["t"] }) } }] }));
    setStateVars(VARS);
    const r = await processAnalystTask();
    assert.ok(r.action === "write" || r.no_action === true);
    if (r.action === "write") sawWrite++; else sawNoAction++;
  }
  assert.ok(sawWrite > 0, "must see write");
  assert.ok(sawNoAction > 0, "must see no_action");
  resetRunners();
});

// ============================ FUZZ ROUND 2 ============================

test("FUZZ ROUND 2 (seed 2): variable DeepSeek responses", async () => {
  const rng = mulberry32(2);
  const modes = ["valid", "invalid", "empty", "error", "partial"];
  let sawWrite = 0, sawNoAction = 0;

  for (let i = 0; i < 50; i++) {
    const mode = pick(rng, modes);
    const count = rand(rng, 1, 4);
    const notes = [];
    for (let j = 0; j < count; j++) notes.push(makeNote("researcher-2026-07-02-n" + j));
    setGhCaller(async (m, path) => {
      if (path === "30_Research/Selected") return notes.map(n => ({ name: n.fileName, path: n.path }));
      if (path === "20_Project" || path === "00_Inbox") return [];
      if (path.endsWith(".md")) { const n = notes[0]; return n ? { content: Buffer.from(n.content).toString("base64") } : null; }
      return null;
    });
    if (mode === "valid") {
      const sp = rng() > 0.3 ? [{ direction: "d" + i, strength: "弱（2篇）", evidence: ["researcher-2026-07-02-n0"], judgment: "j", suggestion: "" }] : [];
      setDeepSeekCaller(async () => ({ choices: [{ message: { content: JSON.stringify({ signposts: sp, noise: [], topics: ["t"] }) } }] }));
    } else if (mode === "invalid") {
      setDeepSeekCaller(async () => ({ choices: [{ message: { content: "not json" } }] }));
    } else if (mode === "empty") {
      setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"signposts":[],"noise":[]}' } }] }));
    } else if (mode === "error") {
      setDeepSeekCaller(async () => { throw new Error("err"); });
    } else {
      setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"signposts":[{"direction":"x"' } }] }));
    }
    setStateVars(VARS);
    const r = await processAnalystTask();
    assert.ok(r.action === "write" || r.no_action === true);
    if (r.action === "write") sawWrite++; else sawNoAction++;
  }
  assert.ok(sawWrite > 0, "must see write");
  assert.ok(sawNoAction > 0, "must see no_action");
  resetRunners();
});
