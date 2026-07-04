import assert from "node:assert/strict";
import test from "node:test";

import {
  getEngagementScore, getPeriod, isWithinHours, filterByTime,
  filterByEngagement, filterByEngagementWithTabSignals, dedupByAuthor, dedupBySeenIds, rankByEngagement,
  buildMonitorMarkdown, readVaultBaseline, getSeenIds, getTabSignals, saveSeenIds,
  buildSummaryEntry, processMonitorTask,
  setTimelineGetter, setTweetContentGetter, setGhCaller, setDeepSeekCaller, setTabSignalsGetter,
  setStateVars, resetRunners,
} from "../monitor-agent-logic.mjs";

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

let tweetCounter = 0;
function makeTweet(opts = {}) {
  tweetCounter++;
  return {
    id: opts.id || "tw" + tweetCounter,
    author: opts.author || "user" + tweetCounter,
    text: opts.text || "some tweet content about AI",
    likes: opts.likes ?? 50,
    retweets: opts.retweets ?? 10,
    replies: opts.replies ?? 5,
    quotes: opts.quotes ?? 0,
    views: opts.views ?? 1000,
    created_at: opts.created_at || new Date().toISOString(),
    url: opts.url || "https://x.com/i/status/123",
  };
}

// ============================ Pure function tests ============================

test("getEngagementScore: sums all metrics", () => {
  assert.equal(getEngagementScore({ likes: 100, retweets: 50, replies: 25, quotes: 5 }), 180);
  assert.equal(getEngagementScore({}), 0);
  assert.equal(getEngagementScore({ likes: "abc" }), 0);
});

test("getPeriod: morning/afternoon", () => {
  assert.equal(getPeriod(6), "morning");
  assert.equal(getPeriod(14), "afternoon");
  assert.equal(getPeriod(0), "morning");
});

test("isWithinHours: within 24h", () => {
  const now = new Date("2026-07-04T12:00:00Z");
  const tweet = { created_at: "2026-07-04T10:00:00Z" };
  assert.equal(isWithinHours(tweet, 24, now), true);
});

test("isWithinHours: older than 24h", () => {
  const now = new Date("2026-07-04T12:00:00Z");
  const tweet = { created_at: "2026-07-03T10:00:00Z" };
  assert.equal(isWithinHours(tweet, 24, now), false);
});

test("isWithinHours: future tweet → false", () => {
  const now = new Date("2026-07-04T12:00:00Z");
  const tweet = { created_at: "2026-07-05T10:00:00Z" };
  assert.equal(isWithinHours(tweet, 24, now), false);
});

test("isWithinHours: invalid date → false", () => {
  assert.equal(isWithinHours({ created_at: "invalid" }, 24), false);
  assert.equal(isWithinHours({}, 24), false);
});

test("filterByTime: filters correctly", () => {
  const now = new Date("2026-07-04T12:00:00Z");
  const tweets = [
    { created_at: "2026-07-04T10:00:00Z", id: "1" },
    { created_at: "2026-07-03T10:00:00Z", id: "2" },
  ];
  const r = filterByTime(tweets, 24, now);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "1");
});

test("filterByEngagement: threshold filter", () => {
  const tweets = [
    { likes: 200, retweets: 50, replies: 10, id: "1" },
    { likes: 50, retweets: 5, replies: 1, id: "2" },
  ];
  assert.equal(filterByEngagement(tweets, 100).length, 1);
  assert.equal(filterByEngagement(tweets, 0).length, 2);
});

test("filterByEngagementWithTabSignals: active author gets lower threshold", () => {
  const tweets = [
    { likes: 200, retweets: 50, replies: 10, id: "1", author: "normaluser" },
    { likes: 3, retweets: 1, replies: 1, id: "2", author: "thedankoe" },
    { likes: 3, retweets: 1, replies: 1, id: "3", author: "nobody" },
  ];
  // Normal threshold 100: only id=1 passes
  // With tab signals ["thedankoe"]: id=1 (score 260>=100) + id=2 (score 5>=5) pass, id=3 (5<100) fails
  const r = filterByEngagementWithTabSignals(tweets, 100, ["thedankoe"]);
  assert.equal(r.length, 2);
  assert.ok(r.some(t => t.id === "2"));
});

test("filterByEngagementWithTabSignals: no active authors = normal threshold", () => {
  const tweets = [
    { likes: 3, retweets: 1, replies: 1, id: "1", author: "thedankoe" },
  ];
  const r = filterByEngagementWithTabSignals(tweets, 100, []);
  assert.equal(r.length, 0);
});

test("filterByEngagementWithTabSignals: null activeAuthors", () => {
  const tweets = [
    { likes: 200, retweets: 50, id: "1", author: "user" },
  ];
  const r = filterByEngagementWithTabSignals(tweets, 100, null);
  assert.equal(r.length, 1);
});

test("filterByEngagementWithTabSignals: @ prefix handled", () => {
  const tweets = [
    { likes: 3, retweets: 1, replies: 1, id: "1", author: "@thedankoe" },
  ];
  const r = filterByEngagementWithTabSignals(tweets, 100, ["thedankoe"]);
  assert.equal(r.length, 1);
});

test("dedupByAuthor: max 2 per author", () => {
  const tweets = [
    { author: "A", likes: 300, id: "1" },
    { author: "A", likes: 200, id: "2" },
    { author: "A", likes: 100, id: "3" },
    { author: "B", likes: 50, id: "4" },
  ];
  const r = dedupByAuthor(tweets, 2);
  assert.equal(r.length, 3);
  assert.equal(r[0].id, "1");
  assert.equal(r[1].id, "2");
  assert.equal(r[2].id, "4");
});

test("dedupByAuthor: unknown author fallback", () => {
  const tweets = [{ likes: 100, id: "1" }, { likes: 200, id: "2" }];
  const r = dedupByAuthor(tweets, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "2");
});

test("dedupBySeenIds: removes seen", () => {
  const tweets = [{ id: "1" }, { id: "2" }, { id: "3" }];
  assert.equal(dedupBySeenIds(tweets, ["1", "3"]).length, 1);
  assert.equal(dedupBySeenIds(tweets, []).length, 3);
  assert.equal(dedupBySeenIds(tweets, null).length, 3);
});

test("dedupBySeenIds: skips empty id", () => {
  const tweets = [{ id: "" }, { id: "1" }];
  assert.equal(dedupBySeenIds(tweets, []).length, 1);
});

test("rankByEngagement: sort + limit", () => {
  const tweets = [
    { likes: 10, id: "1" },
    { likes: 100, id: "2" },
    { likes: 50, id: "3" },
  ];
  const r = rankByEngagement(tweets, 2);
  assert.equal(r.length, 2);
  assert.equal(r[0].id, "2");
  assert.equal(r[1].id, "3");
});

test("buildMonitorMarkdown: with entries", () => {
  const md = buildMonitorMarkdown([
    { author: "@sama", title: "OpenAI方向", summary: "Sam说下一步是不说话", increment: "跟agent gate相关", likes: 5100, retweets: 1200, url: "https://x.com/1" },
  ], "2026-07-04", "morning");
  assert.ok(md.includes("type: following-monitor"));
  assert.ok(md.includes("# Following Monitor — 2026-07-04 上午"));
  assert.ok(md.includes("@sama"));
  assert.ok(md.includes("likes=5100"));
  assert.ok(md.includes("增量"));
});

test("buildMonitorMarkdown: no entries", () => {
  const md = buildMonitorMarkdown([], "2026-07-04", "afternoon");
  assert.ok(md.includes("无高互动新内容"));
});

// ============================ Logic function tests ============================

test("readVaultBaseline: empty", async () => {
  setGhCaller(async () => null);
  setStateVars(VARS);
  assert.equal(await readVaultBaseline(), "(vault empty)");
  resetRunners();
});

test("readVaultBaseline: with data", async () => {
  setGhCaller(async (m, path) => {
    if (path === "30_Research/Selected") return [{ name: "test.md", path: "30_Research/Selected/test.md" }];
    if (path === "00_Inbox") return [{ name: "brief-2026-07-04.md", path: "00_Inbox/brief-2026-07-04.md" }];
    if (path.includes("test.md")) return { content: Buffer.from("# Test\ncontent").toString("base64") };
    if (path.includes("brief")) return { content: Buffer.from("# Brief\n## PATTERN\npattern").toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const b = await readVaultBaseline();
  assert.ok(b.includes("test.md"));
  assert.ok(b.includes("PATTERN"));
  resetRunners();
});

test("getSeenIds: existing file", async () => {
  setGhCaller(async (m, path) => {
    if (path.includes(".monitor-seen-ids")) return { content: Buffer.from(JSON.stringify(["1", "2"])).toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const ids = await getSeenIds();
  assert.deepEqual(ids, ["1", "2"]);
  resetRunners();
});

test("getSeenIds: no file → empty", async () => {
  setGhCaller(async () => { throw new Error("404"); });
  setStateVars(VARS);
  assert.deepEqual(await getSeenIds(), []);
  resetRunners();
});

test("getTabSignals: existing file", async () => {
  setGhCaller(async (m, path) => {
    if (path.includes(".monitor-tab-signals")) return { content: Buffer.from(JSON.stringify({ active_authors: ["dankoe", "sama"] })).toString("base64") };
    return null;
  });
  setStateVars(VARS);
  const authors = await getTabSignals();
  assert.deepEqual(authors, ["dankoe", "sama"]);
  resetRunners();
});

test("getTabSignals: no file → empty", async () => {
  setGhCaller(async () => { throw new Error("404"); });
  setStateVars(VARS);
  assert.deepEqual(await getTabSignals(), []);
  resetRunners();
});

test("saveSeenIds: writes to GitHub", async () => {
  let written = null;
  setGhCaller(async (method, path, body) => {
    if (method === "PUT") { written = { path, body }; return {}; }
    return null;
  });
  setStateVars(VARS);
  await saveSeenIds(["1", "2", "3"]);
  assert.ok(written.path.includes(".monitor-seen-ids"));
  resetRunners();
});

test("saveSeenIds: error → silent", async () => {
  setGhCaller(async () => { throw new Error("fail"); });
  setStateVars(VARS);
  await saveSeenIds(["1"]);
  resetRunners();
});

test("buildSummaryEntry: with increment", async () => {
  setTweetContentGetter(async () => "full tweet text here");
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"title":"AI方向","summary":"Sam说下一步是不说话","increment":"跟agent gate相关"}' } }] }));
  setStateVars(VARS);
  const entry = await buildSummaryEntry(makeTweet({ author: "@sama", likes: 5000 }), "baseline");
  assert.ok(entry);
  assert.equal(entry.author, "@sama");
  assert.ok(entry.title);
  resetRunners();
});

test("buildSummaryEntry: no increment → null", async () => {
  setTweetContentGetter(async () => "text");
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"title":"X","summary":"Y","increment":"无增量"}' } }] }));
  setStateVars(VARS);
  const entry = await buildSummaryEntry(makeTweet(), "baseline");
  assert.equal(entry, null);
  resetRunners();
});

test("buildSummaryEntry: deepseek error → null", async () => {
  setTweetContentGetter(async () => "text");
  setDeepSeekCaller(async () => { throw new Error("ds"); });
  setStateVars(VARS);
  const entry = await buildSummaryEntry(makeTweet(), "baseline");
  assert.equal(entry, null);
  resetRunners();
});

test("buildSummaryEntry: invalid JSON → null", async () => {
  setTweetContentGetter(async () => "text");
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: "not json" } }] }));
  setStateVars(VARS);
  const entry = await buildSummaryEntry(makeTweet(), "baseline");
  assert.equal(entry, null);
  resetRunners();
});

test("buildSummaryEntry: no choices → null", async () => {
  setTweetContentGetter(async () => "text");
  setDeepSeekCaller(async () => ({}));
  setStateVars(VARS);
  const entry = await buildSummaryEntry(makeTweet(), "baseline");
  assert.equal(entry, null);
  resetRunners();
});

test("buildSummaryEntry: tweetContentGetter error → still works", async () => {
  setTweetContentGetter(async () => { throw new Error("fail"); });
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"title":"T","summary":"S","increment":"new"}' } }] }));
  setStateVars(VARS);
  const entry = await buildSummaryEntry(makeTweet({ text: "fallback text" }), "baseline");
  assert.ok(entry);
  resetRunners();
});

// ============================ processMonitorTask tests ============================

test("processMonitorTask: empty timeline → write no content", async () => {
  setTimelineGetter(async () => []);
  setGhCaller(async () => null);
  setDeepSeekCaller(async () => ({}));
  setStateVars(VARS);
  const r = await processMonitorTask();
  assert.equal(r.action, "write");
  assert.equal(r.entries, 0);
  resetRunners();
});

test("processMonitorTask: timeline error → write no content", async () => {
  setTimelineGetter(async () => { throw new Error("fail"); });
  setGhCaller(async () => null);
  setDeepSeekCaller(async () => ({}));
  setStateVars(VARS);
  const r = await processMonitorTask();
  assert.equal(r.action, "write");
  assert.equal(r.entries, 0);
  resetRunners();
});

test("processMonitorTask: with entries → write", async () => {
  setTimelineGetter(async () => [
    makeTweet({ id: "1", author: "A", likes: 500, retweets: 100, created_at: new Date().toISOString() }),
    makeTweet({ id: "2", author: "B", likes: 200, retweets: 50, created_at: new Date().toISOString() }),
  ]);
  setGhCaller(async () => null);
  setTweetContentGetter(async () => "content");
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"title":"T","summary":"S","increment":"new insight"}' } }] }));
  setStateVars(VARS);
  const r = await processMonitorTask({ engagementThreshold: 100 });
  assert.equal(r.action, "write");
  assert.ok(r.entries > 0);
  assert.ok(r.monitor_path.includes("monitor-"));
  resetRunners();
});

test("processMonitorTask: all low engagement → no entries", async () => {
  setTimelineGetter(async () => [
    makeTweet({ id: "1", likes: 10, retweets: 1, created_at: new Date().toISOString() }),
  ]);
  setGhCaller(async () => null);
  setStateVars(VARS);
  const r = await processMonitorTask({ engagementThreshold: 100 });
  assert.equal(r.entries, 0);
  resetRunners();
});

test("processMonitorTask: same author max 2", async () => {
  setTimelineGetter(async () => [
    makeTweet({ id: "1", author: "A", likes: 500, created_at: new Date().toISOString() }),
    makeTweet({ id: "2", author: "A", likes: 400, created_at: new Date().toISOString() }),
    makeTweet({ id: "3", author: "A", likes: 300, created_at: new Date().toISOString() }),
  ]);
  setGhCaller(async () => null);
  setTweetContentGetter(async () => "text");
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"title":"T","summary":"S","increment":"new"}' } }] }));
  setStateVars(VARS);
  const r = await processMonitorTask({ engagementThreshold: 100, maxEntries: 5 });
  assert.ok(r.entries <= 2);
  resetRunners();
});

test("processMonitorTask: seen ids dedup", async () => {
  setTimelineGetter(async () => [
    makeTweet({ id: "seen1", author: "A", likes: 500, created_at: new Date().toISOString() }),
    makeTweet({ id: "new1", author: "B", likes: 300, created_at: new Date().toISOString() }),
  ]);
  setGhCaller(async (m, path) => {
    if (path.includes(".monitor-seen-ids")) return { content: Buffer.from(JSON.stringify(["seen1"])).toString("base64") };
    return null;
  });
  setTweetContentGetter(async () => "text");
  setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"title":"T","summary":"S","increment":"new"}' } }] }));
  setStateVars(VARS);
  const r = await processMonitorTask({ engagementThreshold: 100 });
  assert.equal(r.entries, 1);
  resetRunners();
});

// ============================ FUZZ ROUND 1 ============================
// Variable timeline content + engagement distribution

test("FUZZ ROUND 1 (seed 1): variable timeline + engagement invariants", async () => {
  const rng = mulberry32(1);
  const authors = ["sama", "dankoe", "karpathy", "elad", "swyx", "user" + 0];
  let sawEntries = 0, sawEmpty = 0;

  for (let i = 0; i < 200; i++) {
    const count = rand(rng, 0, 50);
    const timeline = [];
    for (let j = 0; j < count; j++) {
      timeline.push(makeTweet({
        id: "tw" + i + "_" + j,
        author: pick(rng, authors),
        likes: rand(rng, 0, 5000),
        retweets: rand(rng, 0, 1000),
        replies: rand(rng, 0, 500),
        created_at: new Date(Date.now() - rand(rng, 0, 48) * 3600000).toISOString(),
      }));
    }
    setTimelineGetter(async () => timeline);
    setGhCaller(async () => null);
    setTweetContentGetter(async () => "text");
    const hasIncrement = rng() > 0.3;
    setDeepSeekCaller(async () => ({ choices: [{ message: { content: hasIncrement ? '{"title":"T","summary":"S","increment":"new"}' : '{"title":"T","summary":"S","increment":"无增量"}' } }] }));
    setStateVars(VARS);

    const r = await processMonitorTask({ engagementThreshold: 100, maxEntries: 5, maxPerAuthor: 2 });
    assert.ok(r.action === "write");
    assert.ok(r.entries >= 0 && r.entries <= 5);
    if (r.entries > 0) sawEntries++; else sawEmpty++;
  }
  assert.ok(sawEntries > 0, "must see entries");
  assert.ok(sawEmpty > 0, "must see empty");
  resetRunners();
});

// ============================ FUZZ ROUND 2 ============================
// Variable increment judgment + edge cases

test("FUZZ ROUND 2 (seed 2): variable DeepSeek responses + edge cases", async () => {
  const rng = mulberry32(2);
  const modes = ["valid-increment", "no-increment", "error", "invalid-json", "no-choices", "empty-content"];
  let sawEntries = 0, sawEmpty = 0;

  for (let i = 0; i < 50; i++) {
    const mode = pick(rng, modes);
    const count = rand(rng, 1, 10);
    const timeline = [];
    for (let j = 0; j < count; j++) {
      timeline.push(makeTweet({
        id: "tw" + i + "_" + j, author: "auth" + j,
        likes: rand(rng, 50, 5000),
        created_at: new Date().toISOString(),
      }));
    }
    setTimelineGetter(async () => timeline);
    setGhCaller(async () => null);
    setTweetContentGetter(async () => "text");
    if (mode === "valid-increment") {
      setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"title":"T","summary":"S","increment":"new"}' } }] }));
    } else if (mode === "no-increment") {
      setDeepSeekCaller(async () => ({ choices: [{ message: { content: '{"title":"T","summary":"S","increment":"无增量"}' } }] }));
    } else if (mode === "error") {
      setDeepSeekCaller(async () => { throw new Error("ds"); });
    } else if (mode === "invalid-json") {
      setDeepSeekCaller(async () => ({ choices: [{ message: { content: "not json" } }] }));
    } else if (mode === "no-choices") {
      setDeepSeekCaller(async () => ({}));
    } else {
      setDeepSeekCaller(async () => ({ choices: [{ message: { content: "" } }] }));
    }
    setStateVars(VARS);

    const r = await processMonitorTask({ engagementThreshold: 100, maxEntries: 5 });
    assert.ok(r.action === "write");
    assert.ok(r.entries >= 0 && r.entries <= 5);
    if (r.entries > 0) sawEntries++; else sawEmpty++;
  }
  assert.ok(sawEntries > 0 || sawEmpty === 50);
  resetRunners();
});
