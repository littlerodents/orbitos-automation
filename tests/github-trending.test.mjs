import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildTrendingSection,
  isNewToday,
  loadState,
  markSeen,
  parseTrendingHtml,
  pruneState,
} from "../github-trending.mjs";

const FIXTURE = readFileSync(new URL("./fixtures/github-trending-daily.html", import.meta.url), "utf8");
const TODAY = "2026-10-24";

test("parseTrendingHtml reads repo, stars, gain, language and description", () => {
  const repos = parseTrendingHtml(FIXTURE);
  assert.equal(repos.length, 3);
  assert.deepEqual(repos[0], {
    repo: "cloudflare/security-audit-skill",
    stars: "43439",
    gain: "2,271/日",
    lang: "JavaScript",
    desc: "A coding-agent skill for multi-phase security audits with independently verified, machine-readable findings",
  });
  assert.equal(repos[1].repo, "NVIDIA/OpenShell");
  assert.equal(repos[1].lang, "Rust");
  assert.equal(repos[1].stars, "19230");
  // 不把 /login?return_to= 之类链接误当仓库
  assert.ok(repos.every((r) => /^[\w.-]+\/[\w.-]+$/.test(r.repo)));
});

test("parseTrendingHtml returns [] on empty or hostile markup instead of throwing", () => {
  assert.deepEqual(parseTrendingHtml(""), []);
  assert.deepEqual(parseTrendingHtml("<html><body>no cards</body></html>"), []);
  assert.deepEqual(parseTrendingHtml(null), []);
});

test("markSeen records firstSeen once and keeps the same day stable across reruns", () => {
  const repos = parseTrendingHtml(FIXTURE);
  const first = markSeen({ repos: {} }, repos, TODAY);
  assert.equal(first.repos["cloudflare/security-audit-skill"].firstSeen, TODAY);
  assert.equal(isNewToday(first, "cloudflare/security-audit-skill", TODAY), true);

  // 同日重跑：仍然算"今日新上榜"，不会因为第二次运行而丢失标记
  const again = markSeen(first, repos, TODAY);
  assert.equal(again.repos["cloudflare/security-audit-skill"].firstSeen, TODAY);
  assert.equal(isNewToday(again, "cloudflare/security-audit-skill", TODAY), true);

  // 次日：不再算新
  const tomorrow = markSeen(again, repos, "2026-10-25");
  assert.equal(isNewToday(tomorrow, "cloudflare/security-audit-skill", "2026-10-25"), false);
  assert.equal(tomorrow.repos["cloudflare/security-audit-skill"].firstSeen, TODAY);
});

test("buildTrendingSection marks newcomers and caps the daily list", () => {
  const daily = parseTrendingHtml(FIXTURE);
  const state = markSeen({ repos: {} }, daily.slice(0, 1), TODAY); // 只有第一个是"今日新"
  const text = buildTrendingSection({ daily, weekly: [], state, today: TODAY, limit: 2 });

  assert.match(text, /daily top2/);
  assert.match(text, /1\. cloudflare\/security-audit-skill/);
  assert.match(text, /★新/);
  assert.match(text, /2\. NVIDIA\/OpenShell/);
  assert.doesNotMatch(text, /3\. aws\/agent-toolkit-for-aws/, "limit 之外不出现");
  assert.doesNotMatch(text, /NaN/, "star 数字格式化不产生 NaN");
});

test("buildTrendingSection returns empty string when there is no data", () => {
  assert.equal(buildTrendingSection({ daily: [], weekly: [], state: { repos: {} }, today: TODAY }), "");
});

test("pruneState drops repos unseen for more than 30 days and keeps recent ones", () => {
  const state = {
    repos: {
      "old/repo": { firstSeen: "2026-08-01", lastSeen: "2026-08-01" },
      "fresh/repo": { firstSeen: "2026-10-20", lastSeen: "2026-10-20" },
    },
  };
  const pruned = pruneState(state, TODAY);
  assert.equal(pruned.repos["old/repo"], undefined, "30 天前的条目被清掉，快照不无限增长");
  assert.ok(pruned.repos["fresh/repo"]);
});

test("loadState tolerates a missing or corrupt snapshot file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trending-state-"));
  const missing = path.join(dir, "nope.json");
  assert.deepEqual(loadState(missing), { repos: {}, lastRun: null });

  const corrupt = path.join(dir, "bad.json");
  writeFileSync(corrupt, "{not json", "utf8");
  assert.deepEqual(loadState(corrupt), { repos: {}, lastRun: null });

  const good = path.join(dir, "good.json");
  writeFileSync(good, JSON.stringify({ repos: { "a/b": { firstSeen: TODAY, lastSeen: TODAY } }, lastRun: "x" }), "utf8");
  const loaded = loadState(good);
  assert.equal(loaded.repos["a/b"].firstSeen, TODAY);
  assert.equal(loaded.lastRun, "x");
});
