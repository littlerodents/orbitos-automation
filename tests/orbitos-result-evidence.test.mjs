import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activityMinutesProxy,
  dedupeCalendarEvents,
  normalizeMinutesDetails,
  parseClaudeJsonl,
  parseCodexJsonl,
  redactEvidenceText,
  writeEvidencePacketAtomic,
} from "../orbitos-result-evidence.mjs";

const window = {
  startMs: Date.parse("2026-07-29T00:00:00+08:00"),
  endMs: Date.parse("2026-07-30T00:00:00+08:00"),
};

test("Codex parser keeps parent intent and final outcome while excluding tools and secrets", () => {
  const jsonl = [
    { timestamp: "2026-07-28T16:01:00.000Z", type: "session_meta", payload: { id: "s1", cwd: "/work/pai", source: "app" } },
    { timestamp: "2026-07-28T16:02:00.000Z", type: "event_msg", payload: { type: "user_message", message: "Ship PAI; key sk-1234567890abcdef" } },
    { timestamp: "2026-07-28T16:03:00.000Z", type: "response_item", payload: { type: "custom_tool_call_output", output: "must not leak" } },
    { timestamp: "2026-07-28T16:20:00.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "Tests passed; release remains blocked." } },
  ].map(JSON.stringify).join("\n");

  const parsed = parseCodexJsonl(jsonl, window);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].project, "pai");
  assert.match(parsed[0].intent, /Ship PAI/);
  assert.match(parsed[0].intent, /sk-\[REDACTED\]/);
  assert.equal(parsed[0].outcome, "Tests passed; release remains blocked.");
  assert.doesNotMatch(JSON.stringify(parsed), /must not leak|1234567890abcdef/);
});

test("Codex parser excludes subagent transcripts to prevent duplicate evidence", () => {
  const jsonl = [
    { timestamp: "2026-07-28T16:01:00.000Z", type: "session_meta", payload: { id: "sub", cwd: "/work/pai", source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } } },
    { timestamp: "2026-07-28T16:02:00.000Z", type: "event_msg", payload: { type: "agent_message", message: "duplicated subagent analysis" } },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(parseCodexJsonl(jsonl, window), []);
});

test("Codex parser excludes heartbeat automation sessions to prevent recursive reports", () => {
  const jsonl = [
    { timestamp: "2026-07-28T16:01:00.000Z", type: "session_meta", payload: { id: "heartbeat", cwd: "/work/orbitos", source: "automation" } },
    { timestamp: "2026-07-28T16:02:00.000Z", type: "event_msg", payload: { type: "user_message", message: "<heartbeat><automation_id>daily</automation_id><instructions>write a report</instructions></heartbeat>" } },
    { timestamp: "2026-07-28T16:20:00.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "generated recursive report" } },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(parseCodexJsonl(jsonl, window), []);
});

test("Claude parser keeps minimal user intent and final assistant text", () => {
  const jsonl = [
    { timestamp: "2026-07-28T17:00:00.000Z", type: "user", entrypoint: "cli", promptSource: "typed", origin: { kind: "human" }, sessionId: "c1", cwd: "/work/big", message: { role: "user", content: "Review BIG release" } },
    { timestamp: "2026-07-28T17:10:00.000Z", type: "assistant", sessionId: "c1", cwd: "/work/big", message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }, { type: "text", text: "Found one P0; no files changed." }] } },
  ].map(JSON.stringify).join("\n");
  const parsed = parseClaudeJsonl(jsonl, window);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].project, "big");
  assert.equal(parsed[0].intent, "Review BIG release");
  assert.equal(parsed[0].outcome, "Found one P0; no files changed.");
});

test("Claude parser excludes sdk-generated auxiliary sessions", () => {
  const jsonl = [
    { timestamp: "2026-07-28T17:00:00.000Z", type: "user", entrypoint: "sdk-cli", promptSource: "sdk", sessionId: "title", cwd: "/work/big", message: { role: "user", content: "Rename this chat" } },
    { timestamp: "2026-07-28T17:00:01.000Z", type: "assistant", entrypoint: "sdk-cli", promptSource: "sdk", sessionId: "title", cwd: "/work/big", message: { role: "assistant", content: "BIG Release Review" } },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(parseClaudeJsonl(jsonl, window), []);
});

test("Claude parser excludes background task notifications from owner intent", () => {
  const jsonl = [
    {
      timestamp: "2026-07-28T17:00:00.000Z",
      type: "user",
      entrypoint: "cli",
      promptSource: "typed",
      origin: { kind: "human" },
      sessionId: "task-notification",
      cwd: "/work/pdf",
      message: {
        role: "user",
        content: "<task-notification><task-id>task-123</task-id><status>completed</status><summary>Background command completed</summary></task-notification>",
      },
    },
    {
      timestamp: "2026-07-28T17:00:01.000Z",
      type: "assistant",
      sessionId: "task-notification",
      cwd: "/work/pdf",
      message: { role: "assistant", content: "Acknowledged background completion." },
    },
  ].map(JSON.stringify).join("\n");

  assert.deepEqual(parseClaudeJsonl(jsonl, window), []);
});

test("Claude parser prefers real owner intent over an earlier task notification", () => {
  const jsonl = [
    {
      timestamp: "2026-07-28T17:00:00.000Z",
      type: "user",
      entrypoint: "cli",
      promptSource: "typed",
      origin: { kind: "human" },
      sessionId: "mixed-session",
      cwd: "/work/pdf",
      message: { role: "user", content: "<task-notification><task-id>task-123</task-id><status>completed</status></task-notification>" },
    },
    {
      timestamp: "2026-07-28T17:01:00.000Z",
      type: "user",
      entrypoint: "cli",
      promptSource: "typed",
      origin: { kind: "human" },
      sessionId: "mixed-session",
      cwd: "/work/pdf",
      message: { role: "user", content: "Verify the translated PDF output" },
    },
    {
      timestamp: "2026-07-28T17:02:00.000Z",
      type: "assistant",
      sessionId: "mixed-session",
      cwd: "/work/pdf",
      message: { role: "assistant", content: "The PDF output passed visual verification." },
    },
  ].map(JSON.stringify).join("\n");

  const parsed = parseClaudeJsonl(jsonl, window);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].intent, "Verify the translated PDF output");
});

test("calendar evidence deduplicates mirrored events and strips identifiers", () => {
  const events = dedupeCalendarEvents([
    { summary: "Partner meeting", start_time: { datetime: "2026-07-29T15:00:00+08:00" }, end_time: { datetime: "2026-07-29T15:30:00+08:00" }, event_id: "secret-a" },
    { summary: "Partner meeting", start_time: { datetime: "2026-07-29T15:00:00+08:00" }, end_time: { datetime: "2026-07-29T15:30:00+08:00" }, event_id: "secret-b" },
  ]);
  assert.deepEqual(events, [{ summary: "Partner meeting", start: "2026-07-29T15:00:00+08:00", end: "2026-07-29T15:30:00+08:00", status: "unknown" }]);
});

test("minutes normalization keeps decisions and todos but strips tokens and ids", () => {
  const normalized = normalizeMinutesDetails({
    data: {
      minutes: [{
        minute_token: "obcn-secret",
        note_id: "123",
        title: "Partner meeting",
        artifacts: {
          summary: "Agreed to produce a resource and rights list.",
          todos: [{ todo_id: "todo-secret", content: "Prepare list @Owner", is_done: false }],
          chapters: [{ title: "Resource decision", summary_content: "Compute support needs explicit return benefits." }],
          keywords: ["compute", "rights"],
        },
      }],
    },
  });
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].title, "Partner meeting");
  assert.equal(normalized[0].todos[0].content, "Prepare list @Owner");
  assert.doesNotMatch(JSON.stringify(normalized), /obcn-secret|todo-secret|note_id/);
});

test("activity proxy caps long gaps and is explicitly an estimate", () => {
  const proxy = activityMinutesProxy([
    Date.parse("2026-07-29T09:00:00+08:00"),
    Date.parse("2026-07-29T09:10:00+08:00"),
    Date.parse("2026-07-29T12:00:00+08:00"),
  ]);
  assert.deepEqual(proxy, { active_minutes_proxy: 45, method: "5 minute floor plus inter-event gaps capped at 30 minutes" });
});

test("redaction and atomic packet write do not retain credentials", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "orbitos-evidence-write-"));
  try {
    const clean = redactEvidenceText("Bearer tokenvalue sk-1234567890abcdef ou_1234567890abcdef");
    assert.equal(clean, "Bearer [REDACTED] sk-[REDACTED] [FEISHU_ID_REDACTED]");
    const target = path.join(dir, "primary-2026-07-29.json");
    writeEvidencePacketAtomic(target, { fact: clean });
    const saved = readFileSync(target, "utf8");
    assert.match(saved, /REDACTED/);
    assert.doesNotMatch(saved, /tokenvalue|1234567890abcdef/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
