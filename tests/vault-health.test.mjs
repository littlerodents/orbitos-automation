import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { auditVault } from "../orbitos-vault-health.mjs";

function writeNote(root, rel, body) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
  return file;
}

test("auditVault reports a clean selected vault", () => {
  const root = mkdtempSync(path.join(tmpdir(), "orbitos-vault-health-clean-"));
  writeNote(root, "30_Research/Selected/Good.md", `---
type: selected-content
source: "youmind"
source_key: "ym:1"
topics:
  - "AI"
related:
  - "OrbitOS"
tags:
  - selected-content
---
# Good

## Links

- Related: [[OrbitOS]]
`);
  writeNote(root, "40_Wiki/OrbitOS.md", "# OrbitOS\n\nLinks back to [[Good]].\n");

  const result = auditVault({ vault: root });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test("auditVault detects duplicate basenames and broken wikilinks", () => {
  const root = mkdtempSync(path.join(tmpdir(), "orbitos-vault-health-links-"));
  writeNote(root, "30_Research/Selected/Dupe.md", "# Dupe\n\n[[Missing Note]]\n");
  writeNote(root, "40_Wiki/Dupe.md", "# Dupe\n");

  const result = auditVault({ vault: root });
  assert.equal(result.ok, false);
  assert.equal(result.counts.duplicateBasenames, 1);
  assert.equal(result.counts.brokenWikilinks, 1);
  assert.ok(result.findings.some((finding) => finding.type === "duplicate-basename"));
  assert.ok(result.findings.some((finding) => finding.type === "broken-wikilink"));
});

test("auditVault detects orphan selected notes and tag inflation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "orbitos-vault-health-selected-"));
  writeNote(root, "30_Research/Selected/Orphan.md", `---
type: selected-content
source: "readwise"
source_key: "rw:1"
topics:
  - "AI"
  - "Writing"
  - "Product"
  - "Career"
related: []
tags:
  - one
  - two
  - three
  - four
  - five
  - six
  - seven
  - eight
  - nine
---
# Orphan
`);

  const result = auditVault({ vault: root });
  assert.equal(result.ok, false);
  assert.equal(result.counts.orphanSelected, 1);
  assert.equal(result.counts.tagInflation, 2);
  assert.ok(result.findings.some((finding) => finding.type === "orphan-selected"));
  assert.ok(result.findings.some((finding) => finding.type === "topic-inflation"));
  assert.ok(result.findings.some((finding) => finding.type === "tag-inflation"));
});
