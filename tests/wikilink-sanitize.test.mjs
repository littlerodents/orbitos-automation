import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeWikilinks } from "../orbitos-daily-brief.mjs";

const IDX = new Set(["opc-launch", "40_Wiki/VLA", "brief-2026-10-30", "AI"]);

test("existing wikilinks are left untouched", () => {
  const r = sanitizeWikilinks("看 [[opc-launch]] 和 [[AI]]", IDX);
  assert.equal(r.text, "看 [[opc-launch]] 和 [[AI]]");
  assert.equal(r.dropped, 0);
});

test("missing target degrades to plain text", () => {
  const r = sanitizeWikilinks("见 [[不存在的笔记]]", IDX);
  assert.equal(r.text, "见 不存在的笔记");
  assert.equal(r.dropped, 1);
});

test("missing target with alias keeps the alias", () => {
  const r = sanitizeWikilinks("见 [[nope|显示名]]", IDX);
  assert.equal(r.text, "见 显示名");
  assert.equal(r.dropped, 1);
});

test("heading anchors resolve against the file part", () => {
  assert.equal(sanitizeWikilinks("[[opc-launch#Section]]", IDX).text, "[[opc-launch#Section]]");
  assert.equal(sanitizeWikilinks("[[missing#Section]]", IDX).text, "missing");
});

test("relative-path links are accepted", () => {
  assert.equal(sanitizeWikilinks("[[40_Wiki/VLA]]", IDX).text, "[[40_Wiki/VLA]]");
});

test("multiple links: only the broken ones change, count is accurate", () => {
  const src = "[[opc-launch]] 好，[[opc-launchx]] 坏，[[AI|智能]] 好，[[Work]] 坏";
  const r = sanitizeWikilinks(src, IDX);
  assert.match(r.text, /\[\[opc-launch\]\]/);
  assert.match(r.text, /opc-launchx/);
  assert.doesNotMatch(r.text, /\[\[opc-launchx\]\]/);
  assert.match(r.text, /\[\[AI\|智能\]\]/);
  assert.doesNotMatch(r.text, /\[\[Work\]\]/);
  assert.equal(r.dropped, 2);
});

test("text without links is returned unchanged", () => {
  const r = sanitizeWikilinks("纯文本，没有链接", IDX);
  assert.equal(r.text, "纯文本，没有链接");
  assert.equal(r.dropped, 0);
});
