import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ghWithRetry,
  sendBrief,
  appendFailed,
  markPushed,
  loadPushed,
  parseArgs,
  fetchBriefContent,
  processCandidate,
  setGhRunner,
  setLarkRunner,
  setRetryWait,
  resetRunners,
  runPipeline,
  sleepSync,
  GH_MAX_ATTEMPTS,
  SEND_MAX_ATTEMPTS,
} from "../orbitos-brief-push.mjs";

// ---- seeded PRNG (mulberry32) for deterministic variable-parameter fuzz ----
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

function tmpStateDir() {
  const d = mkdtempSync(path.join(tmpdir(), "brief-push-test-"));
  return {
    stateFile: path.join(d, "pushed-commits.json"),
    failedFile: path.join(d, "failed-commits.json"),
    cleanup: () => rmSync(d, { recursive: true, force: true }),
  };
}

// mock gh runner: calls a per-call handler with the attempt index.
// handler returns string (success) or throws (failure).
function makeGhMock(handler) {
  let attempts = 0;
  const fn = (argv) => {
    attempts++;
    return handler(argv, attempts);
  };
  fn.attempts = () => attempts;
  return fn;
}
// mock lark runner: handler returns { status, stdout, stderr }.
function makeLarkMock(handler) {
  let attempts = 0;
  const fn = (argv) => {
    attempts++;
    return handler(argv, attempts);
  };
  fn.attempts = () => attempts;
  return fn;
}

const okJson = (extra = "") => JSON.stringify({ ok: true, data: { chat_id: "oc_x", message_id: "om_y", ...({}) } }) + extra;
const failJson = (extra = "") => JSON.stringify({ ok: false, error: { message: extra || "boom" } });

// ============================ targeted edge tests ============================

test("parseArgs parses --dry-run and --force in any combination", () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, force: false });
  assert.deepEqual(parseArgs(["--dry-run"]), { dryRun: true, force: false });
  assert.deepEqual(parseArgs(["--force"]), { dryRun: false, force: true });
  assert.deepEqual(parseArgs(["--dry-run", "--force", "extra"]), { dryRun: true, force: true });
});

test("ghWithRetry succeeds on first attempt (no retry)", () => {
  const gh = makeGhMock(() => "ok");
  setGhRunner(gh);
  assert.equal(ghWithRetry("api", "x"), "ok");
  assert.equal(gh.attempts(), 1);
  resetRunners();
});

test("ghWithRetry retries up to GH_MAX_ATTEMPTS then throws", () => {
  setRetryWait(1);
  const gh = makeGhMock(() => { throw new Error("tls timeout"); });
  setGhRunner(gh);
  assert.throws(() => ghWithRetry("api", "x"), /tls timeout/);
  assert.equal(gh.attempts(), GH_MAX_ATTEMPTS);
  resetRunners();
});

test("ghWithRetry succeeds after transient failures (attempt 2 or 3)", () => {
  setRetryWait(1);
  for (const succeedAt of [2, 3]) {
    const gh = makeGhMock((_a, n) => (n >= succeedAt ? "recovered" : (() => { throw new Error("temp"); })()));
    setGhRunner(gh);
    assert.equal(ghWithRetry("api", "x"), "recovered");
    assert.equal(gh.attempts(), succeedAt);
  }
  resetRunners();
});

test("sendBrief returns ok:true only when lark returns exit0 + ok:true", () => {
  const lark = makeLarkMock(() => ({ status: 0, stdout: okJson(), stderr: "" }));
  setLarkRunner(lark);
  const r = sendBrief("md", SEND_MAX_ATTEMPTS, 1);
  assert.equal(r.ok, true);
  assert.equal(lark.attempts(), 1);
  resetRunners();
});

test("sendBrief retries on ok:false up to SEND_MAX_ATTEMPTS then returns ok:false", () => {
  const lark = makeLarkMock(() => ({ status: 0, stdout: failJson("nope"), stderr: "" }));
  setLarkRunner(lark);
  const r = sendBrief("md", SEND_MAX_ATTEMPTS, 1);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("ok=false"));
  assert.equal(lark.attempts(), SEND_MAX_ATTEMPTS);
  resetRunners();
});

test("sendBrief retries on non-zero exit", () => {
  const lark = makeLarkMock(() => ({ status: 1, stdout: "", stderr: "boom" }));
  setLarkRunner(lark);
  const r = sendBrief("md", SEND_MAX_ATTEMPTS, 1);
  assert.equal(r.ok, false);
  assert.equal(lark.attempts(), SEND_MAX_ATTEMPTS);
  resetRunners();
});

test("sendBrief retries on non-JSON stdout", () => {
  const lark = makeLarkMock(() => ({ status: 0, stdout: "not json at all", stderr: "" }));
  setLarkRunner(lark);
  const r = sendBrief("md", SEND_MAX_ATTEMPTS, 1);
  assert.equal(r.ok, false);
  assert.equal(lark.attempts(), SEND_MAX_ATTEMPTS);
  resetRunners();
});

test("sendBrief recovers when ok:false then ok:true", () => {
  const lark = makeLarkMock((_a, n) => (n >= 2 ? { status: 0, stdout: okJson(), stderr: "" } : { status: 0, stdout: failJson(), stderr: "" }));
  setLarkRunner(lark);
  const r = sendBrief("md", SEND_MAX_ATTEMPTS, 1);
  assert.equal(r.ok, true);
  assert.equal(lark.attempts(), 2);
  resetRunners();
});

test("markPushed/loadPushed round-trip", () => {
  const { stateFile, cleanup } = tmpStateDir();
  markPushed("sha1", "daily brief", stateFile);
  markPushed("sha2", "weekly synthesis", stateFile);
  const m = loadPushed(stateFile);
  assert.equal(m.sha1, "daily brief");
  assert.equal(m.sha2, "weekly synthesis");
  cleanup();
});

test("appendFailed creates array with all 4 fields and valid ISO", () => {
  const { failedFile, cleanup } = tmpStateDir();
  appendFailed("sha1", "daily brief", "boom", failedFile);
  const arr = JSON.parse(readFileSync(failedFile, "utf8"));
  assert.equal(arr.length, 1);
  const e = arr[0];
  assert.equal(e.sha, "sha1");
  assert.equal(e.kind, "daily brief");
  assert.equal(e.error, "boom");
  assert.ok(!isNaN(Date.parse(e.failed_at)), "failed_at is valid ISO");
  cleanup();
});

test("appendFailed appends to existing and survives corrupted file", () => {
  const { failedFile, cleanup } = tmpStateDir();
  appendFailed("sha1", "daily brief", "e1", failedFile);
  writeFileSync(failedFile, "{not valid json", "utf8"); // corrupt it
  appendFailed("sha2", "weekly synthesis", "e2", failedFile);
  const arr = JSON.parse(readFileSync(failedFile, "utf8"));
  assert.equal(arr.length, 1); // corrupted reset to [], then 1 appended
  assert.equal(arr[0].sha, "sha2");
  cleanup();
});

test("fetchBriefContent: daily brief success returns decoded content", () => {
  const body = "# Brief\n\nhello world";
  const b64 = Buffer.from(body, "utf8").toString("base64");
  setGhRunner(makeGhMock(() => b64));
  const { content, inferredPath } = fetchBriefContent({ kind: "daily brief", sha: "s1", date: "2026-06-30T00:00:00Z" });
  assert.equal(content, body);
  assert.equal(inferredPath, "00_Inbox/brief-2026-06-30.md");
  resetRunners();
});

test("fetchBriefContent: daily brief gh failure returns null content (no throw)", () => {
  setGhRunner(makeGhMock(() => { throw new Error("404"); }));
  const { content } = fetchBriefContent({ kind: "daily brief", sha: "s1", date: "2026-06-30T00:00:00Z" });
  assert.equal(content, null);
  resetRunners();
});

test("fetchBriefContent: weekly synthesis finds weekly file via tree", () => {
  const body = "# Weekly\n\nsynthesis";
  const b64 = Buffer.from(body, "utf8").toString("base64");
  let call = 0;
  setGhRunner(makeGhMock(() => {
    call++;
    return call === 1 ? "10_Daily/weekly-W26-2026-06-28.md" : b64;
  }));
  const { content, inferredPath } = fetchBriefContent({ kind: "weekly synthesis", sha: "s1", date: "2026-06-28T00:00:00Z" });
  assert.equal(content, body);
  assert.equal(inferredPath, "10_Daily/weekly-W26-2026-06-28.md");
  resetRunners();
});

test("fetchBriefContent: weekly empty tree returns null content", () => {
  setGhRunner(makeGhMock(() => ""));
  const { content } = fetchBriefContent({ kind: "weekly synthesis", sha: "s1", date: "2026-06-28T00:00:00Z" });
  assert.equal(content, null);
  resetRunners();
});

test("processCandidate: --force bypasses pushed-skip and pushes on ok:true", () => {
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  const pushed = { s1: "daily brief" }; // already pushed
  setGhRunner(makeGhMock(() => Buffer.from("body", "utf8").toString("base64")));
  setLarkRunner(makeLarkMock(() => ({ status: 0, stdout: okJson(), stderr: "" })));
  const r = processCandidate(
    { kind: "daily brief", sha: "s1", date: "2026-06-30T00:00:00Z" },
    { dryRun: false, force: true, pushed, stateFile, failedFile, sendAttempts: 1, sendWaitMs: 1 });
  assert.equal(r.pushed, true);
  assert.equal(loadPushed(stateFile).s1, "daily brief");
  assert.ok(!existsSync(failedFile));
  resetRunners();
  cleanup();
});

test("processCandidate: non-force skips already-pushed candidate", () => {
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  const pushed = { s1: "daily brief" };
  let ghCalled = false, larkCalled = false;
  setGhRunner(makeGhMock(() => { ghCalled = true; return ""; }));
  setLarkRunner(makeLarkMock(() => { larkCalled = true; return { status: 0, stdout: okJson(), stderr: "" }; }));
  const r = processCandidate(
    { kind: "daily brief", sha: "s1", date: "2026-06-30T00:00:00Z" },
    { dryRun: false, force: false, pushed, stateFile, failedFile, sendAttempts: 1, sendWaitMs: 1 });
  assert.equal(r.skipped, true);
  assert.equal(ghCalled, false);
  assert.equal(larkCalled, false);
  resetRunners();
  cleanup();
});

test("processCandidate: dry-run does not send and does not record", () => {
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  setGhRunner(makeGhMock(() => Buffer.from("body", "utf8").toString("base64")));
  let larkCalled = false;
  setLarkRunner(makeLarkMock(() => { larkCalled = true; return { status: 0, stdout: okJson(), stderr: "" }; }));
  const r = processCandidate(
    { kind: "daily brief", sha: "s1", date: "2026-06-30T00:00:00Z" },
    { dryRun: true, force: true, pushed: {}, stateFile, failedFile, sendAttempts: 1, sendWaitMs: 1 });
  assert.equal(r.dry, true);
  assert.equal(larkCalled, false);
  assert.ok(!existsSync(stateFile));
  assert.ok(!existsSync(failedFile));
  resetRunners();
  cleanup();
});

test("processCandidate: send failure records to failed-commits.json", () => {
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  setRetryWait(1);
  setGhRunner(makeGhMock(() => Buffer.from("body", "utf8").toString("base64")));
  setLarkRunner(makeLarkMock(() => ({ status: 1, stdout: "", stderr: "boom" })));
  const r = processCandidate(
    { kind: "daily brief", sha: "s9", date: "2026-06-30T00:00:00Z" },
    { dryRun: false, force: true, pushed: {}, stateFile, failedFile, sendAttempts: 2, sendWaitMs: 1 });
  assert.equal(r.failed, true);
  assert.ok(r.error.includes("exit=1"));
  const arr = JSON.parse(readFileSync(failedFile, "utf8"));
  assert.equal(arr[0].sha, "s9");
  assert.ok(!existsSync(stateFile) || Object.keys(loadPushed(stateFile)).length === 0);
  resetRunners();
  cleanup();
});

test("processCandidate: no-content fetch skips (no send, no record)", () => {
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  setGhRunner(makeGhMock(() => { throw new Error("404"); }));
  let larkCalled = false;
  setLarkRunner(makeLarkMock(() => { larkCalled = true; return { status: 0, stdout: okJson(), stderr: "" }; }));
  const r = processCandidate(
    { kind: "daily brief", sha: "s1", date: "2026-06-30T00:00:00Z" },
    { dryRun: false, force: true, pushed: {}, stateFile, failedFile, sendAttempts: 1, sendWaitMs: 1 });
  assert.equal(r.noContent, true);
  assert.equal(larkCalled, false);
  assert.ok(!existsSync(failedFile));
  resetRunners();
  cleanup();
});

test("sleepSync returns without throwing for small ms", () => {
  const t0 = Date.now();
  sleepSync(1);
  assert.ok(Date.now() - t0 < 5000, "sleepSync(1) should not hang");
});

test("runPipeline: empty commits listing → { code:0, nothing:true }", async () => {
  setRetryWait(1);
  setGhRunner(makeGhMock(() => ""));
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  const r = await runPipeline({ argv: [], stateFile, failedFile });
  assert.equal(r.code, 0);
  assert.equal(r.nothing, true);
  resetRunners();
  cleanup();
});

test("runPipeline: gh listing all-fail → { code:1, fatal } (no process.exit)", async () => {
  setRetryWait(1);
  setGhRunner(makeGhMock(() => { throw new Error("tls timeout"); }));
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  const r = await runPipeline({ argv: [], stateFile, failedFile });
  assert.equal(r.code, 1);
  assert.ok(r.fatal.includes("tls timeout"));
  resetRunners();
  cleanup();
});

test("runPipeline: normal flow processes candidates end-to-end with mocks", async () => {
  setRetryWait(1);
  const commits = [
    { sha: "c1", kind: "daily brief", msg: "chore: daily brief 2026-06-30", date: "2026-06-30T00:00:00Z" },
    { sha: "c2", kind: "weekly synthesis", msg: "chore: weekly synthesis 2026-06-28", date: "2026-06-28T00:00:00Z" },
  ];
  const b64daily = Buffer.from("---\nx:1\n---\n# Daily body", "utf8").toString("base64");
  setGhRunner((argv) => {
    if (argv.some((a) => typeof a === "string" && a.includes("commits?per_page"))) return commits.map((c) => JSON.stringify(c)).join("\n");
    if (argv.some((a) => typeof a === "string" && a.includes("git/trees"))) return "10_Daily/weekly-W26-2026-06-28.md";
    if (argv.some((a) => typeof a === "string" && a.includes("contents"))) return b64daily;
    return "";
  });
  setLarkRunner(makeLarkMock(() => ({ status: 0, stdout: okJson(), stderr: "" })));
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  const r = await runPipeline({ argv: ["--force"], stateFile, failedFile });
  assert.equal(r.code, 0);
  assert.equal(r.results.length, 2);
  assert.ok(r.results.every((x) => x.pushed));
  assert.equal(loadPushed(stateFile).c1, "daily brief");
  assert.equal(loadPushed(stateFile).c2, "weekly synthesis");
  resetRunners();
  cleanup();
});

test("runPipeline: --dry-run produces dry results, no send, no state write", async () => {
  setRetryWait(1);
  const commits = [{ sha: "c1", kind: "daily brief", msg: "chore: daily brief", date: "2026-06-30T00:00:00Z" }];
  setGhRunner((argv) => {
    if (argv.some((a) => typeof a === "string" && a.includes("commits?per_page"))) return JSON.stringify(commits[0]);
    if (argv.some((a) => typeof a === "string" && a.includes("contents"))) return Buffer.from("body", "utf8").toString("base64");
    return "";
  });
  let larkCalled = false;
  setLarkRunner(() => { larkCalled = true; return { status: 0, stdout: okJson(), stderr: "" }; });
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  const r = await runPipeline({ argv: ["--dry-run", "--force"], stateFile, failedFile });
  assert.equal(r.code, 0);
  assert.equal(r.results[0].dry, true);
  assert.equal(larkCalled, false);
  resetRunners();
  cleanup();
});

// ============================ FUZZ ROUND 1 ============================
// Variable commit lists + variable gh behavior. Invariants:
//   - ghWithRetry attempts never exceed GH_MAX_ATTEMPTS
//   - all-gh-fail → fetchBriefContent returns null (no throw)
//   - success path returns decoded content

test("FUZZ ROUND 1 (seed 1): variable commit lists + gh outcomes respect retry cap", () => {
  setRetryWait(1);
  const rng = mulberry32(1);
  const kinds = ["daily brief", "weekly synthesis"];
  let sawAllFail = 0, sawSuccess = 0, sawWeekly = 0, sawTransientRecover = 0, sawCapHit = 0, sawNoRecordOnFail = 0;

  // Part A — ghWithRetry directly with variable transient behavior (ISC-13, ISC-14)
  for (let i = 0; i < 40; i++) {
    const succeedAt = rand(rng, 1, 4); // 4 = never (all fail)
    const gh = makeGhMock((_a, n) => {
      if (n >= succeedAt) return "ok-" + i;
      throw new Error("transient " + n);
    });
    setGhRunner(gh);
    if (succeedAt > GH_MAX_ATTEMPTS) {
      assert.throws(() => ghWithRetry("api", "x"), /transient/);
      assert.equal(gh.attempts(), GH_MAX_ATTEMPTS);
      sawCapHit++;
    } else {
      assert.equal(ghWithRetry("api", "x"), "ok-" + i);
      assert.ok(gh.attempts() <= GH_MAX_ATTEMPTS, `attempt ${gh.attempts()} > cap`);
      assert.equal(gh.attempts(), succeedAt);
      if (succeedAt > 1) sawTransientRecover++;
      else sawSuccess++;
    }
  }

  // Part B — fetchBriefContent + processCandidate with variable commit lists (ISC-12, ISC-15, ISC-24)
  for (let i = 0; i < 40; i++) {
    const count = rand(rng, 0, 4);
    for (let j = 0; j < count; j++) {
      const kind = pick(rng, kinds);
      if (kind === "weekly synthesis") sawWeekly++;
      const sha = "s" + rand(rng, 1000, 9999);
      const date = `2026-0${rand(rng, 1, 9)}-${String(rand(rng, 1, 28)).padStart(2, "0")}T00:00:00Z`;
      const succeedAt = rand(rng, 1, 4);
      const body = `# ${kind}\n\ncontent ${i}.${j}`;
      const b64 = Buffer.from(body, "utf8").toString("base64");
      setGhRunner((argv) => {
        const isTree = argv.some((a) => typeof a === "string" && a.includes("git/trees"));
        const isContents = argv.some((a) => typeof a === "string" && a.includes("contents"));
        if (isTree) return "10_Daily/weekly-W26-2026-06-28.md";
        if (isContents) {
          if (succeedAt <= GH_MAX_ATTEMPTS) return b64;
          throw new Error("transient contents");
        }
        return "[]";
      });
      const { content } = fetchBriefContent({ kind, sha, date });
      if (succeedAt > GH_MAX_ATTEMPTS) {
        assert.equal(content, null);
        sawAllFail++;
        // ISC-15: all-gh-fail through processCandidate → no markPushed, no throw
        const { stateFile, failedFile, cleanup } = tmpStateDir();
        setLarkRunner(() => { throw new Error("should not send"); });
        const r = processCandidate(
          { kind, sha, date },
          { dryRun: false, force: true, pushed: {}, stateFile, failedFile, sendAttempts: 1, sendWaitMs: 1 });
        assert.equal(r.noContent, true);
        assert.ok(!existsSync(stateFile) || Object.keys(loadPushed(stateFile)).length === 0, "no markPushed on all-fail");
        sawNoRecordOnFail++;
        resetRunners();
        setRetryWait(1);
        cleanup();
      } else {
        assert.equal(content, body);
        sawSuccess++;
      }
    }
  }
  assert.ok(sawAllFail > 0, "round 1 must exercise all-gh-fail path");
  assert.ok(sawSuccess > 0, "round 1 must exercise gh-success path");
  assert.ok(sawWeekly > 0, "round 1 must exercise weekly synthesis branch");
  assert.ok(sawTransientRecover > 0, "round 1 must exercise transient-fail-then-success");
  assert.ok(sawCapHit > 0, "round 1 must hit retry cap (all-fail at 3)");
  assert.ok(sawNoRecordOnFail > 0, "round 1 must assert no-record on all-fail");
  resetRunners();
});

// ============================ FUZZ ROUND 2 ============================
// Variable lark outcomes + variable state. Invariants:
//   - sendBrief attempts never exceed SEND_MAX_ATTEMPTS
//   - markPushed recorded only when sendBrief ok:true
//   - appendFailed recorded only when ok:false, with sha/kind/error/failed_at present and valid ISO
//   - no crash on corrupted/empty state

test("FUZZ ROUND 2 (seed 2): variable lark outcomes + state respect invariants", () => {
  const rng = mulberry32(2);
  const kinds = ["daily brief", "weekly synthesis"];
  let okTrueSeen = 0, okFalseSeen = 0, maxSendAttempts = 0;
  for (let i = 0; i < 60; i++) {
    const { stateFile, failedFile, cleanup } = tmpStateDir();
    // variable initial state: empty / some pushed / corrupted failed
    const stateMode = rand(rng, 0, 2);
    if (stateMode === 1) {
      markPushed("preexisting", "daily brief", stateFile);
    } else if (stateMode === 2) {
      writeFileSync(failedFile, "{corrupted", "utf8");
    }
    const count = rand(rng, 1, 3);
    for (let j = 0; j < count; j++) {
      const kind = pick(rng, kinds);
      const sha = `f${i}_${j}`;
      const date = "2026-06-30T00:00:00Z";
      // lark outcome modes: 0=ok true, 1=ok false, 2=exit!=0, 3=non-json, 4=ok:false then ok:true
      const mode = rand(rng, 0, 4);
      let sendAttempts = 0;
      setLarkRunner(() => {
        sendAttempts++;
        if (mode === 0) return { status: 0, stdout: okJson(), stderr: "" };
        if (mode === 1) return { status: 0, stdout: failJson("nope"), stderr: "" };
        if (mode === 2) return { status: 1, stdout: "", stderr: "err" };
        if (mode === 3) return { status: 0, stdout: "garbage", stderr: "" };
        return sendAttempts >= 2 ? { status: 0, stdout: okJson(), stderr: "" } : { status: 0, stdout: failJson(), stderr: "" };
      });
      setGhRunner(makeGhMock(() => Buffer.from("body", "utf8").toString("base64")));
      const r = processCandidate(
        { kind, sha, date },
        { dryRun: false, force: true, pushed: loadPushed(stateFile), stateFile, failedFile, sendAttempts: SEND_MAX_ATTEMPTS, sendWaitMs: 1 });
      maxSendAttempts = Math.max(maxSendAttempts, sendAttempts);
      assert.ok(sendAttempts <= SEND_MAX_ATTEMPTS, `send attempts ${sendAttempts} > cap`);
      if (mode === 0 || mode === 4) {
        assert.equal(r.pushed, true, `mode ${mode} should push`);
        assert.equal(loadPushed(stateFile)[sha], kind);
        okTrueSeen++;
      } else {
        assert.equal(r.failed, true, `mode ${mode} should fail`);
        const arr = existsSync(failedFile) ? JSON.parse(readFileSync(failedFile, "utf8")) : [];
        const entry = arr.find((e) => e.sha === sha);
        assert.ok(entry, "failed entry recorded");
        assert.equal(entry.kind, kind);
        assert.ok(typeof entry.error === "string" && entry.error.length > 0);
        assert.ok(!isNaN(Date.parse(entry.failed_at)), "failed_at valid ISO");
        okFalseSeen++;
      }
    }
    cleanup();
  }
  assert.ok(okTrueSeen > 0 && okFalseSeen > 0, "round 2 must see both ok:true and ok:false outcomes");
  assert.ok(maxSendAttempts === SEND_MAX_ATTEMPTS, "round 2 must hit send retry cap at least once");
  resetRunners();
});
