import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  DERIVATION_VERSION,
  FIELD,
  baseRecordPayload,
  buildPromotionMarkdown,
  classifyRecordLifecycle,
  deriveDisplayFields,
  inferRecord,
  isTransientLarkError,
  parseFrontmatter,
  sameCellValue,
  readwiseInMainView,
  shouldPromote,
  sourcePathFromFields,
  viewDefinitions,
} from "../orbitos-intake-base.mjs";

test("runtime paths are anchored to the script directory regardless of caller cwd", () => {
  const moduleUrl = new URL("../orbitos-intake-base.mjs", import.meta.url).href;
  const expectedRoot = path.dirname(new URL("../orbitos-intake-base.mjs", import.meta.url).pathname);
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import(${JSON.stringify(moduleUrl)}).then((m) => console.log(JSON.stringify({ root: m.ROOT, config: m.CONFIG_PATH, state: m.STATE_PATH })))`,
  ], { cwd: "/", encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const paths = JSON.parse(result.stdout.trim());
  assert.equal(paths.root, expectedRoot);
  assert.equal(paths.config, path.join(expectedRoot, "orbitos-intake-base.config.json"));
  assert.equal(paths.state, path.join(expectedRoot, "orbitos-intake-base.state.json"));
});

test("parseFrontmatter handles scalar fields and list tags", () => {
  const parsed = parseFrontmatter(`---
source: youmind
date: "2026-05-15"
tags:
  - youmind
  - web-reading
---
# Hello
`);

  assert.equal(parsed.data.source, "youmind");
  assert.equal(parsed.data.date, "2026-05-15");
  assert.deepEqual(parsed.data.tags, ["youmind", "web-reading"]);
  assert.match(parsed.body, /# Hello/);
});

test("filter digest leads with the first useful conclusion instead of its timestamp", () => {
  const derived = deriveDisplayFields({
    data: { type: "filter-digest" },
    fileName: "filter-2026-07-05-morning.md",
    fallbackTitle: "Filter — 2026-07-05 morning",
    body: `# Filter — 2026-07-05 morning

## AI agent 协作与组织架构
- [AI Agent Org Chart Patterns](https://example.com/org) — 补充四种可落地架构模式及 agent 在团队中的定位。
- [Shared OKRs](https://example.com/okr) — 补充人类与 agent 的职责边界。
`,
  });

  assert.equal(derived.title, "AI agent 协作与组织架构：补充四种可落地架构模式及 agent 在团队中的定位");
  assert.match(derived.summary, /^补充四种可落地架构模式/);
  assert.doesNotMatch(derived.summary, /https?:\/\//);
  assert.equal(derived.weeklyEligible, true);
});

test("research result titles expose confidence and no-new state", () => {
  const lowConfidence = deriveDisplayFields({
    data: {},
    fileName: "#result C1 researcher multi-agent 协作协议.md",
    fallbackTitle: "multi-agent 协作协议",
    body: `# multi-agent 协作协议

搜索方向：多agent之间的通信协议和角色分工机制

#result C1
搜索 2 轮未找到 C2+ 来源。`,
  });
  assert.equal(lowConfidence.title, "[低置信度 C1] multi-agent 协作协议");
  assert.match(lowConfidence.summary, /^搜索 2 轮未找到 C2\+ 来源/);

  const noNew = deriveDisplayFields({
    data: {},
    fileName: "#result C3 无新增 researcher 原音 产品定位.md",
    fallbackTitle: "#result C3 无新增",
    body: `#result C3 无新增
搜索结果与主人已有知识完全重复。
4. **可行动项**：无需任何操作，继续忽略这些结果。`,
  });
  assert.equal(noNew.title, "[无新增] 原音 产品定位");
  assert.match(noNew.summary, /^搜索结果与主人已有知识完全重复/);

  const archivedTask = deriveDisplayFields({
    data: {},
    fileName: "#task researcher 原音 康复训练.md",
    fallbackTitle: "[源文件已移除] [待研究] 原音 康复训练",
    body: `# [源文件已移除] [待研究] 原音 康复训练
搜索方向：AI 辅助语言康复训练。`,
  });
  assert.equal(archivedTask.title, "[待研究] 原音 康复训练");
  assert.equal(archivedTask.topic, "原音 康复训练");
});

test("YouMind description becomes the summary and empty groups are excluded", () => {
  const article = deriveDisplayFields({
    data: { source: "youmind", youmind_type: "article", board: "AI" },
    fileName: "sample.md",
    fallbackTitle: "Agent Memory",
    body: `# Agent Memory
## Source
- Board: AI
- URL: https://example.com

## Description

基于五个 Agent 三十天运行经验的记忆系统实践。

## Content

正文从这里开始。`,
  });
  assert.equal(article.title, "Agent Memory");
  assert.equal(article.summary, "基于五个 Agent 三十天运行经验的记忆系统实践。");
  assert.doesNotMatch(article.summary, /Board|URL/);
  assert.equal(article.weeklyEligible, true);

  const group = deriveDisplayFields({
    data: { source: "youmind", youmind_type: "group", board: "Chaos" },
    fileName: "2026-05-16 Materials.md",
    fallbackTitle: "Materials",
    body: `# Materials
## Source
- Board: Chaos

## Content

_No text content returned by YouMind API._`,
  });
  assert.equal(group.title, "[空分组] Chaos / Materials");
  assert.equal(group.weeklyEligible, false);
  assert.match(group.summary, /未返回正文/);

  const untitled = deriveDisplayFields({
    data: { source: "youmind", youmind_type: "article", board: "AI" },
    fileName: "untitled.md",
    fallbackTitle: "[NO TITLE]",
    body: `# [NO TITLE]

## Content

You haven't experienced anything near what you're capable of.The rest follows.`,
  });
  assert.equal(untitled.title, "You haven't experienced anything near what you're capable of");

  const emptyArticle = deriveDisplayFields({
    data: { source: "youmind", youmind_type: "other-webpage", board: "Chaos" },
    fileName: "empty.md",
    fallbackTitle: "How to Do Great Work",
    body: `# How to Do Great Work

## Content

_No text content returned by YouMind API._`,
  });
  assert.equal(emptyArticle.title, "[无正文] How to Do Great Work");
  assert.equal(emptyArticle.weeklyEligible, false);

  const placeholder = deriveDisplayFields({
    data: { source: "youmind", youmind_type: "document", board: "Chaos" },
    fileName: "doc.md",
    fallbackTitle: "Quit Your Job",
    body: `# Quit Your Job

## Content

Useful idea. <EMPTYPARAGRAPH> More context.`,
  });
  assert.doesNotMatch(placeholder.summary, /EMPTYPARAGRAPH/);
});

test("Readwise highlights lead the summary while metadata and link-only rows stay out", () => {
  const useful = deriveDisplayFields({
    data: {},
    fileName: "Tweets From Ada.md",
    fallbackTitle: "Tweets From Ada",
    body: `# Tweets From Ada

## Metadata
- Author: Ada
- Category: #tweets
- URL: https://twitter.com/ada

## Highlights
- 把模糊问题转化为可计算问题，再把结果转化为可验证输出。`,
  });
  assert.equal(useful.summary, "把模糊问题转化为可计算问题，再把结果转化为可验证输出。");
  assert.doesNotMatch(useful.summary, /Author|Category|twitter/);
  assert.equal(useful.weeklyEligible, true);

  const linkOnly = deriveDisplayFields({
    data: {},
    fileName: "Tweets From Empty.md",
    fallbackTitle: "Tweets From Empty",
    body: `# Tweets From Empty

## Metadata
- URL: https://twitter.com/empty

## Highlights
- https://t.co/abc ([View Tweet](https://x.com/empty/status/1))`,
  });
  assert.equal(linkOnly.weeklyEligible, false);
});

test("Feishu reminder titles lead with the first mandatory action", () => {
  const reminder = deriveDisplayFields({
    data: { source: "feishu", capture: "flag" },
    fileName: "feishu-reminder.md",
    fallbackTitle: "##### 2026-07-01 10:00 超级个体提醒",
    body: `# ##### 2026-07-01 10:00 超级个体提醒

## Content
##### 今天必须推进
1. P0 重要且紧急：给夏令营 OKR 做一次事实关账。
2. P0 重要且紧急：确认三件语料动作是否完成。`,
  });

  assert.equal(reminder.title, "超级个体提醒：给夏令营 OKR 做一次事实关账");
  assert.match(reminder.summary, /^给夏令营 OKR 做一次事实关账/);
});

test("YouMind briefs with no retained content stay out of current-readable views", () => {
  const brief = deriveDisplayFields({
    data: { source: "youmind", youmind_type: "document", board: "X书签简报" },
    fileName: "brief.md",
    fallbackTitle: "2026-03-02 - Twitter Briefing",
    body: `# 2026-03-02 - Twitter Briefing

## Content

筛选结果概览：经过内容质量评估，本期无符合保留标准的内容。`,
  });
  assert.equal(brief.title, "[无新增] 2026-03-02 - Twitter Briefing");
  assert.equal(brief.weeklyEligible, false);
});

test("inferRecord maps YouMind markdown into a Base payload", () => {
  const root = mkdtempSync(path.join(tmpdir(), "orbitos-intake-"));
  const file = path.join(root, "30_Research", "YouMind", "Board", "Materials", "sample.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---
source: youmind
date: "2026-05-15"
type: "material"
youmind_id: "ym_1"
board: "AI"
url: "https://example.com"
author: "Ada"
tags:
  - youmind
  - web-reading
---
# Agent Memory

This explains how an AI agent can learn user preferences.
`, "utf8");

  const record = inferRecord(file, root);
  const payload = baseRecordPayload(record);
  assert.equal(payload[FIELD.source], "YouMind");
  assert.equal(payload[FIELD.sourceId], "ym_1");
  assert.equal(payload[FIELD.type], "web-reading");
  assert.equal(payload[FIELD.liked], "unknown");
  assert.match(payload[FIELD.aiTags], /ai/);
  assert.equal(payload[FIELD.sourcePath], "30_Research/YouMind/Board/Materials/sample.md");
  assert.equal(payload[FIELD.obsidianPath], "");
  assert.equal(payload[FIELD.derivationVersion], DERIVATION_VERSION);
  assert.equal(payload[FIELD.weeklyEligible], true);
});

test("Readwise source identity stays stable when highlights change", () => {
  const root = mkdtempSync(path.join(tmpdir(), "orbitos-readwise-"));
  const file = path.join(root, "30_Research", "Readwise", "Tweets", "Tweets From Ada.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `# Tweets From Ada

## Highlights
- First useful idea.
`, "utf8");
  const first = inferRecord(file, root);

  writeFileSync(file, `# Tweets From Ada

## Highlights
- First useful idea.
- A newly synced highlight.
`, "utf8");
  const second = inferRecord(file, root);

  assert.equal(first.sourceKey, "Readwise:30_Research/Readwise/Tweets/Tweets From Ada.md");
  assert.equal(second.sourceKey, first.sourceKey);
  assert.notEqual(second.hash, first.hash);
});

test("sync update payload preserves user fields, import time, and promotion path", () => {
  const record = {
    title: "Updated",
    source: "YouMind",
    sourceId: "ym_1",
    sourceKey: "YouMind:ym_1",
    type: "article",
    status: "raw",
    liked: "unknown",
    promote: false,
    sourcePath: "30_Research/YouMind/sample.md",
    obsidianPath: "",
    importedAt: "2026-07-01 10:00:00",
    sourceTime: "2026-06-30 10:00:00",
    url: "",
    author: "",
    tags: "youmind",
    aiTags: "ai",
    project: "",
    topic: "",
    summary: "Useful first.",
    raw: "Useful first.",
    hash: "abc",
    lastSync: "2026-07-13 10:00:00",
    weeklyEligible: true,
    derivationVersion: DERIVATION_VERSION,
  };

  const update = baseRecordPayload(record, false);
  assert.equal(update[FIELD.sourcePath], record.sourcePath);
  assert.equal(update[FIELD.derivationVersion], DERIVATION_VERSION);
  assert.equal(update[FIELD.weeklyEligible], true);
  assert.equal(Object.hasOwn(update, FIELD.status), false);
  assert.equal(Object.hasOwn(update, FIELD.liked), false);
  assert.equal(Object.hasOwn(update, FIELD.promote), false);
  assert.equal(Object.hasOwn(update, FIELD.obsidianPath), false);
  assert.equal(Object.hasOwn(update, FIELD.importedAt), false);
});

test("legacy Readwise keys resolve to a stable source path and lifecycle", () => {
  const fields = {
    [FIELD.sourceKey]: "Readwise:30_Research/Readwise/Tweets/Tweets From Ada.md:0123456789abcdef01234567",
    [FIELD.status]: "raw",
    [FIELD.obsidianPath]: "",
  };
  const sourcePath = "30_Research/Readwise/Tweets/Tweets From Ada.md";
  assert.equal(sourcePathFromFields(fields), sourcePath);
  assert.equal(classifyRecordLifecycle(fields, new Set(), new Set([sourcePath])), "historical");
  assert.equal(classifyRecordLifecycle(fields, new Set(), new Set()), "removed");

  const current = { ...fields, [FIELD.sourceKey]: `Readwise:${sourcePath}` };
  assert.equal(classifyRecordLifecycle(current, new Set([`Readwise:${sourcePath}`]), new Set([sourcePath])), "current");
});

test("shouldPromote only promotes strong selection signals without an Obsidian path", () => {
  const cases = [
    [{ [FIELD.status]: "selected", [FIELD.obsidianPath]: "" }, true],
    [{ [FIELD.liked]: "strong_like", [FIELD.obsidianPath]: "" }, true],
    [{ [FIELD.promote]: true, [FIELD.obsidianPath]: "" }, true],
    [{ [FIELD.status]: "liked", [FIELD.obsidianPath]: "" }, false],
    [{ [FIELD.liked]: "like", [FIELD.obsidianPath]: "" }, false],
    [{ [FIELD.liked]: "neutral", [FIELD.obsidianPath]: "" }, false],
    [{ [FIELD.liked]: "noise", [FIELD.obsidianPath]: "" }, false],
    [{ [FIELD.status]: "selected", [FIELD.obsidianPath]: "00_Inbox/already.md" }, false],
  ];

  for (const [fields, expected] of cases) {
    assert.equal(shouldPromote(fields), expected, JSON.stringify(fields));
  }
});

test("weekly main view includes Readwise only until calibration ends", () => {
  const config = { calibrationUntil: "2026-05-31" };
  assert.equal(readwiseInMainView(config, "2026-05-31"), true);
  assert.equal(readwiseInMainView(config, "2026-06-01"), false);

  const during = viewDefinitions(config, "2026-05-31").find((view) => view.name === "00 每周只看");
  const after = viewDefinitions(config, "2026-07-13").find((view) => view.name === "00 每周只看");
  const current = viewDefinitions(config, "2026-07-13").find((view) => view.name === "00 当前可读");

  assert.deepEqual(current.aliases, ["Grid View"]);
  assert.deepEqual(current.filter.conditions, [
    [FIELD.status, "intersects", ["raw", "to_review"]],
    [FIELD.weeklyEligible, "==", true],
  ]);
  assert.deepEqual(current.visibleFields, [FIELD.title, FIELD.summary, FIELD.source, FIELD.sourceTime, FIELD.liked, FIELD.promote]);
  assert.deepEqual(during.filter.conditions[1], [FIELD.source, "intersects", ["YouMind", "Readwise"]]);
  assert.deepEqual(after.filter.conditions[1], [FIELD.source, "intersects", ["YouMind"]]);
  assert.deepEqual(after.filter.conditions[2], [FIELD.weeklyEligible, "==", true]);
  assert.deepEqual(after.filter.conditions[3], [FIELD.sourceTime, ">", "ExactDate(2026-07-06)"]);
  assert.deepEqual(after.visibleFields, [FIELD.title, FIELD.source, FIELD.summary, FIELD.liked, FIELD.promote]);
});

test("lark write conflicts are retried", () => {
  assert.equal(isTransientLarkError(new Error("1254291: Write conflict")), true);
});

test("buildPromotionMarkdown preserves source metadata and raw content", () => {
  const markdown = buildPromotionMarkdown({
    [FIELD.title]: "Good idea",
    [FIELD.source]: "Flomo",
    [FIELD.sourceKey]: "Flomo:1",
    [FIELD.status]: "selected",
    [FIELD.liked]: "strong_like",
    [FIELD.url]: "https://example.com",
    [FIELD.tags]: "flomo, pai",
    [FIELD.aiTags]: "ai",
    [FIELD.summary]: "This is worth iterating.",
    [FIELD.raw]: "Original thought body",
  });

  assert.match(markdown, /# Good idea/);
  assert.match(markdown, /source_key: "Flomo:1"/);
  assert.match(markdown, /Original thought body/);
});

test("buildPromotionMarkdown adds v2.1 rating and wikilink seeds without user work", () => {
  const markdown = buildPromotionMarkdown({
    [FIELD.title]: "Agent Memory",
    [FIELD.source]: "YouMind",
    [FIELD.sourceKey]: "YouMind:ym_1",
    [FIELD.status]: "selected",
    [FIELD.liked]: "strong_like",
    [FIELD.promote]: true,
    [FIELD.url]: "https://example.com",
    [FIELD.tags]: "youmind, web-reading, pai",
    [FIELD.aiTags]: "ai, writing",
    [FIELD.project]: "OrbitOS",
    [FIELD.topic]: "个人知识系统",
    [FIELD.summary]: "A durable note about agent memory.",
    [FIELD.raw]: "Original article body",
  });

  assert.match(markdown, /^rating: 7$/m);
  assert.match(markdown, /^source: "youmind"$/m);
  assert.match(markdown, /^source_key: "YouMind:ym_1"$/m);
  assert.match(markdown, /^url: "https:\/\/example\.com"$/m);
  assert.match(markdown, /^topics:\n  - "PAI"\n  - "AI"\n  - "Writing"$/m);
  assert.doesNotMatch(markdown, /^  - "个人知识系统"$/m);
  assert.match(markdown, /^projects:\n  - "OrbitOS"/m);
  assert.match(markdown, /^related:\n  - "OrbitOS"\n  - "PAI"\n  - "AI"/m);
  assert.match(markdown, /## Links/);
  assert.match(markdown, /- Topics: \[\[PAI\]\], \[\[AI\]\], \[\[Writing\]\]/);
  assert.match(markdown, /- Projects: \[\[OrbitOS\]\]/);
  assert.match(markdown, /- Related: \[\[OrbitOS\]\], \[\[PAI\]\], \[\[AI\]\]/);
});

test("sameCellValue treats ISO and local datetime as the same instant", () => {
  assert.equal(sameCellValue("2026-05-11T08:00:00.000+08:00", "2026-05-11 08:00:00"), true);
  assert.equal(sameCellValue({ text: "2026-05-11T08:00:00.000+08:00" }, "2026-05-11 08:00:00"), true);
  assert.equal(sameCellValue("2026-05-11T08:00:00.000+08:00", "2026-05-11 09:00:00"), false);
  assert.equal(sameCellValue("2026-05-11", "2026-05-11"), true);
  assert.equal(sameCellValue("2026-05-11", "2026-05-12"), false);
  assert.equal(sameCellValue("plain text", "plain text"), true);
  assert.equal(sameCellValue("plain text", "other text"), false);
});
