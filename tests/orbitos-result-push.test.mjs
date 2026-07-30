import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveArtifactMeta,
  parseBriefCommitLine,
  processCandidate,
  resetRunners,
  sendBrief,
  setCurlRunner,
  setLarkRunner,
  validateArtifactContent,
} from "../orbitos-brief-push.mjs";

function validResultBody() {
  return `---
type: result-daily
---
# 超级个体结果日报 — 2026-07-29

## 1. 证据与最新事实
${"有来源的事实。".repeat(30)}

## 2. 今天结束时必须留下的结果
1. 决策单 — 可签字 — 18:00 — Evander

## 3. 取舍与 24 小时时间账本
原始两小时，按两倍量预留四小时；暂停低价值维护。

## 4. 思维模型强提醒
以终为始：需要签字结果，不需要更多中间材料。

## 5. 其余相关模型
安全边际用于决定是否放行。

## 6. 能力与 Agent Team
练习写一页决策单，Agent 只归并证据。

## 7. 最小确认
第一结果是否确认？`;
}

function tmpState() {
  const dir = mkdtempSync(path.join(tmpdir(), "orbitos-result-push-"));
  return {
    stateFile: path.join(dir, "state.json"),
    failedFile: path.join(dir, "failed.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("result commit subjects map to deterministic Obsidian artifact paths", () => {
  assert.deepEqual(parseBriefCommitLine("d1\0chore: result daily 2026-07-29"), {
    sha: "d1",
    kind: "result daily",
    msg: "chore: result daily 2026-07-29",
    artifactPath: "10_Daily/result-daily-2026-07-29.md",
  });
  assert.deepEqual(parseBriefCommitLine("w1\0chore: result weekly W5 2026-02-01"), {
    sha: "w1",
    kind: "result weekly",
    msg: "chore: result weekly W5 2026-02-01",
    artifactPath: "10_Daily/result-weekly-W05-2026-02-01.md",
  });
  assert.deepEqual(deriveArtifactMeta("result daily", "10_Daily/result-daily-2026-07-29.md"), {
    kind: "result daily",
    period: "2026-07-29",
    path: "10_Daily/result-daily-2026-07-29.md",
  });
  assert.deepEqual(deriveArtifactMeta("result weekly", "10_Daily/result-weekly-W31-2026-07-29.md"), {
    kind: "result weekly",
    period: "W31-2026-07-29",
    path: "10_Daily/result-weekly-W31-2026-07-29.md",
  });
});

test("result push semantic gate rejects legacy knowledge headings", () => {
  assert.equal(validateArtifactContent(validResultBody(), "result daily").ok, true);
  assert.match(
    validateArtifactContent(`${validResultBody()}\n\n## CONNECTIONS\nlegacy`, "result daily").error,
    /legacy knowledge heading/,
  );
  assert.match(
    validateArtifactContent(validResultBody().replace("## 7. 最小确认", "## Confirm"), "result daily").error,
    /missing required section/,
  );
  assert.match(
    validateArtifactContent(validResultBody().replace("决策单 — 可签字", "发送结果日报 — 已送达"), "result daily").error,
    /self-referential report outcome/,
  );
});

test("Feishu delivery uses healthy bot identity", () => {
  let captured = null;
  setLarkRunner((argv) => {
    captured = argv;
    return { status: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
  });
  try {
    assert.equal(sendBrief("hello", 1, 0).ok, true);
    assert.deepEqual(captured.slice(0, 4), ["im", "+messages-send", "--as", "bot"]);
    assert.ok(captured.includes("--user-id"));
  } finally {
    resetRunners();
  }
});

test("result daily sends the Chinese product title and records exactly once", () => {
  const state = tmpState();
  let markdown = "";
  setCurlRunner(() => ({ content: Buffer.from(validResultBody(), "utf8").toString("base64") }));
  setLarkRunner((argv) => {
    markdown = argv[argv.indexOf("--markdown") + 1];
    return { status: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
  });
  try {
    const result = processCandidate(
      { kind: "result daily", sha: "sha-result", artifactPath: "10_Daily/result-daily-2026-07-29.md" },
      { dryRun: false, force: false, pushed: {}, stateFile: state.stateFile, failedFile: state.failedFile, sendAttempts: 1, sendWaitMs: 0 },
    );
    assert.equal(result.pushed, true);
    assert.match(markdown, /^## 超级个体结果日报 — 2026-07-29/);
    assert.equal(JSON.parse(readFileSync(state.stateFile, "utf8"))["sha-result"], "result daily");
  } finally {
    resetRunners();
    state.cleanup();
  }
});
