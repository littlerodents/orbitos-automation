import assert from "node:assert/strict";
import test from "node:test";

import {
  extractPersonName, scoreConfidence, dedupResults, buildQueries,
  cleanPageText, readVaultBaseline, searchLoop, deltaCompare,
  prepareGitHubOps, executeGitHubOps, processResearchTask,
  setGhCaller, setExaSearcher, setDeepSeekCaller, setStateVars, resetRunners,
} from "../researcher-agent-logic.mjs";

// ---- seeded PRNG ----
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

const VARS = { OWNER: "test", REPO: "test-repo", BRANCH: "main" };

function makeResult(url, title, text, opts = {}) {
  return { url, title: title || "", text: text || "", publishedDate: opts.date || "", score: opts.score || 0 };
}

function makeTask(name, taskTitle, opts = {}) {
  return { json: {
    name: name || `#task researcher ${taskTitle}.md`,
    path: opts.path || `00_Inbox/#task researcher ${taskTitle}.md`,
    sha: opts.sha || "sha-" + Math.random().toString(36).slice(2, 10),
    task_title: taskTitle,
    content: opts.content ? Buffer.from(opts.content).toString("base64") : "",
  }};
}

// ============================ Pure function tests ============================

test("extractPersonName: 2-char name", () => { assert.equal(extractPersonName("王佳 AI"), "王佳"); });
test("extractPersonName: 3-char name", () => { assert.equal(extractPersonName("王佳梁 AI"), "王佳梁"); });
test("extractPersonName: 4-char name", () => { assert.equal(extractPersonName("欧阳明日 test"), "欧阳明日"); });
test("extractPersonName: English only → empty", () => { assert.equal(extractPersonName("AI agent team"), ""); });
test("extractPersonName: no space after → empty", () => { assert.equal(extractPersonName("王佳梁AI"), ""); });

test("scoreConfidence: empty → C0", () => { assert.equal(scoreConfidence([], "x"), "C0"); assert.equal(scoreConfidence(null, "x"), "C0"); });

test("scoreConfidence: person C4 interview", () => {
  const r = [makeResult("https://dtalk.org/1", "专访王佳梁", "王佳梁 AI agent 专访实录")];
  assert.equal(scoreConfidence(r, "王佳梁 AI agent"), "C4");
});

test("scoreConfidence: person C4 author blog", () => {
  const r = [makeResult("https://medium.com/@wang/blog", "My AI thoughts", "王佳梁 writes about AI agent")];
  assert.equal(scoreConfidence(r, "王佳梁 AI agent"), "C4");
});

test("scoreConfidence: person C4 arxiv", () => {
  const r = [makeResult("https://arxiv.org/abs/123", "Paper", "王佳梁 AI agent paper")];
  assert.equal(scoreConfidence(r, "王佳梁 AI agent"), "C4");
});

test("scoreConfidence: person NOT C4 github without mention", () => {
  const r = [makeResult("https://github.com/x/ai-agent", "Repo", "multi-agent framework")];
  assert.notEqual(scoreConfidence(r, "王佳梁 AI agent"), "C4");
});

test("scoreConfidence: person C2 credible news", () => {
  const r = [makeResult("https://36kr.com/p/1", "news", "王佳梁 AI agent team 深度报道".repeat(10))];
  assert.equal(scoreConfidence(r, "王佳梁 AI agent team"), "C2");
});

test("scoreConfidence: person C3 two domains", () => {
  const r = [
    makeResult("https://36kr.com/p/1", "n1", "王佳梁 AI agent team 深度".repeat(10)),
    makeResult("https://thepaper.cn/n/2", "n2", "王佳梁 AI agent team 报道".repeat(10)),
  ];
  assert.equal(scoreConfidence(r, "王佳梁 AI agent team"), "C3");
});

test("scoreConfidence: person C1 no person mention", () => {
  const r = [makeResult("https://example.com/post", "AI agent", "AI agent team framework content")];
  assert.equal(scoreConfidence(r, "王佳梁 AI agent team"), "C1");
});

test("scoreConfidence: skip irrelevant (ratio<0.3)", () => {
  const r = [makeResult("https://example.com", "unrelated", "cooking recipe")];
  assert.equal(scoreConfidence(r, "王佳梁 AI agent team"), "C0");
});

test("scoreConfidence: skip invalid URL", () => {
  const r = [{ url: "not-a-url", title: "x", text: "王佳梁 AI agent" }];
  assert.equal(scoreConfidence(r, "王佳梁 AI agent"), "C0");
});

test("scoreConfidence: topic C4 github high relevance", () => {
  const r = [makeResult("https://github.com/x/agent-org", "Agent Org", "AI agent 组织结构 framework".repeat(5))];
  assert.equal(scoreConfidence(r, "AI agent 组织结构"), "C4");
});

test("scoreConfidence: topic C4 arxiv", () => {
  const r = [makeResult("https://arxiv.org/abs/1", "Paper", "AI agent 组织结构 paper")];
  assert.equal(scoreConfidence(r, "AI agent 组织结构"), "C4");
});

test("scoreConfidence: topic C2 mckinsey", () => {
  const r = [makeResult("https://www.mckinsey.com.cn/ai", "McKinsey", "AI agent 组织结构 报告")];
  assert.equal(scoreConfidence(r, "AI agent 组织结构"), "C2");
});

test("scoreConfidence: topic C2 high relevance long text", () => {
  const r = [makeResult("https://blog.example.com/post", "blog", "AI agent 组织结构 深度分析".repeat(50))];
  assert.equal(scoreConfidence(r, "AI agent 组织结构"), "C2");
});

test("scoreConfidence: topic C3 two domains", () => {
  const r = [
    makeResult("https://blog.example.com/a", "a", "AI agent 组织结构 分析".repeat(50)),
    makeResult("https://other.com/b", "b", "AI agent 组织结构 观点".repeat(50)),
  ];
  assert.equal(scoreConfidence(r, "AI agent 组织结构"), "C3");
});

test("scoreConfidence: topic C1 low relevance", () => {
  const r = [makeResult("https://example.com/post", "post", "AI something else")];
  assert.equal(scoreConfidence(r, "AI agent 组织结构"), "C1");
});

test("scoreConfidence: relevance gate — irrelevant results forced to C1", () => {
  // Task: "原音 产品定位" — 2 keywords
  // Results: match both keywords individually but NOT as a phrase → different entity
  const r = [
    makeResult("https://blog.example.com/post1", "原音咨询品牌管理机构", "原音是一家品牌咨询公司，提供产品定位服务。".repeat(20)),
    makeResult("https://other.com/post2", "原音 AI 翻译", "原音 AI 即时翻译产品定位为消费级工具。".repeat(20)),
  ];
  // Both keywords match individually (ratio=1.0) but "原音 产品定位" never appears as a phrase
  const conf = scoreConfidence(r, "原音 产品定位");
  assert.equal(conf, "C1", "irrelevant results should be forced to C1");
});

test("scoreConfidence: relevance gate — relevant results keep C3/C4", () => {
  // Task: "AI agent 组织结构" — results contain the phrase "AI agent" consecutively
  const r = [
    makeResult("https://blog.example.com/a", "AI agent org", "AI agent 组织结构 分析".repeat(50)),
    makeResult("https://other.com/b", "AI agent struct", "AI agent 组织结构 观点".repeat(50)),
  ];
  const conf = scoreConfidence(r, "AI agent 组织结构");
  assert.equal(conf, "C3", "relevant results should keep C3");
});

test("scoreConfidence: relevance gate — single keyword title not affected", () => {
  // Title with only 1 keyword → relevance gate doesn't apply (needs >= 2 keywords)
  const r = [makeResult("https://arxiv.org/abs/1", "Paper", "blockchain paper content")];
  const conf = scoreConfidence(r, "blockchain");
  assert.ok(["C1", "C2", "C3", "C4"].includes(conf));
});

test("dedupResults: dedup same domain, keep longer text", () => {
  const r = [makeResult("https://a.com/p", "A", "short"), makeResult("https://a.com/p", "A", "longer text content")];
  const d = dedupResults(r);
  assert.ok(d.length >= 1);
  assert.ok(d[0].text.length > 5);
});

test("dedupResults: keep different domains", () => {
  const r = [makeResult("https://a.com/p", "A", "x"), makeResult("https://b.com/p", "B", "y")];
  assert.equal(dedupResults(r).length, 2);
});

test("dedupResults: no-url results kept in noUrl", () => {
  const r = [{ title: "no url", text: "content here" }, makeResult("https://a.com/p", "A", "valid")];
  assert.equal(dedupResults(r).length, 2);
});

test("dedupResults: invalid-url results kept", () => {
  const r = [{ url: "invalid", text: "content" }, makeResult("https://a.com/p", "A", "valid")];
  assert.equal(dedupResults(r).length, 2);
});

test("dedupResults: empty input", () => { assert.equal(dedupResults([]).length, 0); });

test("buildQueries: round 1", () => { assert.deepEqual(buildQueries("test title", 1), ["test title"]); });
test("buildQueries: round 2 multi-word", () => {
  const q = buildQueries("王佳梁 AI agent", 2);
  assert.ok(q.length >= 2); assert.ok(q[0].includes("演讲 2026"));
});
test("buildQueries: round 2 single word", () => {
  const q = buildQueries("test", 2);
  assert.ok(q[0].includes("演讲 2026"));
});
test("buildQueries: round 3", () => {
  const q = buildQueries("王佳梁 AI", 3);
  assert.ok(q.length <= 3); assert.ok(q.some(x => x.includes("AI-native") || x.includes("论文") || x.includes("framework 2026")));
});
test("buildQueries: round 3 filters empty", () => {
  const q = buildQueries("中文", 3);
  assert.ok(q.every(x => x.trim().length > 3));
});
test("buildQueries: unknown round", () => { assert.deepEqual(buildQueries("test", 99), ["test"]); });

test("cleanPageText: empty", () => { assert.equal(cleanPageText(""), ""); });
test("cleanPageText: all noise", () => {
  assert.equal(cleanPageText("登录\n注册\n关注作者\n原创"), "");
});
test("cleanPageText: mixed noise and content", () => {
  const t = "登录\n注册\n# Title\nThis is a substantive paragraph about AI agent frameworks.";
  const c = cleanPageText(t);
  assert.ok(c.includes("substantive paragraph"));
  assert.ok(!c.includes("登录"));
});
test("cleanPageText: truncate at sentence", () => {
  const t = "这是一段很长的正文内容。".repeat(100);
  const c = cleanPageText(t, 100);
  assert.ok(c.length <= 101);
  assert.ok(c.endsWith("。") || c.endsWith("..."));
});
test("cleanPageText: markdown decoration only", () => {
  assert.equal(cleanPageText("---\n***\n___"), "");
});

// ============================ Logic function tests ============================

test("readVaultBaseline: empty vault", async () => {
  setGhCaller(async () => null);
  setStateVars(VARS);
  const b = await readVaultBaseline();
  assert.equal(b, "(vault empty)");
  resetRunners();
});

test("readVaultBaseline: with files", async () => {
  let callCount = 0;
  setGhCaller(async (method, path) => {
    callCount++;
    if (path === "30_Research/Selected") return [{ name: "test.md", path: "30_Research/Selected/test.md" }];
    if (path === "40_Wiki") return [];
    if (path === "20_Project") return [];
    if (path === "00_Inbox") return [{ name: "brief-2026-07-01.md", path: "00_Inbox/brief-2026-07-01.md" }];
    if (path.includes("test.md")) return { content: Buffer.from("# Test\ncontent").toString("base64") };
    if (path.includes("brief")) return { content: Buffer.from("# Brief\ncontent").toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const b = await readVaultBaseline();
  assert.ok(b.includes("test.md"));
  assert.ok(b.includes("brief-2026-07-01.md"));
  resetRunners();
});

test("searchLoop: C4 stops round 1", async () => {
  setExaSearcher(async () => [makeResult("https://dtalk.org/1", "专访王佳梁", "王佳梁 AI 专访")]);
  setStateVars(VARS);
  const { bestConfidence, roundsDone } = await searchLoop("王佳梁 AI", "王佳梁 AI", 3);
  assert.equal(bestConfidence, "C4");
  assert.equal(roundsDone, 1);
  resetRunners();
});

test("searchLoop: C0 all rounds", async () => {
  setExaSearcher(async () => []);
  setStateVars(VARS);
  const { bestConfidence, roundsDone, queriesTried } = await searchLoop("unknown topic xyz", "unknown topic xyz", 3);
  assert.equal(bestConfidence, "C0");
  assert.equal(roundsDone, 3);
  assert.ok(queriesTried.length >= 1);
  resetRunners();
});

test("searchLoop: C2 stops after round 2", async () => {
  let call = 0;
  setExaSearcher(async () => {
    call++;
    if (call <= 2) return [makeResult("https://36kr.com/p/1", "n", "王佳梁 AI agent team 报道".repeat(10))];
    return [];
  });
  setStateVars(VARS);
  const { bestConfidence, roundsDone } = await searchLoop("王佳梁 AI agent team", "王佳梁 AI agent team", 3);
  assert.equal(bestConfidence, "C2");
  assert.ok(roundsDone >= 2);
  resetRunners();
});

test("searchLoop: exa error returns empty", async () => {
  setExaSearcher(async () => { throw new Error("network"); });
  setStateVars(VARS);
  const { bestConfidence } = await searchLoop("test", "test", 2);
  assert.equal(bestConfidence, "C0");
  resetRunners();
});

test("deltaCompare: returns insight", async () => {
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: "增量发现：test insight" } }] }));
  setStateVars(VARS);
  const insight = await deltaCompare("test", [makeResult("https://a.com", "A", "text")], "baseline");
  assert.equal(insight, "增量发现：test insight");
  resetRunners();
});

test("deltaCompare: returns empty on no choices", async () => {
  setDeepSeekCaller(async () => ({}));
  setStateVars(VARS);
  const insight = await deltaCompare("test", [makeResult("https://a.com", "A", "text")], "baseline");
  assert.equal(insight, "");
  resetRunners();
});

test("deltaCompare: returns ERROR on exception", async () => {
  setDeepSeekCaller(async () => { throw new Error("ds error"); });
  setStateVars(VARS);
  const insight = await deltaCompare("test", [makeResult("https://a.com", "A", "text")], "baseline");
  assert.ok(insight.startsWith("ERROR"));
  resetRunners();
});

test("prepareGitHubOps: selected → 2 PUTs + 1 DELETE", () => {
  setStateVars(VARS);
  const ops = prepareGitHubOps({
    action: "selected", selected_path: "s", selected_b64: "b", selected_msg: "m",
    renamed_path: "r", renamed_b64: "rb", renamed_msg: "rm",
    old_path: "o", old_sha: "sh", task_title: "t",
  }, VARS);
  assert.equal(ops.filter(o => o.method === "PUT").length, 2);
  assert.equal(ops.filter(o => o.method === "DELETE").length, 1);
  resetRunners();
});

test("prepareGitHubOps: c1 → 1 PUT + 1 DELETE", () => {
  setStateVars(VARS);
  const ops = prepareGitHubOps({
    action: "c1", renamed_path: "r", renamed_b64: "rb", renamed_msg: "rm",
    old_path: "o", old_sha: "sh", task_title: "t",
  }, VARS);
  assert.equal(ops.filter(o => o.method === "PUT").length, 1);
  assert.equal(ops.filter(o => o.method === "DELETE").length, 1);
  resetRunners();
});

test("prepareGitHubOps: no old_sha → no DELETE", () => {
  setStateVars(VARS);
  const ops = prepareGitHubOps({
    action: "c1", renamed_path: "r", renamed_b64: "rb", renamed_msg: "rm",
    old_path: "o", old_sha: undefined, task_title: "t",
  }, VARS);
  assert.equal(ops.filter(o => o.method === "DELETE").length, 0);
  resetRunners();
});

test("prepareGitHubOps: unknown action → empty", () => {
  setStateVars(VARS);
  const ops = prepareGitHubOps({ action: "unknown" }, VARS);
  assert.equal(ops.length, 0);
  resetRunners();
});

test("prepareGitHubOps: uses stateVars when vars not passed", () => {
  setStateVars(VARS);
  const ops = prepareGitHubOps({
    action: "c1", renamed_path: "r", renamed_b64: "rb", renamed_msg: "rm",
    old_path: "o", old_sha: "sh", task_title: "t",
  });
  assert.equal(ops[0].body.branch, "main");
  resetRunners();
});

test("executeGitHubOps: all succeed", async () => {
  setGhCaller(async () => ({ ok: true }));
  setStateVars(VARS);
  const results = await executeGitHubOps([
    { method: "PUT", path: "a", body: {} },
    { method: "DELETE", path: "b", body: {} },
  ]);
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.ok));
  resetRunners();
});

test("executeGitHubOps: some fail", async () => {
  let call = 0;
  setGhCaller(async () => { call++; if (call === 1) throw new Error("fail"); return {}; });
  setStateVars(VARS);
  const results = await executeGitHubOps([
    { method: "PUT", path: "a", body: {} },
    { method: "DELETE", path: "b", body: {} },
  ]);
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, true);
  resetRunners();
});

test("executeGitHubOps: empty ops", async () => {
  setGhCaller(async () => ({}));
  setStateVars(VARS);
  const results = await executeGitHubOps([]);
  assert.equal(results.length, 0);
  resetRunners();
});

// ============================ processResearchTask tests ============================

test("processResearchTask: no_tasks → no_action", async () => {
  setExaSearcher(async () => []);
  setGhCaller(async () => null);
  setStateVars(VARS);
  const r = await processResearchTask({ json: { no_tasks: true } });
  assert.equal(r.no_action, true);
  resetRunners();
});

test("processResearchTask: C4 with increment → selected", async () => {
  setGhCaller(async () => null);
  setExaSearcher(async () => [makeResult("https://dtalk.org/1", "专访王佳梁", "王佳梁 AI 专访")]);
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: "新发现：test insight" } }] }));
  setStateVars(VARS);
  const r = await processResearchTask(makeTask("#task researcher 王佳梁 AI.md", "王佳梁 AI"));
  assert.equal(r.action, "selected");
  assert.equal(r.confidence, "C4");
  assert.ok(r.selected_path.includes("30_Research/Selected/"));
  assert.ok(r.renamed_path.includes("#done"));
  resetRunners();
});

test("processResearchTask: C2+ no increment → c1 无新增", async () => {
  setGhCaller(async () => null);
  setExaSearcher(async () => [makeResult("https://36kr.com/p/1", "n", "王佳梁 AI agent 报道".repeat(10))]);
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: "无新增：已有知识已覆盖" } }] }));
  setStateVars(VARS);
  const r = await processResearchTask(makeTask("#task researcher 王佳梁 AI.md", "王佳梁 AI agent"));
  assert.equal(r.action, "c1");
  assert.ok(r.renamed_path.includes("#result C3 无新增"));
  resetRunners();
});

test("processResearchTask: C1 → c1 result", async () => {
  setGhCaller(async () => null);
  setExaSearcher(async () => [makeResult("https://example.com", "x", "some content")]);
  setStateVars(VARS);
  const r = await processResearchTask(makeTask("#task researcher unknown.md", "unknown xyz"));
  assert.equal(r.action, "c1");
  assert.ok(r.renamed_path.includes("#result C1"));
  resetRunners();
});

test("processResearchTask: C0 → c1 result", async () => {
  setGhCaller(async () => null);
  setExaSearcher(async () => []);
  setStateVars(VARS);
  const r = await processResearchTask(makeTask("#task researcher test.md", "nonexistent"));
  assert.equal(r.action, "c1");
  assert.equal(r.confidence, "C0");
  resetRunners();
});

test("processResearchTask: task with body uses search hint", async () => {
  let capturedQuery = "";
  setGhCaller(async () => null);
  setExaSearcher(async (q) => { capturedQuery = q; return []; });
  setStateVars(VARS);
  await processResearchTask(makeTask("#task researcher test.md", "testtopic", { content: "search direction: quantum" }));
  assert.ok(capturedQuery.includes("quantum"));
  resetRunners();
});

test("processResearchTask: task with frontmatter body skips hint", async () => {
  let capturedQuery = "";
  setGhCaller(async () => null);
  setExaSearcher(async (q) => { capturedQuery = q; return []; });
  setStateVars(VARS);
  await processResearchTask(makeTask("#task researcher test.md", "testtopic", { content: "---\nfrontmatter: yes\n---\nbody" }));
  assert.ok(!capturedQuery.includes("frontmatter"));
  resetRunners();
});

test("processResearchTask: deepseek error → c1", async () => {
  setGhCaller(async () => null);
  setExaSearcher(async () => [makeResult("https://dtalk.org/1", "专访王佳梁", "王佳梁 AI 专访")]);
  setDeepSeekCaller(async () => { throw new Error("ds fail"); });
  setStateVars(VARS);
  const r = await processResearchTask(makeTask("#task researcher 王佳梁 AI.md", "王佳梁 AI"));
  // ERROR from deltaCompare → hasIncrement false → c1 path
  assert.equal(r.action, "c1");
  resetRunners();
});

// ============================ FUZZ ROUND 1 ============================
// Variable search results + confidence scoring invariants

test("FUZZ ROUND 1 (seed 1): variable results + confidence invariants", () => {
  const rng = mulberry32(1);
  const titles = ["王佳梁 AI agent", "AI agent 组织结构", "blockchain framework", "张三 神经网络", "English only topic"];
  let sawC0 = 0, sawC1 = 0, sawC2 = 0, sawC3 = 0, sawC4 = 0;

  for (let i = 0; i < 200; i++) {
    const title = pick(rng, titles);
    const numResults = rand(rng, 0, 5);
    const results = [];
    for (let j = 0; j < numResults; j++) {
      const domains = ["github.com", "arxiv.org", "thepaper.cn", "dtalk.org", "medium.com", "example.com", "36kr.com", "mckinsey.com.cn", "blog.test.com"];
      const domain = pick(rng, domains);
      const person = extractPersonName(title);
      const mentionsPerson = person && rng() > 0.5;
      const isInterview = rng() > 0.7;
      const textLen = rand(rng, 0, 600);
      const text = (mentionsPerson && person ? person + " " : "") + (isInterview ? "专访 演讲 " : "") + title + " ".repeat(textLen);
      results.push(makeResult(`https://${domain}/path${j}`, `${domain} article`, text));
    }

    const conf = scoreConfidence(results, title);
    assert.ok(["C0", "C1", "C2", "C3", "C4"].includes(conf), `invalid: ${conf}`);

    if (conf === "C0") sawC0++;
    if (conf === "C1") sawC1++;
    if (conf === "C2") sawC2++;
    if (conf === "C3") sawC3++;
    if (conf === "C4") sawC4++;
  }

  assert.ok(sawC0 > 0, "must see C0");
  assert.ok(sawC4 > 0, "must see C4");
  const nonC0 = [sawC1, sawC2, sawC3, sawC4].filter(x => x > 0).length;
  assert.ok(nonC0 >= 2, "must see 2+ non-C0 levels");
});

// ============================ FUZZ ROUND 2 ============================
// Variable task inputs + exa/deepseek outcomes + full pipeline invariants

test("FUZZ ROUND 2 (seed 2): variable tasks + pipeline invariants", async () => {
  const rng = mulberry32(2);
  const titles = ["王佳梁 AI agent team 框架", "AI agent 组织结构", "blockchain framework", "张三 神经网络 research", "English only topic"];
  const exaModes = ["always-c4", "always-c2", "always-empty", "first-empty-then-c2", "random-mix"];
  let sawSelected = 0, sawC1 = 0;

  for (let i = 0; i < 50; i++) {
    const title = pick(rng, titles);
    const mode = pick(rng, exaModes);
    const maxRounds = rand(rng, 1, 3);
    let callCount = 0;

    setGhCaller(async () => null);
    setExaSearcher(async () => {
      callCount++;
      if (mode === "always-c4") {
        const person = extractPersonName(title);
        return [makeResult("https://dtalk.org/t", `专访${person||"x"}`, `${person||"x"} ${title} 专访`)];
      }
      if (mode === "always-c2") {
        const person = extractPersonName(title);
        return [makeResult("https://36kr.com/p/t", "n", `${person||"x"} ${title} 报道`.repeat(10))];
      }
      if (mode === "always-empty") return [];
      if (mode === "first-empty-then-c2") {
        if (callCount <= 1) return [];
        const person = extractPersonName(title);
        return [makeResult("https://36kr.com/p/t", "n", `${person||"x"} ${title} 报道`.repeat(10))];
      }
      const r = rng();
      if (r < 0.3) return [];
      if (r < 0.6) return [makeResult("https://example.com/r", "r", "random " + title)];
      const person = extractPersonName(title);
      return [makeResult("https://dtalk.org/t", `专访${person||""}`, `${person||""} ${title} 专访`)];
    });
    setDeepSeekCaller(async () => ({ choices: [{ message: { content: rng() > 0.3 ? "增量发现：new insight" : "无新增" } }] }));
    setStateVars(VARS);

    const r = await processResearchTask(makeTask(`#task researcher ${title}.md`, title), { maxRounds });

    assert.ok(["selected", "c1"].includes(r.action), `bad action: ${r.action}`);
    assert.ok(["C0", "C1", "C2", "C3", "C4"].includes(r.confidence));
    assert.ok(r.rounds <= maxRounds, `rounds ${r.rounds} > ${maxRounds}`);

    if (r.action === "selected") {
      sawSelected++;
      assert.ok(["C2", "C3", "C4"].includes(r.confidence));
      const md = Buffer.from(r.selected_b64, "base64").toString("utf8");
      assert.ok(md.includes("type: selected-content"));
      assert.ok(r.renamed_path.includes("#done"));
    } else {
      sawC1++;
      assert.ok(["C0", "C1", "C2", "C3", "C4"].includes(r.confidence));
      assert.ok(r.renamed_path.includes("#result"));
    }
  }

  assert.ok(sawSelected > 0, "must see selected");
  assert.ok(sawC1 > 0, "must see c1");
  resetRunners();
});
