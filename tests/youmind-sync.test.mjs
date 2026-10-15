import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMarkdown,
  fetchItemsForBoard,
  isTransientYouMindError,
  numberArg,
  preserveLocalFrontmatter,
  selectBoardFiles,
  shouldReplaceCapture,
} from "../youmind-sync.mjs";

test("lookback defaults to 14 days while explicit zero remains valid", () => {
  assert.equal(numberArg("--lookback-days", 14, []), 14);
  assert.equal(numberArg("--lookback-days", 14, ["--lookback-days", "0"]), 0);
  assert.equal(numberArg("--lookback-days", 14, ["--lookback-days=7"]), 7);
});

test("YouMind retries only transient transport and service failures", () => {
  assert.equal(isTransientYouMindError(new TypeError("fetch failed")), true);
  assert.equal(isTransientYouMindError(Object.assign(new Error("rate limited"), { status: 429 })), true);
  assert.equal(isTransientYouMindError(Object.assign(new Error("server"), { status: 503 })), true);
  assert.equal(isTransientYouMindError(Object.assign(new Error("unauthorized"), { status: 401 })), false);
});

test("YouMind listFiles keeps existing files plus recent additions and skips groups", () => {
  const cutoff = Date.parse("2026-07-01T00:00:00Z");
  const files = [
    { id: "group", type: "group", created_at: "2026-07-10T00:00:00Z" },
    { id: "existing-old", type: "article", created_at: "2026-01-01T00:00:00Z" },
    { id: "recent", type: "video", updated_at: "2026-07-02T00:00:00Z" },
    { id: "old-unseen", type: "article", updated_at: "2026-01-02T00:00:00Z" },
    { id: "recent-doc", type: "document", createdAt: "2026-07-03T00:00:00Z" },
  ];

  const selected = selectBoardFiles(files, new Set(["existing-old"]), cutoff);
  assert.deepEqual(selected.materials.map((item) => item.id), ["existing-old", "recent"]);
  assert.deepEqual(selected.crafts.map((item) => item.id), ["recent-doc"]);
  assert.equal(selected.groups, 1);
  assert.equal(selected.discovered, 5);
  assert.equal(selected.selected, 3);
});

test("buildMarkdown accepts the current listFiles response shape", () => {
  const markdown = buildMarkdown({
    board: { id: "board-1", name: "AI" },
    kind: "material",
    item: {
      id: "file-1",
      type: "article",
      title: "Agent Memory",
      created_at: "2026-07-02T03:00:00Z",
      updated_at: "2026-07-02T04:00:00Z",
      publishedAt: "2026-07-01T00:00:00Z",
      content: "The useful conclusion is first.",
      webpage: { url: "https://example.com", description: "Short description." },
      authors: [{ name: "Ada" }],
    },
  });

  assert.match(markdown, /^date: "2026-07-02"$/m);
  assert.match(markdown, /^created: "2026-07-02T03:00:00Z"$/m);
  assert.match(markdown, /^updated: "2026-07-02T04:00:00Z"$/m);
  assert.match(markdown, /^author: "Ada"$/m);
  assert.match(markdown, /## Content\n\nThe useful conclusion is first\./);
  assert.doesNotMatch(markdown, /No text content returned/);
});

test("a listFiles failure is not converted into a successful empty board", async () => {
  await assert.rejects(
    fetchItemsForBoard(
      { id: "board-1", name: "AI" },
      {
        postFn: async () => { throw new Error("listFiles failed (404)"); },
        existingIds: new Set(),
        cutoff: 0,
      },
    ),
    /listFiles failed \(404\)/,
  );
});

test("existing rich captures are never replaced by truncated API content", () => {
  const rich = `# Example

## Content

Full article body with several paragraphs and important details.
Second paragraph with more evidence and context.
`;
  const truncated = `# Example

## Content

Full article body with several paragraphs...
`;
  const richer = `${rich}\nThird paragraph newly available from the API.\n`;

  assert.equal(shouldReplaceCapture(rich, truncated), false);
  assert.equal(shouldReplaceCapture(rich, richer), true);
  assert.equal(shouldReplaceCapture(rich, rich), false);
});

test("replacement keeps local-only frontmatter annotations (processed marks survive sync)", () => {
  const existing = `---
source: youmind
youmind_id: "abc"
processed: "2026-10-02"
processed_into: "[[bookmarks-2026-09-29]]"
---
# Title
## Content
Body text
`;
  const candidate = `---
source: youmind
youmind_id: "abc"
---
# Title
## Content
Body text with an update from the API.
`;

  const merged = preserveLocalFrontmatter(existing, candidate);
  assert.match(merged, /^processed: "2026-10-02"$/m);
  assert.match(merged, /^processed_into: "\[\[bookmarks-2026-09-29\]\]"$/m);
  assert.match(merged, /Body text with an update from the API\./);
  assert.equal(preserveLocalFrontmatter(merged, candidate), merged, "merge is idempotent");

  // 远端新增字段不会被丢掉
  const candidateExtra = candidate.replace('youmind_id: "abc"', 'youmind_id: "abc"\nupdated: "2026-10-15T00:00:00Z"');
  const mergedExtra = preserveLocalFrontmatter(existing, candidateExtra);
  assert.match(mergedExtra, /^updated: "2026-10-15T00:00:00Z"$/m);
  assert.match(mergedExtra, /^processed: "2026-10-02"$/m);
});
