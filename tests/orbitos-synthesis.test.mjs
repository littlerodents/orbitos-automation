import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDailyPlan,
  buildWeeklyPlan,
  defaultLedgerPath,
  defaultSecretProvider,
  defaultOutputPath,
  extractAssistantText,
  renderArtifact,
  runSynthesis,
  scheduledInstantMs,
} from "../orbitos-synthesis.mjs";

function tmpVault() {
  const root = mkdtempSync(path.join(tmpdir(), "orbitos-synthesis-vault-"));
  for (const dir of ["00_Inbox", "20_Project", "30_Research/Selected", "40_Wiki", "99_System/Prompts", "10_Daily"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  writeFileSync(path.join(root, "99_System/Prompts/Daily_Brief.md"), "DAILY SYSTEM", "utf8");
  writeFileSync(path.join(root, "99_System/Prompts/Weekly_Synthesis.md"), "WEEKLY SYSTEM", "utf8");
  return {
    root,
    write(rel, content) {
      const file = path.join(root, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function selectedNote(date, extra = "") {
  return `---\ndate: ${date}\ntype: selected-content\n---\n# Signal ${date}\n\n${extra || "selected signal".repeat(30)}`;
}

function validArtifactBody() {
  return "Valid synthesis content with enough detail to be accepted. ".repeat(12);
}

function cleanGitRunner(commands = [], overrides = {}) {
  return async (argv) => {
    commands.push(argv);
    const key = argv.join(" ");
    if (overrides[key]) return overrides[key](argv);
    if (key === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "", status: 0 };
    if (key === "status --porcelain") return { stdout: "", stderr: "", status: 0 };
    if (key === "status --porcelain --branch") return { stdout: "## main...origin/main\n", stderr: "", status: 0 };
    if (key === "pull --ff-only") return { stdout: "", stderr: "", status: 0 };
    if (argv[0] === "add") return { stdout: "", stderr: "", status: 0 };
    if (argv[0] === "commit") return { stdout: "", stderr: "", status: 0 };
    if (argv[0] === "push") return { stdout: "", stderr: "", status: 0 };
    if (key === "rev-parse HEAD") return { stdout: "abc123\n", stderr: "", status: 0 };
    return { stdout: "", stderr: "", status: 0 };
  };
}

test("buildDailyPlan matches public n8n selection behavior without leaking file content in summary", () => {
  const v = tmpVault();
  try {
    v.write("00_Inbox/inbox-fresh.md", selectedNote("2026-07-29", "fresh inbox"));
    v.write("00_Inbox/brief-2026-07-29.md", "must be excluded");
    v.write("30_Research/Selected/selected-fresh.md", selectedNote("2026-07-27", "fresh selected"));
    v.write("40_Wiki/wiki-old.md", selectedNote("2026-07-01", "old selected"));
    const plan = buildDailyPlan({ vaultPath: v.root, date: "2026-07-29" });
    assert.equal(plan.kind, "daily");
    assert.equal(plan.period, "2026-07-29");
    assert.equal(plan.outputPath, "00_Inbox/brief-2026-07-29.md");
    assert.equal(plan.systemPrompt, "DAILY SYSTEM");
    assert.equal(plan.counts.inbox, 1);
    assert.equal(plan.counts.research, 1);
    assert.equal(plan.selectedFiles.length, 4);
    assert.match(plan.userContent, /INBOX \(last 24h, light context, 1 notes\)/);
    assert.match(plan.userContent, /SELECTED \/ PROJECT \/ WIKI \(last 7d, primary input, 1 notes\)/);
  } finally {
    v.cleanup();
  }
});

test("buildDailyPlan includes prior-day date-only note at Daily 08:00 CST boundary", () => {
  const v = tmpVault();
  try {
    assert.equal(new Date("2026-07-28").getTime(), new Date("2026-07-29T08:00:00+08:00").getTime() - 24 * 3600 * 1000);
    v.write("00_Inbox/prior-day.md", selectedNote("2026-07-28", "prior day inbox boundary"));
    const plan = buildDailyPlan({ vaultPath: v.root, date: "2026-07-29" });
    assert.equal(plan.counts.inbox, 1);
    assert.match(plan.userContent, /\[\[prior-day\]\]/);
  } finally {
    v.cleanup();
  }
});

test("buildWeeklyPlan computes ISO week, output path, projects, and deterministic old signal", () => {
  const v = tmpVault();
  try {
    v.write("30_Research/Selected/old-a.md", selectedNote("2026-06-01", "old a"));
    v.write("30_Research/Selected/old-b.md", selectedNote("2026-06-02", "old b"));
    v.write("30_Research/Selected/week.md", selectedNote("2026-07-27", "this week"));
    v.write("20_Project/project.md", "# Active Project\n\ncurrent");
    const plan = buildWeeklyPlan({ vaultPath: v.root, date: "2026-07-29" });
    assert.equal(plan.kind, "weekly");
    assert.equal(plan.period, "W31-2026-07-29");
    assert.equal(plan.week, 31);
    assert.equal(plan.outputPath, "10_Daily/weekly-W31-2026-07-29.md");
    assert.equal(plan.counts.weekly, 1);
    assert.equal(plan.counts.oldSignalCandidates, 2);
    assert.equal(plan.counts.projects, 1);
    assert.match(plan.userContent, /OLD SELECTED SIGNAL \(random revisit seed from 2 older candidates\)/);
  } finally {
    v.cleanup();
  }
});

test("buildWeeklyPlan treats seven-calendar-day date-only note as old signal", () => {
  const v = tmpVault();
  try {
    assert.equal(new Date("2026-07-22").getTime(), new Date("2026-07-29T10:00:00+08:00").getTime() - 7 * 24 * 3600 * 1000 - 2 * 3600 * 1000);
    v.write("30_Research/Selected/boundary.md", selectedNote("2026-07-22", "weekly boundary"));
    const plan = buildWeeklyPlan({ vaultPath: v.root, date: "2026-07-29" });
    assert.equal(plan.counts.weekly, 0);
    assert.equal(plan.counts.oldSignalCandidates, 1);
    assert.match(plan.userContent, /SELECTED WEEKLY NOTES \(0 items, last 7d\):\n\(empty\)/);
    assert.match(plan.userContent, /OLD SELECTED SIGNAL \(random revisit seed from 1 older candidates\)/);
    assert.match(plan.userContent, /\[\[boundary\]\]/);
  } finally {
    v.cleanup();
  }
});

test("dry-run is default safe mode and returns machine-readable summary only", async () => {
  const v = tmpVault();
  try {
    v.write("30_Research/Selected/week.md", selectedNote("2026-07-29", "secret-ish body should not print"));
    let llmCalled = false;
    let gitCalled = false;
    const lines = [];
    const result = await runSynthesis({
      argv: ["daily", "--date", "2026-07-29"],
      vaultPath: v.root,
      stdout: (line) => lines.push(line),
      llmClient: async () => { llmCalled = true; },
      gitRunner: async () => { gitCalled = true; },
    });
    assert.equal(result.dryRun, true);
    assert.equal(llmCalled, false);
    assert.equal(gitCalled, false);
    assert.equal(existsSync(path.join(v.root, "00_Inbox/brief-2026-07-29.md")), false);
    const summary = JSON.parse(lines.at(-1));
    assert.deepEqual(Object.keys(summary).sort(), ["dry_run", "kind", "model", "output_path", "period", "prompt_chars", "selected_file_count"].sort());
    assert.equal(summary.kind, "daily");
    assert.equal(summary.period, "2026-07-29");
    assert.equal(summary.output_path, "00_Inbox/brief-2026-07-29.md");
    assert.equal(summary.model, "deepseek-v4-flash");
    assert.ok(!lines.join("\n").includes("secret-ish body"));
  } finally {
    v.cleanup();
  }
});

test("apply fails closed when secret provider has no DeepSeek key", async () => {
  const v = tmpVault();
  try {
    const commands = [];
    await assert.rejects(
      () => runSynthesis({
        argv: ["weekly", "--apply", "--date", "2026-07-29"],
        vaultPath: v.root,
        secretProvider: async () => null,
        gitRunner: cleanGitRunner(commands),
      }),
      /DeepSeek API key unavailable/,
    );
    assert.deepEqual(commands.map((c) => c.join(" ")).slice(0, 4), [
      "rev-parse --is-inside-work-tree",
      "status --porcelain",
      "status --porcelain --branch",
      "pull --ff-only",
    ]);
  } finally {
    v.cleanup();
  }
});

test("apply rejects empty, ERROR, and short model artifacts before writing", async () => {
  const v = tmpVault();
  try {
    const bodies = ["", "## ERROR\n\nbad", "short"];
    for (const body of bodies) {
      await assert.rejects(
        () => runSynthesis({
          argv: ["daily", "--apply", "--date", "2026-07-29"],
          vaultPath: v.root,
          secretProvider: async () => "key",
          llmClient: async () => ({ choices: [{ message: { content: body } }] }),
          gitRunner: cleanGitRunner(),
        }),
        /model content/,
      );
      assert.equal(existsSync(path.join(v.root, "00_Inbox/brief-2026-07-29.md")), false);
    }
  } finally {
    v.cleanup();
  }
});

test("apply rejects ERROR and RAW REASONING headings inside model artifacts", async () => {
  const v = tmpVault();
  try {
    for (const body of [
      `${validArtifactBody()}\n\n## ERROR\n\n${validArtifactBody()}`,
      `${validArtifactBody()}\n\n### RAW REASONING\n\n${validArtifactBody()}`,
    ]) {
      await assert.rejects(
        () => runSynthesis({
          argv: ["daily", "--apply", "--date", "2026-07-29"],
          vaultPath: v.root,
          secretProvider: async () => "key",
          llmClient: async () => ({ choices: [{ message: { content: body } }] }),
          gitRunner: cleanGitRunner(),
        }),
        /rejected heading/,
      );
      assert.equal(existsSync(path.join(v.root, "00_Inbox/brief-2026-07-29.md")), false);
    }
  } finally {
    v.cleanup();
  }
});

test("apply writes fixed artifact, ledger, and git commands through injected runners", async () => {
  const v = tmpVault();
  try {
    v.write("30_Research/Selected/week.md", selectedNote("2026-07-29", "signal"));
    const ledgerFile = path.join(v.root, ".orbitos-synthesis-ledger.json");
    const commands = [];
    const body = "这是一段足够长的模型输出。".repeat(30);
    const result = await runSynthesis({
      argv: ["daily", "--apply", "--date", "2026-07-29", "--ledger", ledgerFile],
      vaultPath: v.root,
      secretProvider: async () => "key",
      llmClient: async ({ apiKey, model, endpoint }) => {
        assert.equal(apiKey, "key");
        assert.equal(model, "deepseek-v4-flash");
        assert.equal(endpoint, "https://api.deepseek.com/v1/chat/completions");
        return { choices: [{ message: { content: body } }] };
      },
      gitRunner: async (argv) => {
        commands.push(argv);
        const key = argv.join(" ");
        if (key === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "", status: 0 };
        if (key === "status --porcelain --branch") return { stdout: "## main...origin/main\n", stderr: "", status: 0 };
        if (key === "pull --ff-only") return { stdout: "", stderr: "", status: 0 };
        if (key === "status --porcelain") {
          const afterAdd = commands.some((c) => c[0] === "add");
          return { stdout: afterAdd ? "A  00_Inbox/brief-2026-07-29.md\n" : "", stderr: "", status: 0 };
        }
        if (argv[0] === "rev-parse") return { stdout: "abc123\n", stderr: "", status: 0 };
        return { stdout: "", stderr: "", status: 0 };
      },
    });
    assert.equal(result.status, "committed");
    assert.equal(result.ledgerWritten, true);
    assert.deepEqual(commands.map((c) => c[0]), ["rev-parse", "status", "status", "pull", "status", "add", "status", "commit", "rev-parse", "push"]);
    const artifact = readFileSync(path.join(v.root, "00_Inbox/brief-2026-07-29.md"), "utf8");
    assert.match(artifact, /type: daily-brief/);
    assert.match(artifact, /model: deepseek-v4-flash/);
    const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.runs[0].kind, "daily");
    assert.equal(ledger.runs[0].period, "2026-07-29");
    assert.equal(ledger.runs[0].stage, "apply");
    assert.equal(ledger.runs[0].status, "committed");
    assert.equal(ledger.runs[0].artifact_path, "00_Inbox/brief-2026-07-29.md");
    assert.equal(typeof ledger.runs[0].content_hash, "string");
    assert.equal(ledger.runs[0].commit_sha, "abc123");
    assert.ok(!JSON.stringify(ledger).includes(body));
  } finally {
    v.cleanup();
  }
});

test("apply returns valid existing no-op before LLM when target already exists after preflight", async () => {
  const v = tmpVault();
  try {
    v.write("00_Inbox/brief-2026-07-29.md", renderArtifact({
      kind: "daily",
      date: "2026-07-29",
      model: "deepseek-v4-flash",
      text: validArtifactBody(),
    }));
    let llmCalled = false;
    const commands = [];
    const ledgerFile = path.join(v.root, "runs.json");
    const noop = await runSynthesis({
      argv: ["daily", "--apply", "--date", "2026-07-29", "--ledger", ledgerFile],
      vaultPath: v.root,
      secretProvider: async () => "key",
      llmClient: async () => { llmCalled = true; },
      gitRunner: cleanGitRunner(commands),
    });
    assert.equal(noop.status, "existing");
    assert.equal(llmCalled, false);
    assert.deepEqual(commands.map((c) => c.join(" ")), [
      "rev-parse --is-inside-work-tree",
      "status --porcelain",
      "status --porcelain --branch",
      "pull --ff-only",
      "status --porcelain",
    ]);
    assert.equal(noop.ledgerWritten, true);
    const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
    assert.equal(ledger.runs[0].status, "existing");
  } finally {
    v.cleanup();
  }
});

test("apply rejects invalid existing artifacts without LLM and leaves content unchanged", async () => {
  const v = tmpVault();
  try {
    const cases = [
      { text: "", error: /existing artifact body empty/ },
      { text: "short existing output", error: /existing artifact shorter than 300/ },
      { text: `${validArtifactBody()}\n\n## ERROR\n\nfallback`, error: /existing artifact contains rejected heading/ },
      { text: `${validArtifactBody()}\n\n## RAW REASONING\n\nfallback`, error: /existing artifact contains rejected heading/ },
    ];
    for (const [idx, c] of cases.entries()) {
      const invalid = renderArtifact({
        kind: "daily",
        date: "2026-07-29",
        model: "deepseek-v4-flash",
        text: c.text,
      });
      v.write("00_Inbox/brief-2026-07-29.md", invalid);
      let llmCalled = false;
      const ledgerFile = path.join(v.root, `runs-${idx}.json`);
      await assert.rejects(
        () => runSynthesis({
          argv: ["daily", "--apply", "--date", "2026-07-29", "--ledger", ledgerFile],
          vaultPath: v.root,
          secretProvider: async () => "key",
          llmClient: async () => { llmCalled = true; },
          gitRunner: cleanGitRunner(),
        }),
        c.error,
      );
      assert.equal(llmCalled, false);
      assert.equal(readFileSync(path.join(v.root, "00_Inbox/brief-2026-07-29.md"), "utf8"), invalid);
      const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
      assert.equal(ledger.runs[0].status, "failed");
      assert.match(ledger.runs[0].error, /existing artifact/);
    }
  } finally {
    v.cleanup();
  }
});

test("extractAssistantText rejects missing content and does not use reasoning fallback", () => {
  assert.throws(() => extractAssistantText({ choices: [{ message: { reasoning_content: "hidden" } }] }), /empty/);
  assert.equal(extractAssistantText({ choices: [{ message: { content: "ok".repeat(200) } }] }).length, 400);
});

test("defaultOutputPath uses stable weekly and daily paths", () => {
  assert.equal(defaultOutputPath("daily", "2026-07-29"), "00_Inbox/brief-2026-07-29.md");
  assert.equal(defaultOutputPath("weekly", "2026-07-29"), "10_Daily/weekly-W31-2026-07-29.md");
});

test("default ledger path lives in XDG state or ~/.local/state, not the vault", () => {
  assert.equal(defaultLedgerPath({ XDG_STATE_HOME: "/tmp/state" }), "/tmp/state/orbitos-synthesis/runs.json");
  assert.match(defaultLedgerPath({}), /\/\.local\/state\/orbitos-synthesis\/runs\.json$/);
});

test("dry-run never creates the default ledger", async () => {
  const v = tmpVault();
  const state = mkdtempSync(path.join(tmpdir(), "orbitos-state-"));
  try {
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    await runSynthesis({
      argv: ["daily", "--date", "2026-07-29"],
      vaultPath: v.root,
      stdout: () => {},
    });
    assert.equal(existsSync(path.join(state, "orbitos-synthesis", "runs.json")), false);
    if (old === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = old;
  } finally {
    v.cleanup();
    rmSync(state, { recursive: true, force: true });
  }
});

test("apply preflight retries clean ahead branch push before pull and LLM", async () => {
  const v = tmpVault();
  try {
    const commands = [];
    let llmCalled = false;
    const body = "稳定输出内容".repeat(80);
    await runSynthesis({
      argv: ["daily", "--apply", "--date", "2026-07-29", "--ledger", path.join(v.root, "runs.json")],
      vaultPath: v.root,
      secretProvider: async () => "key",
      llmClient: async () => {
        llmCalled = true;
        assert.equal(commands.some((c) => c.join(" ") === "pull --ff-only"), true);
        return { choices: [{ message: { content: body } }] };
      },
      gitRunner: async (argv) => {
        commands.push(argv);
        const key = argv.join(" ");
        if (key === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "", status: 0 };
        if (key === "status --porcelain") return { stdout: commands.some((c) => c[0] === "add") ? "A  00_Inbox/brief-2026-07-29.md\n" : "", stderr: "", status: 0 };
        if (key === "status --porcelain --branch") {
          const alreadyPushed = commands.some((c) => c.join(" ") === "push");
          return { stdout: alreadyPushed ? "## main...origin/main\n" : "## main...origin/main [ahead 1]\n", stderr: "", status: 0 };
        }
        if (key === "rev-parse HEAD") return { stdout: "abc123\n", stderr: "", status: 0 };
        return { stdout: "", stderr: "", status: 0 };
      },
    });
    assert.equal(llmCalled, true);
    assert.deepEqual(commands.map((c) => c.join(" ")).slice(0, 6), [
      "rev-parse --is-inside-work-tree",
      "status --porcelain",
      "status --porcelain --branch",
      "push",
      "status --porcelain --branch",
      "pull --ff-only",
    ]);
  } finally {
    v.cleanup();
  }
});

test("apply preflight blocks dirty vault before secret lookup or LLM", async () => {
  const v = tmpVault();
  try {
    let secretCalled = false;
    let llmCalled = false;
    await assert.rejects(
      () => runSynthesis({
        argv: ["daily", "--apply", "--date", "2026-07-29", "--ledger", path.join(v.root, "runs.json")],
        vaultPath: v.root,
        secretProvider: async () => { secretCalled = true; return "key"; },
        llmClient: async () => { llmCalled = true; },
        gitRunner: async (argv) => {
          if (argv.join(" ") === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "", status: 0 };
          if (argv.join(" ") === "status --porcelain") return { stdout: " M unrelated.md\n", stderr: "", status: 0 };
          return { stdout: "", stderr: "", status: 0 };
        },
      }),
      /dirty/,
    );
    assert.equal(secretCalled, false);
    assert.equal(llmCalled, false);
  } finally {
    v.cleanup();
  }
});

test("apply cleanup removes only new target when git add/status/commit fails before commit", async () => {
  const v = tmpVault();
  try {
    const ledgerFile = path.join(v.root, "runs.json");
    const body = "稳定输出内容".repeat(80);
    const commands = [];
    await assert.rejects(
      () => runSynthesis({
        argv: ["daily", "--apply", "--date", "2026-07-29", "--ledger", ledgerFile],
        vaultPath: v.root,
        secretProvider: async () => "key",
        llmClient: async () => ({ choices: [{ message: { content: body } }] }),
        gitRunner: async (argv) => {
          commands.push(argv);
          const key = argv.join(" ");
          if (key === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "", status: 0 };
          if (key === "status --porcelain --branch") return { stdout: "## main...origin/main\n", stderr: "", status: 0 };
          if (key === "pull --ff-only") return { stdout: "", stderr: "", status: 0 };
          if (key === "status --porcelain") return { stdout: commands.some((c) => c[0] === "add") ? "A  00_Inbox/brief-2026-07-29.md\n M unrelated.md\n" : "", stderr: "", status: 0 };
          return { stdout: "", stderr: "", status: 0 };
        },
      }),
      /outside target artifact/,
    );
    assert.equal(existsSync(path.join(v.root, "00_Inbox/brief-2026-07-29.md")), false);
    assert.equal(commands.some((c) => c.join(" ") === "restore --staged -- 00_Inbox/brief-2026-07-29.md"), true);
    const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
    assert.equal(ledger.runs[0].status, "failed");
    assert.match(ledger.runs[0].error, /outside target artifact/);
  } finally {
    v.cleanup();
  }
});

test("apply keeps local commit when push fails and records commit sha", async () => {
  const v = tmpVault();
  try {
    const ledgerFile = path.join(v.root, "runs.json");
    const body = "稳定输出内容".repeat(80);
    const commands = [];
    await assert.rejects(
      () => runSynthesis({
        argv: ["weekly", "--apply", "--date", "2026-07-29", "--ledger", ledgerFile],
        vaultPath: v.root,
        secretProvider: async () => "key",
        llmClient: async () => ({ choices: [{ message: { content: body } }] }),
        gitRunner: async (argv) => {
          commands.push(argv);
          const key = argv.join(" ");
          if (key === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "", status: 0 };
          if (key === "status --porcelain --branch") return { stdout: "## main...origin/main\n", stderr: "", status: 0 };
          if (key === "pull --ff-only") return { stdout: "", stderr: "", status: 0 };
          if (key === "status --porcelain") return { stdout: commands.some((c) => c[0] === "add") ? "A  10_Daily/weekly-W31-2026-07-29.md\n" : "", stderr: "", status: 0 };
          if (key === "rev-parse HEAD") return { stdout: "def456\n", stderr: "", status: 0 };
          if (key === "push") return { stdout: "", stderr: "rejected", status: 1 };
          return { stdout: "", stderr: "", status: 0 };
        },
      }),
      /git push failed/,
    );
    assert.equal(commands.some((c) => c[0] === "restore"), false);
    assert.equal(existsSync(path.join(v.root, "10_Daily/weekly-W31-2026-07-29.md")), true);
    const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
    assert.equal(ledger.runs[0].stage, "push");
    assert.equal(ledger.runs[0].commit_sha, "def456");
  } finally {
    v.cleanup();
  }
});

test("ledger redaction removes bare key tokens and URL credentials", async () => {
  const v = tmpVault();
  try {
    const ledgerFile = path.join(v.root, "runs.json");
    const fakeKey = "sk-testtokenvalue123456789";
    const fakeUser = "credential-user";
    const fakePassword = "credential-password";
    await assert.rejects(
      () => runSynthesis({
        argv: ["daily", "--apply", "--date", "2026-07-29", "--ledger", ledgerFile],
        vaultPath: v.root,
        secretProvider: async () => "key",
        llmClient: async () => {
          throw new Error(`request failed ${fakeKey} https://${fakeUser}:${fakePassword}@example.invalid/path`);
        },
        gitRunner: cleanGitRunner(),
      }),
      /request failed/,
    );
    const ledgerText = readFileSync(ledgerFile, "utf8");
    assert.equal(ledgerText.includes(fakeKey), false);
    assert.equal(ledgerText.includes(fakeUser), false);
    assert.equal(ledgerText.includes(fakePassword), false);
    assert.match(ledgerText, /REDACTED/);
  } finally {
    v.cleanup();
  }
});

test("apply validates date and HTTPS endpoint before LLM", async () => {
  const v = tmpVault();
  try {
    await assert.rejects(
      () => runSynthesis({
        argv: ["daily", "--apply", "--date", "2026-02-31"],
        vaultPath: v.root,
        secretProvider: async () => "key",
        llmClient: async () => { throw new Error("must not call"); },
        gitRunner: cleanGitRunner(),
      }),
      /real YYYY-MM-DD/,
    );

    let llmCalled = false;
    await assert.rejects(
      () => runSynthesis({
        argv: ["daily", "--apply", "--date", "2026-07-29", "--endpoint", "http://api.example.invalid/v1/chat/completions"],
        vaultPath: v.root,
        secretProvider: async () => "key",
        llmClient: async () => { llmCalled = true; },
        gitRunner: cleanGitRunner(),
      }),
      /HTTPS/,
    );
    assert.equal(llmCalled, false);
  } finally {
    v.cleanup();
  }
});

test("successful push still returns committed when ledger write fails", async () => {
  const v = tmpVault();
  try {
    const body = "稳定输出内容".repeat(80);
    const commands = [];
    const result = await runSynthesis({
      argv: ["weekly", "--apply", "--date", "2026-07-29", "--ledger", v.root],
      vaultPath: v.root,
      secretProvider: async () => "key",
      llmClient: async () => ({ choices: [{ message: { content: body } }] }),
      gitRunner: async (argv) => {
        commands.push(argv);
        const key = argv.join(" ");
        if (key === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "", status: 0 };
        if (key === "status --porcelain --branch") return { stdout: "## main...origin/main\n", stderr: "", status: 0 };
        if (key === "pull --ff-only") return { stdout: "", stderr: "", status: 0 };
        if (key === "status --porcelain") return { stdout: commands.some((c) => c[0] === "add") ? "A  10_Daily/weekly-W31-2026-07-29.md\n" : "", stderr: "", status: 0 };
        if (key === "rev-parse HEAD") return { stdout: "def456\n", stderr: "", status: 0 };
        return { stdout: "", stderr: "", status: 0 };
      },
    });
    assert.equal(result.status, "committed");
    assert.equal(result.ledgerWritten, false);
    assert.equal(existsSync(path.join(v.root, "10_Daily/weekly-W31-2026-07-29.md")), true);
    assert.equal(commands.some((c) => c[0] === "restore"), false);
  } finally {
    v.cleanup();
  }
});

test("default secret provider trims env override and keychain runner output", async () => {
  const old = process.env.DEEPSEEK_API_KEY;
  const oldFile = process.env.DEEPSEEK_API_KEY_FILE;
  process.env.DEEPSEEK_API_KEY = " env-key \n";
  assert.equal(await defaultSecretProvider(), "env-key");
  delete process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY_FILE = path.join(tmpdir(), `missing-orbitos-secret-${process.pid}`);
  const secret = await defaultSecretProvider("DEEPSEEK_API_KEY", {
    commandRunner: async (cmd, argv) => {
      assert.equal(cmd, "/usr/bin/security");
      assert.deepEqual(argv.slice(0, 2), ["find-generic-password", "-a"]);
      assert.equal(argv.includes("orbitos-deepseek-api-key"), true);
      return { status: 0, stdout: " keychain-key \n", stderr: "" };
    },
  });
  assert.equal(secret, "keychain-key");
  if (old === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = old;
  if (oldFile === undefined) delete process.env.DEEPSEEK_API_KEY_FILE;
  else process.env.DEEPSEEK_API_KEY_FILE = oldFile;
});

test("default secret provider reads only a protected secret file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "orbitos-secret-"));
  const file = path.join(root, "deepseek-api-key");
  const oldKey = process.env.DEEPSEEK_API_KEY;
  const oldFile = process.env.DEEPSEEK_API_KEY_FILE;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY_FILE = file;
    writeFileSync(file, " file-key \n", { encoding: "utf8", mode: 0o600 });
    chmodSync(file, 0o600);
    assert.equal(await defaultSecretProvider(), "file-key");

    chmodSync(file, 0o644);
    await assert.rejects(
      defaultSecretProvider(),
      /inaccessible to group and other users/,
    );
  } finally {
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldKey;
    if (oldFile === undefined) delete process.env.DEEPSEEK_API_KEY_FILE;
    else process.env.DEEPSEEK_API_KEY_FILE = oldFile;
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled instants use Asia/Shanghai daily 08:00 and weekly 10:00 boundaries", () => {
  assert.equal(scheduledInstantMs("daily", "2026-07-29"), new Date("2026-07-29T08:00:00+08:00").getTime());
  assert.equal(scheduledInstantMs("weekly", "2026-07-29"), new Date("2026-07-29T10:00:00+08:00").getTime());
});
