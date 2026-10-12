import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyActions,
  planBackfill,
  planMaterialsSweep,
  planSelectedSweep,
} from "../orbitos-archive-sweeper.mjs";

const DAY_MS = 86400000;

function tmpRoot(tag) {
  return mkdtempSync(path.join(tmpdir(), `archive-sweeper-${tag}-`));
}

function writeMaterial(root, name, fields) {
  const dir = path.join(root, "Materials");
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(fields).map(([k, v]) => `${k}: "${v}"`).join("\n");
  writeFileSync(path.join(dir, name), `---\n${fm}\n---\n# body\n`, "utf8");
}

test("planMaterialsSweep: only processed-old files are eligible; fresh/unmarked are not", () => {
  const root = tmpRoot("materials");
  const archiveRoot = path.join(root, "Archives");
  const now = Date.parse("2026-10-12T04:00:00.000Z"); // 2026-10-12 12:00 CST

  writeMaterial(root, "2026-03-02 old.md", { date: "2026-03-02", youmind_id: "id-old", processed: "2026-08-20" });
  writeMaterial(root, "2026-03-05 fresh.md", { date: "2026-03-05", youmind_id: "id-fresh", processed: "2026-10-10" });
  writeMaterial(root, "2026-03-09 unmarked.md", { date: "2026-03-09", youmind_id: "id-unmarked" });

  const plan = planMaterialsSweep({
    materialsDir: path.join(root, "Materials"),
    archiveRoot,
    days: 30,
    nowMs: now,
  });

  assert.equal(plan.files, 3);
  assert.equal(plan.actions.length, 1, "only the 2026-08-20 processed file is old enough");
  assert.equal(plan.notReady.length, 1);
  assert.equal(plan.missingMark.length, 1);
  assert.equal(plan.actions[0].to, path.join(archiveRoot, "X书签简报", "2026/03", "2026-03-02 old.md"));
});

test("applyActions: real move lands in archive and re-plan is idempotent", () => {
  const root = tmpRoot("move");
  const archiveRoot = path.join(root, "Archives");
  const now = Date.parse("2026-10-12T04:00:00.000Z");
  writeMaterial(root, "2026-03-02 old.md", { date: "2026-03-02", youmind_id: "id-old", processed: "2026-08-20" });

  const opts = { materialsDir: path.join(root, "Materials"), archiveRoot, days: 30, nowMs: now };
  const plan = planMaterialsSweep(opts);
  const result = applyActions(plan.actions, { dryRun: false, git: false });

  assert.equal(result.moved.length, 1);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.missing.length, 0);
  assert.ok(existsSync(plan.actions[0].to), "file exists in archive");
  assert.equal(existsSync(plan.actions[0].from), false, "source file moved away");

  const again = planMaterialsSweep(opts);
  assert.equal(again.actions.length, 0, "second run has nothing to move");
  assert.equal(again.files, 0, "archived file no longer scanned in active dir");
});

test("applyActions: destination collision is skipped, never overwritten", () => {
  const root = tmpRoot("conflict");
  const archiveRoot = path.join(root, "Archives");
  const now = Date.parse("2026-10-12T04:00:00.000Z");
  writeMaterial(root, "2026-03-02 old.md", { date: "2026-03-02", youmind_id: "id-old", processed: "2026-08-20" });

  const plan = planMaterialsSweep({ materialsDir: path.join(root, "Materials"), archiveRoot, days: 30, nowMs: now });
  const dest = plan.actions[0].to;
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, "KEEP", "utf8");

  const result = applyActions(plan.actions, { dryRun: false, git: false });
  assert.equal(result.moved.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(readFileSync(dest, "utf8"), "KEEP", "existing archive content untouched");
  assert.ok(existsSync(plan.actions[0].from), "source file not lost on conflict");
});

test("applyActions: dry-run changes nothing on disk", () => {
  const root = tmpRoot("dry");
  const archiveRoot = path.join(root, "Archives");
  const now = Date.parse("2026-10-12T04:00:00.000Z");
  writeMaterial(root, "2026-03-02 old.md", { date: "2026-03-02", youmind_id: "id-old", processed: "2026-08-20" });

  const plan = planMaterialsSweep({ materialsDir: path.join(root, "Materials"), archiveRoot, days: 30, nowMs: now });
  const result = applyActions(plan.actions, { dryRun: true, git: false });

  assert.equal(result.moved.length, 1);
  assert.ok(existsSync(plan.actions[0].from), "source still present");
  assert.equal(existsSync(plan.actions[0].to), false, "archive not created in dry-run");
});

test("planSelectedSweep: keeps newest K batches, archives the rest by year", () => {
  const root = tmpRoot("selected");
  const selectedDir = path.join(root, "Selected");
  const archiveRoot = path.join(root, "Archives");
  mkdirSync(selectedDir, { recursive: true });
  for (let i = 1; i <= 15; i += 1) {
    const day = String(i).padStart(2, "0");
    writeFileSync(path.join(selectedDir, `bookmarks-2026-01-${day}.md`), "note", "utf8");
  }

  const plan = planSelectedSweep({ selectedDir, archiveRoot, keep: 12 });
  assert.equal(plan.files, 15);
  assert.equal(plan.actions.length, 3, "3 oldest batches move out");
  assert.equal(plan.kept.length, 12);
  assert.equal(path.basename(plan.actions[0].from), "bookmarks-2026-01-01.md");
  assert.equal(plan.actions[0].to, path.join(archiveRoot, "Selected", "2026", "bookmarks-2026-01-01.md"));

  const result = applyActions(plan.actions, { dryRun: false, git: false });
  assert.equal(result.moved.length, 3);
  assert.equal(readdirSync(selectedDir).length, 12, "12 newest batches stay active");
});

test("planBackfill: only state-known unmarked materials get a conservative processed mark", () => {
  const root = tmpRoot("backfill");
  const materialsDir = path.join(root, "Materials");
  const stateFile = path.join(root, "state.json");
  writeMaterial(root, "2026-03-02 known.md", { date: "2026-03-02", youmind_id: "id-known" });
  writeMaterial(root, "2026-03-05 already-marked.md", { date: "2026-03-05", youmind_id: "id-marked", processed: "2026-09-18" });
  writeMaterial(root, "2026-03-06 unknown.md", { date: "2026-03-06", youmind_id: "id-unknown" });
  writeFileSync(stateFile, JSON.stringify({ processed: ["id-known"] }), "utf8");
  const mtime = new Date("2026-10-02T12:00:00.000Z"); // 2026-10-02 20:00 CST
  utimesSync(stateFile, mtime, mtime);

  const { updates } = planBackfill({ materialsDir, stateFile });
  assert.equal(updates.length, 1, "only known + unmarked is a candidate");
  assert.equal(path.basename(updates[0].path), "2026-03-02 known.md");
  assert.equal(updates[0].date, "2026-10-02");
});
