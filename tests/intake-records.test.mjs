import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FIELD,
  baseRecordPayload,
  buildPromotionMarkdown,
  inferRecord,
  readwiseInMainView,
  parseFrontmatter,
  shouldPromote,
  viewDefinitions,
} from "../orbitos-intake-base.mjs";

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
  const after = viewDefinitions(config, "2026-06-01").find((view) => view.name === "00 每周只看");

  assert.deepEqual(during.filter.conditions[1], [FIELD.source, "intersects", ["YouMind", "Readwise"]]);
  assert.deepEqual(after.filter.conditions[1], [FIELD.source, "intersects", ["YouMind"]]);
  assert.deepEqual(after.visibleFields, [FIELD.title, FIELD.source, FIELD.summary, FIELD.liked, FIELD.promote]);
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
