import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  curlGithub,
  parseGithubResponse,
  sendBrief,
  appendFailed,
  appendFailedRun,
  markPushed,
  loadPushed,
  parseArgs,
  fetchBriefContent,
  processCandidate,
  setCurlRunner,
  setLarkRunner,
  setRetryWait,
  resetRunners,
  runPipeline,
  runMain,
  sleepSync,
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
    failedRunsFile: path.join(d, "failed-runs.json"),
    cleanup: () => rmSync(d, { recursive: true, force: true }),
  };
}

// mock curl runner: calls a per-call handler with the attempt index.
// handler returns object (success) or throws (failure).
function makeCurlMock(handler) {
  let attempts = 0;
  const fn = (urlPath) => {
    attempts++;
    return handler(urlPath, attempts);
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

// raw GitHub commit shape helper
const rawCommit = (sha, message, date) => ({ sha, commit: { message, author: { date } } });

// ============================ targeted edge tests ============================

test("parseArgs parses --dry-run and --force in any combination", () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, force: false });
  assert.deepEqual(parseArgs(["--dry-run"]), { dryRun: true, force: false });
  assert.deepEqual(parseArgs(["--force"]), { dryRun: false, force: true });
  assert.deepEqual(parseArgs(["--dry-run", "--force", "extra"]), { dryRun: true, force: true });
});

test("curlGithub returns curlRunner result (object)", () => {
  setCurlRunner(() => ({ ok: true, sha: "abc" }));
  assert.deepEqual(curlGithub("/repos/x/y/commits"), { ok: true, sha: "abc" });
  resetRunners();
});

test("curlGithub returns curlRunner result (array)", () => {
  setCurlRunner(() => [1, 2, 3]);
  assert.deepEqual(curlGithub("/repos/x/y/commits"), [1, 2, 3]);
  resetRunners();
});

test("curlGithub propagates curlRunner throw (no JS retry)", () => {
  setCurlRunner(() => { throw new Error("tls timeout"); });
  assert.throws(() => curlGithub("/repos/x/y/commits"), /tls timeout/);
  resetRunners();
});

test("parseGithubResponse: valid JSON object → returns parsed", () => {
  assert.deepEqual(parseGithubResponse('{"ok":true}', "", 0), { ok: true });
});

test("parseGithubResponse: valid JSON array → returns parsed", () => {
  assert.deepEqual(parseGithubResponse('[1,2,3]', "", 0), [1, 2, 3]);
});

test("parseGithubResponse: non-zero exit → throws with exit code + stderr", () => {
  assert.throws(() => parseGithubResponse("", "connection refused", 7), /curl failed \(exit 7\): connection refused/);
});

test("parseGithubResponse: non-zero exit with empty stderr → throws with 'no stderr'", () => {
  assert.throws(() => parseGithubResponse("", "", 28), /no stderr/);
});

test("parseGithubResponse: non-JSON stdout → throws with body preview", () => {
  assert.throws(() => parseGithubResponse("not json at all", "", 0), /github api non-json: not json at all/);
});

test("parseGithubResponse: empty stdout → throws empty body error", () => {
  assert.throws(() => parseGithubResponse("", "", 0), /empty body/);
});

test("parseGithubResponse: GitHub API error shape → throws with message + status", () => {
  const err = JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com", status: "404" });
  assert.throws(() => parseGithubResponse(err, "", 0), /github api error: Not Found \(404\)/);
});

test("parseGithubResponse: response with message but no documentation_url → returns parsed (not error shape)", () => {
  // e.g. a commit object has a commit.message field — but top-level message without documentation_url is not an error
  const data = JSON.stringify({ message: "commit msg", sha: "abc" });
  assert.deepEqual(parseGithubResponse(data, "", 0), { message: "commit msg", sha: "abc" });
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

test("appendFailedRun writes {error, failed_at} with valid ISO", () => {
  const { failedRunsFile, cleanup } = tmpStateDir();
  appendFailedRun(new Error("boom"), failedRunsFile);
  const arr = JSON.parse(readFileSync(failedRunsFile, "utf8"));
  assert.equal(arr.length, 1);
  assert.equal(arr[0].error, "boom");
  assert.ok(!isNaN(Date.parse(arr[0].failed_at)), "failed_at is valid ISO");
  cleanup();
});

test("appendFailedRun appends to existing and survives corrupted file", () => {
  const { failedRunsFile, cleanup } = tmpStateDir();
  appendFailedRun(new Error("e1"), failedRunsFile);
  writeFileSync(failedRunsFile, "{not valid json", "utf8"); // corrupt it
  appendFailedRun(new Error("e2"), failedRunsFile);
  const arr = JSON.parse(readFileSync(failedRunsFile, "utf8"));
  assert.equal(arr.length, 1); // corrupted reset to [], then 1 appended
  assert.equal(arr[0].error, "e2");
  cleanup();
});

test("fetchBriefContent: daily brief success returns decoded content", () => {
  const body = "# Brief\n\nhello world";
  const b64 = Buffer.from(body, "utf8").toString("base64");
  setCurlRunner(makeCurlMock(() => ({ content: b64 })));
  const { content, inferredPath } = fetchBriefContent({ kind: "daily brief", sha: "s1", date: "2026-06-30T00:00:00Z" });
  assert.equal(content, body);
  assert.equal(inferredPath, "00_Inbox/brief-2026-06-30.md");
  resetRunners();
});

test("fetchBriefContent: daily brief curl failure returns null content (no throw)", () => {
  setCurlRunner(makeCurlMock(() => { throw new Error("404"); }));
  const { content } = fetchBriefContent({ kind: "daily brief", sha: "s1", date: "2026-06-30T00:00:00Z" });
  assert.equal(content, null);
  resetRunners();
});

test("fetchBriefContent: weekly synthesis finds weekly file via tree", () => {
  const body = "# Weekly\n\nsynthesis";
  const b64 = Buffer.from(body, "utf8").toString("base64");
  let call = 0;
  setCurlRunner(makeCurlMock((urlPath) => {
    call++;
    if (urlPath.includes("git/trees")) return { tree: [{ path: "10_Daily/weekly-W26-2026-06-28.md" }] };
    return { content: b64 };
  }));
  const { content, inferredPath } = fetchBriefContent({ kind: "weekly synthesis", sha: "s1", date: "2026-06-28T00:00:00Z" });
  assert.equal(content, body);
  assert.equal(inferredPath, "10_Daily/weekly-W26-2026-06-28.md");
  resetRunners();
});

test("fetchBriefContent: weekly empty tree returns null content", () => {
  setCurlRunner(makeCurlMock(() => ({ tree: [] })));
  const { content } = fetchBriefContent({ kind: "weekly synthesis", sha: "s1", date: "2026-06-28T00:00:00Z" });
  assert.equal(content, null);
  resetRunners();
});

test("processCandidate: --force bypasses pushed-skip and pushes on ok:true", () => {
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  const pushed = { s1: "daily brief" }; // already pushed
  setCurlRunner(makeCurlMock(() => ({ content: Buffer.from("body", "utf8").toString("base64") })));
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
  let curlCalled = false, larkCalled = false;
  setCurlRunner(makeCurlMock(() => { curlCalled = true; return {}; }));
  setLarkRunner(makeLarkMock(() => { larkCalled = true; return { status: 0, stdout: okJson(), stderr: "" }; }));
  const r = processCandidate(
    { kind: "daily brief", sha: "s1", date: "2026-06-30T00:00:00Z" },
    { dryRun: false, force: false, pushed, stateFile, failedFile, sendAttempts: 1, sendWaitMs: 1 });
  assert.equal(r.skipped, true);
  assert.equal(curlCalled, false);
  assert.equal(larkCalled, false);
  resetRunners();
  cleanup();
});

test("processCandidate: dry-run does not send and does not record", () => {
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  setCurlRunner(makeCurlMock(() => ({ content: Buffer.from("body", "utf8").toString("base64") })));
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
  setCurlRunner(makeCurlMock(() => ({ content: Buffer.from("body", "utf8").toString("base64") })));
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
  setCurlRunner(makeCurlMock(() => { throw new Error("404"); }));
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
  setCurlRunner(makeCurlMock(() => []));
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  const r = await runPipeline({ argv: [], stateFile, failedFile });
  assert.equal(r.code, 0);
  assert.equal(r.nothing, true);
  resetRunners();
  cleanup();
});

test("runPipeline: curl listing all-fail → throws (no process.exit, no state write)", async () => {
  setCurlRunner(makeCurlMock(() => { throw new Error("tls timeout"); }));
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  await assert.rejects(() => runPipeline({ argv: [], stateFile, failedFile }), /tls timeout/);
  resetRunners();
  cleanup();
});

test("runPipeline: normal flow processes candidates end-to-end with mocks", async () => {
  const rawCommits = [
    rawCommit("c1", "chore: daily brief 2026-06-30", "2026-06-30T00:00:00Z"),
    rawCommit("c2", "chore: weekly synthesis 2026-06-28", "2026-06-28T00:00:00Z"),
  ];
  const b64daily = Buffer.from("---\nx:1\n---\n# Daily body", "utf8").toString("base64");
  setCurlRunner((urlPath) => {
    if (urlPath.includes("commits?per_page")) return rawCommits;
    if (urlPath.includes("git/trees")) return { tree: [{ path: "10_Daily/weekly-W26-2026-06-28.md" }] };
    if (urlPath.includes("contents")) return { content: b64daily };
    return {};
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
  const rawCommits = [rawCommit("c1", "chore: daily brief 2026-06-30", "2026-06-30T00:00:00Z")];
  setCurlRunner((urlPath) => {
    if (urlPath.includes("commits?per_page")) return rawCommits;
    if (urlPath.includes("contents")) return { content: Buffer.from("body", "utf8").toString("base64") };
    return {};
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

test("runPipeline: filters out non-brief commits", async () => {
  const rawCommits = [
    rawCommit("c1", "fix: typo in readme", "2026-06-30T00:00:00Z"),
    rawCommit("c2", "chore: daily brief 2026-06-30", "2026-06-30T00:00:00Z"),
    rawCommit("c3", "feat: new feature", "2026-06-29T00:00:00Z"),
  ];
  setCurlRunner((urlPath) => {
    if (urlPath.includes("commits?per_page")) return rawCommits;
    return {};
  });
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  const r = await runPipeline({ argv: ["--dry-run", "--force"], stateFile, failedFile });
  assert.equal(r.code, 0);
  assert.equal(r.results.length, 1); // only c2 matches
  resetRunners();
  cleanup();
});

test("runPipeline: backfill scenario — date parsed from commit message, not commit timestamp", async () => {
  // 4 backfill commits all made TODAY, but message dates are 7/4-7/7.
  // Script must use message date (not commit date) to derive brief file path.
  const rawCommits = [
    rawCommit("bk1", "chore: daily brief 2026-07-04", "2026-07-07T07:00:00Z"),
    rawCommit("bk2", "chore: daily brief 2026-07-05", "2026-07-07T07:01:00Z"),
    rawCommit("bk3", "chore: daily brief 2026-07-06", "2026-07-07T07:02:00Z"),
    rawCommit("bk4", "chore: daily brief 2026-07-07", "2026-07-07T07:03:00Z"),
  ];
  let fetchedPaths = [];
  setCurlRunner((urlPath) => {
    if (urlPath.includes("commits?per_page")) return rawCommits;
    if (urlPath.includes("contents")) {
      const m = urlPath.match(/brief-(\d{4}-\d{2}-\d{2})/);
      if (m) fetchedPaths.push(m[1]);
      return { content: Buffer.from(`# Brief ${m ? m[1] : "?"}`, "utf8").toString("base64") };
    }
    return {};
  });
  setLarkRunner(makeLarkMock(() => ({ status: 0, stdout: okJson(), stderr: "" })));
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  const r = await runPipeline({ argv: ["--force"], stateFile, failedFile });
  assert.equal(r.code, 0);
  assert.equal(r.results.length, 4);
  // Each brief fetched by its MESSAGE date, not commit date
  assert.deepEqual(fetchedPaths.sort(), ["2026-07-04", "2026-07-05", "2026-07-06", "2026-07-07"]);
  resetRunners();
  cleanup();
});

test("runPipeline: accepts curlRunner/larkRunner/retryWait via opts", async () => {
  const rawCommits = [rawCommit("c1", "chore: daily brief 2026-06-30", "2026-06-30T00:00:00Z")];
  const { stateFile, failedFile, cleanup } = tmpStateDir();
  const r = await runPipeline({
    argv: ["--dry-run", "--force"],
    stateFile, failedFile,
    curlRunner: (urlPath) => {
      if (urlPath.includes("commits?per_page")) return rawCommits;
      if (urlPath.includes("contents")) return { content: Buffer.from("body", "utf8").toString("base64") };
      return {};
    },
    larkRunner: () => { throw new Error("should not be called in dry-run"); },
    retryWait: 1,
  });
  assert.equal(r.code, 0);
  assert.equal(r.results[0].dry, true);
  resetRunners();
  cleanup();
});

test("runMain: pipeline success → returns pipeline result, no failed-runs.json", async () => {
  setCurlRunner(() => []);
  const { stateFile, failedFile, failedRunsFile, cleanup } = tmpStateDir();
  const r = await runMain({ argv: [], stateFile, failedFile, failedRunsFile });
  assert.equal(r.code, 0);
  assert.equal(r.nothing, true);
  assert.ok(!existsSync(failedRunsFile));
  resetRunners();
  cleanup();
});

test("runMain: pipeline failure → logs to failed-runs.json + {code:0, logged:true}", async () => {
  setCurlRunner(() => { throw new Error("tls timeout"); });
  const { stateFile, failedFile, failedRunsFile, cleanup } = tmpStateDir();
  const r = await runMain({ argv: [], stateFile, failedFile, failedRunsFile });
  assert.equal(r.code, 0);
  assert.equal(r.logged, true);
  assert.ok(r.error.includes("tls timeout"));
  assert.ok(existsSync(failedRunsFile));
  const arr = JSON.parse(readFileSync(failedRunsFile, "utf8"));
  assert.equal(arr.length, 1);
  assert.ok(arr[0].error.includes("tls timeout"));
  assert.ok(!isNaN(Date.parse(arr[0].failed_at)), "failed_at valid ISO");
  resetRunners();
  cleanup();
});

test("runMain: pipeline failure with corrupted failed-runs.json → still logs + exit 0", async () => {
  setCurlRunner(() => { throw new Error("tls timeout 2"); });
  const { stateFile, failedFile, failedRunsFile, cleanup } = tmpStateDir();
  writeFileSync(failedRunsFile, "{corrupted", "utf8");
  const r = await runMain({ argv: [], stateFile, failedFile, failedRunsFile });
  assert.equal(r.code, 0);
  assert.equal(r.logged, true);
  const arr = JSON.parse(readFileSync(failedRunsFile, "utf8"));
  assert.equal(arr.length, 1); // corrupted reset, then 1 appended
  assert.ok(arr[0].error.includes("tls timeout 2"));
  resetRunners();
  cleanup();
});

// ============================ FUZZ ROUND 1 ============================
// Variable commit lists + variable curl behavior. Invariants:
//   - curlGithub propagates curlRunner outcome (no JS retry)
//   - all-curl-fail → fetchBriefContent returns null (no throw)
//   - success path returns decoded content

test("FUZZ ROUND 1 (seed 1): variable commit lists + curl outcomes", () => {
  const rng = mulberry32(1);
  const kinds = ["daily brief", "weekly synthesis"];
  let sawAllFail = 0, sawSuccess = 0, sawWeekly = 0, sawNoRecordOnFail = 0, sawCurlThrow = 0;

  // Part A — curlGithub propagates curlRunner outcome (no JS retry)
  for (let i = 0; i < 40; i++) {
    const succeeds = rng() > 0.3;
    setCurlRunner(() => {
      if (succeeds) return { ok: true, i };
      throw new Error("transient " + i);
    });
    if (succeeds) {
      const r = curlGithub("/test");
      assert.equal(r.i, i);
      sawSuccess++;
    } else {
      assert.throws(() => curlGithub("/test"), /transient/);
      sawCurlThrow++;
    }
  }

  // Part B — fetchBriefContent + processCandidate with variable commit lists
  for (let i = 0; i < 40; i++) {
    const count = rand(rng, 0, 4);
    for (let j = 0; j < count; j++) {
      const kind = pick(rng, kinds);
      if (kind === "weekly synthesis") sawWeekly++;
      const sha = "s" + rand(rng, 1000, 9999);
      const date = `2026-0${rand(rng, 1, 9)}-${String(rand(rng, 1, 28)).padStart(2, "0")}T00:00:00Z`;
      const succeeds = rng() > 0.3;
      const body = `# ${kind}\n\ncontent ${i}.${j}`;
      const b64 = Buffer.from(body, "utf8").toString("base64");
      setCurlRunner((urlPath) => {
        const isTree = urlPath.includes("git/trees");
        const isContents = urlPath.includes("contents");
        if (isTree) return { tree: [{ path: "10_Daily/weekly-W26-2026-06-28.md" }] };
        if (isContents) {
          if (succeeds) return { content: b64 };
          throw new Error("transient contents");
        }
        return [];
      });
      const { content } = fetchBriefContent({ kind, sha, date });
      if (!succeeds) {
        assert.equal(content, null);
        sawAllFail++;
        // ISC-15: all-curl-fail through processCandidate → no markPushed, no throw
        const { stateFile, failedFile, cleanup } = tmpStateDir();
        setLarkRunner(() => { throw new Error("should not send"); });
        const r = processCandidate(
          { kind, sha, date },
          { dryRun: false, force: true, pushed: {}, stateFile, failedFile, sendAttempts: 1, sendWaitMs: 1 });
        assert.equal(r.noContent, true);
        assert.ok(!existsSync(stateFile) || Object.keys(loadPushed(stateFile)).length === 0, "no markPushed on all-fail");
        sawNoRecordOnFail++;
        resetRunners();
        cleanup();
      } else {
        assert.equal(content, body);
        sawSuccess++;
      }
    }
  }
  assert.ok(sawAllFail > 0, "round 1 must exercise all-curl-fail path");
  assert.ok(sawSuccess > 0, "round 1 must exercise curl-success path");
  assert.ok(sawWeekly > 0, "round 1 must exercise weekly synthesis branch");
  assert.ok(sawCurlThrow > 0, "round 1 must exercise curlGithub throw propagation");
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
      setCurlRunner((urlPath) => {
        if (urlPath.includes("git/trees")) return { tree: [{ path: "10_Daily/weekly-W26-2026-06-28.md" }] };
        return { content: Buffer.from("body", "utf8").toString("base64") };
      });
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
