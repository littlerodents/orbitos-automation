import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildResultDailyPlan,
  buildResultWeeklyPlan,
  defaultOutputPath,
  extractAssistantText,
  renderArtifact,
  resolveDeepSeekTimeoutMs,
  runSynthesis,
  validateResultArtifact,
} from "../orbitos-synthesis.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "orbitos-result-vault-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "orbitos-result-evidence-"));
  for (const dir of ["10_Daily", "20_Project", "99_System/Prompts"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  writeFileSync(path.join(root, "99_System/Prompts/Result_Daily.md"), "RESULT DAILY SYSTEM", "utf8");
  writeFileSync(path.join(root, "99_System/Prompts/Result_Weekly.md"), "RESULT WEEKLY SYSTEM", "utf8");
  return {
    root,
    evidenceDir,
    writeVault(rel, content) {
      const file = path.join(root, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
    },
    writeEvidence(name, value) {
      writeFileSync(path.join(evidenceDir, name), JSON.stringify(value), "utf8");
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(evidenceDir, { recursive: true, force: true });
    },
  };
}

function validDailyBody() {
  return `## 1. 证据与最新事实
有可追溯的会议和工作记录，无法确认的时间明确记为 unknown。${"事实证据。".repeat(20)}

## 2. 今天结束时必须留下的结果
1. 交付一份可验收决策单，负责人和关闭证据齐全。
   验收标准：决策单包含决定、风险所有者和关闭条件。
   建议最晚时间：今日 22:00。
   下一负责人：Evander。

## 3. 取舍与 24 小时时间账本
原始估时两小时，按两倍量预留四小时；暂停低价值维护。

## 4. 思维模型强提醒
以终为始：今天需要的是签字决定，不是更多中间材料。

## 5. 其余相关模型
瓶颈与安全边际只在能改变交付决策时使用。

## 6. 能力与 Agent Team
做一次三十分钟的决策单练习，Agent 只负责证据归并。

## 7. 最小确认
今天唯一必须完成的结果是否就是这份决策单？`;
}

function validWeeklyBody() {
  return `## 1. 本周证据与结果
本周有七份日报作为证据，缺失项标记 unknown。${"周证据。".repeat(22)}

## 2. 承诺与交付差距
承诺三项，完成两项，一项因负责人未确定而阻塞。

## 3. 时间投向与取舍
按两倍量复盘后，停止继续扩张维护范围。

## 4. 重复瓶颈与思维模型
瓶颈是已知问题没有唯一所有者，而不是信息不足。

## 5. 下周必须留下的结果
1. 形成可签字的发布决定。
   验收标准：决定页包含放行状态和关闭证据。
   建议截止时间：下周五 18:00。
   负责人：Evander。
   降级方案：若 P0 未关闭则保持阻塞。

## 6. 停止清单与能力处方
停止泛读与重复评审，练习把风险写成可关闭条件。

## 7. 最小确认
下周的第一结果是否确认由发布决定承担？`;
}

test("DeepSeek report requests allow slow generations while bounding overrides", () => {
  assert.equal(resolveDeepSeekTimeoutMs(undefined), 180_000);
  assert.equal(resolveDeepSeekTimeoutMs("90000"), 90_000);
  assert.equal(resolveDeepSeekTimeoutMs("999"), 180_000);
  assert.equal(resolveDeepSeekTimeoutMs("not-a-number"), 180_000);
  assert.equal(resolveDeepSeekTimeoutMs("600001"), 180_000);
});

test("result daily plan uses only as-of evidence and treats it as untrusted data", () => {
  const f = fixture();
  try {
    f.writeVault("20_Project/PAI.md", "# PAI\n\nstatus: active\nowner: evander");
    f.writeVault("10_Daily/result-daily-2026-07-27.md", "# prior result\n\nPrior verified outcome.");
    f.writeEvidence("primary-2026-07-28.json", {
      source: "primary",
      facts: ["meeting decision recorded"],
      activity_time: { active_minutes_proxy: 17 },
      ai_work: {
        codex: [
          {
            project: "PAI",
            started_at: "2026-07-28T09:00:00.000Z",
            ended_at: "2026-07-28T18:00:00.000Z",
            outcome: "business decision prepared",
          },
          { project: "codex", outcome: "超级个体结果日报模板与共享结果契约接线 internal-only-candidate" },
        ],
        claude: [],
      },
    });
    f.writeEvidence("shadow-2026-07-29.json", {
      source: "shadow",
      facts: ["workflow test passed"],
      feishu: {
        calendar: [{
          summary: "Partner meeting",
          start: "2026-07-29T15:00:00+08:00",
          end: "2026-07-29T15:30:00+08:00",
          status: "accept",
        }],
      },
    });
    f.writeEvidence("primary-2026-07-30.json", { source: "future", facts: ["must never appear"] });
    f.writeVault("20_Project/stale/stale.md", "---\ncreated: 2026-05-01\nstatus: active\n---\n# Stale\n\nmust never compete today");

    const plan = buildResultDailyPlan({
      vaultPath: f.root,
      evidenceDir: f.evidenceDir,
      date: "2026-07-29",
      now: new Date("2026-07-29T12:30:00.000Z"),
    });

    assert.equal(plan.kind, "result-daily");
    assert.equal(plan.outputPath, "10_Daily/result-daily-2026-07-29.md");
    assert.equal(plan.systemPrompt, "RESULT DAILY SYSTEM");
    assert.equal(plan.counts.evidencePackets, 2);
    assert.equal(plan.counts.projects, 1);
    assert.match(plan.userContent, /UNTRUSTED EVIDENCE/);
    assert.match(plan.userContent, /REPORT GENERATED AT UTC: 2026-07-29T12:30:00.000Z/);
    assert.match(plan.userContent, /REPORT GENERATED AT ASIA\/SHANGHAI \(UTC\+08:00\): 2026-07-29T20:30:00.000\+08:00/);
    assert.match(plan.userContent, /self-reported summaries, not independent verification/);
    assert.match(plan.userContent, /project notes are context and may be stale/);
    assert.match(plan.userContent, /meeting decision recorded/);
    assert.match(plan.userContent, /workflow test passed/);
    assert.match(plan.userContent, /ended_before_report_generation/);
    assert.match(plan.userContent, /Partner meeting/);
    assert.match(plan.userContent, /calendar acceptance only/);
    assert.match(plan.userContent, /Agent self-reported outcome/);
    assert.match(plan.userContent, /withheld from result planning/);
    assert.doesNotMatch(plan.userContent, /active_minutes_proxy|2026-07-28T09:00:00.000Z|2026-07-28T18:00:00.000Z/);
    assert.match(plan.userContent, /Prior verified outcome/);
    assert.doesNotMatch(plan.userContent, /must never appear/);
    assert.doesNotMatch(plan.userContent, /must never compete today/);
    assert.doesNotMatch(plan.userContent, /internal-only-candidate/);
    assert.equal(plan.counts.filteredInternalSessions, 1);
    assert.deepEqual(plan.calendarFacts, [{
      summary: "Partner meeting",
      start: "2026-07-29T15:00:00+08:00",
      end: "2026-07-29T15:30:00+08:00",
      temporal_status_at_report_generation: "ended_before_report_generation",
    }]);
  } finally {
    f.cleanup();
  }
});

test("result weekly plan synthesizes the latest seven result dailies and excludes future reports", () => {
  const f = fixture();
  try {
    for (let day = 20; day <= 29; day++) {
      f.writeVault(`10_Daily/result-daily-2026-07-${day}.md`, `# Daily ${day}\n\nverified-result-${day}`);
    }
    f.writeVault("10_Daily/result-daily-2026-07-30.md", "# Future\n\nfuture-result");
    f.writeVault("20_Project/BIG.md", "# BIG\n\nstatus: active");

    const plan = buildResultWeeklyPlan({ vaultPath: f.root, date: "2026-07-29" });

    assert.equal(plan.kind, "result-weekly");
    assert.equal(plan.outputPath, "10_Daily/result-weekly-W31-2026-07-29.md");
    assert.equal(plan.systemPrompt, "RESULT WEEKLY SYSTEM");
    assert.equal(plan.counts.dailyReports, 7);
    assert.match(plan.userContent, /verified-result-23/);
    assert.match(plan.userContent, /verified-result-29/);
    assert.doesNotMatch(plan.userContent, /verified-result-20|verified-result-21|verified-result-22|future-result/);
  } finally {
    f.cleanup();
  }
});

test("result artifacts use explicit product titles and frontmatter", () => {
  assert.equal(defaultOutputPath("result-daily", "2026-07-29"), "10_Daily/result-daily-2026-07-29.md");
  assert.equal(defaultOutputPath("result-weekly", "2026-07-29"), "10_Daily/result-weekly-W31-2026-07-29.md");
  assert.match(renderArtifact({ kind: "result-daily", date: "2026-07-29", model: "m", text: validDailyBody() }), /# 超级个体结果日报 — 2026-07-29/);
  assert.match(renderArtifact({ kind: "result-weekly", date: "2026-07-29", week: 31, model: "m", text: validWeeklyBody() }), /# 超级个体结果周复盘 — W31 2026-07-29/);
});

test("result draft normalization downgrades unattributed deadlines to suggestions", () => {
  const draft = validDailyBody().replace(
    "1. 交付一份可验收决策单，负责人和关闭证据齐全。",
    "1. 交付一份可验收决策单 — 最晚时间：今日 22:00 — Evander。",
  );
  const normalized = extractAssistantText({ choices: [{ message: { content: draft } }] }, "result-daily");
  assert.match(normalized, /建议最晚时间：今日 22:00/);

  const decisionDraft = validDailyBody().replace(
    "有可追溯的会议和工作记录",
    "会议中七牛云明确表态可提供资源；有可追溯的会议和工作记录",
  );
  const attributed = extractAssistantText({ choices: [{ message: { content: decisionDraft } }] }, "result-daily");
  assert.match(attributed, /飞书 AI 纪要记载（未逐字稿核验）：会议中七牛云明确表态/);
});

test("result semantic gate accepts the contract and rejects legacy knowledge synthesis", () => {
  assert.equal(validateResultArtifact(validDailyBody(), "result-daily"), true);
  assert.equal(validateResultArtifact(validDailyBody().replace(
    "交付一份可验收决策单，负责人和关闭证据齐全。",
    "发送会议确认请求并保存送达证据。",
  ), "result-daily"), true);
  assert.equal(validateResultArtifact(validDailyBody().replace(
    "原始估时两小时，按两倍量预留四小时",
    "活跃分钟代理不是工时，不得用于推断深度工作或容量",
  ), "result-daily"), true);
  assert.equal(validateResultArtifact(validDailyBody().replace(
    "原始估时两小时，按两倍量预留四小时",
    "没有实测时长，原始估时与两倍计划量均为 unknown",
  ), "result-daily"), true);
  assert.equal(validateResultArtifact(validDailyBody().replace(
    "1. 交付一份可验收决策单，负责人和关闭证据齐全。",
    "- **结果：** 交付一份可验收决策单，负责人和关闭证据齐全。",
  ), "result-daily"), true);
  assert.equal(validateResultArtifact(validDailyBody().replace(
    "1. 交付一份可验收决策单，负责人和关闭证据齐全。",
    "- **结果 1：** 交付一份可验收决策单，负责人和关闭证据齐全。",
  ), "result-daily"), true);
  assert.equal(validateResultArtifact(validWeeklyBody(), "result-weekly"), true);
  assert.throws(
    () => validateResultArtifact(`${validDailyBody()}\n\n## CONNECTIONS\nold mode`, "result-daily"),
    /legacy knowledge heading/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(/## 3[^\n]+\n[\s\S]*?(?=\n## 4)/, ""), "result-daily"),
    /missing required section/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace("交付一份可验收决策单", "发出超级个体结果日报"), "result-daily"),
    /self-referential report outcome/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "交付一份可验收决策单，负责人和关闭证据齐全。",
      "重新运行一次超级个体日报生成并保存输出。",
    ), "result-daily"),
    /self-referential report outcome/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "交付一份可验收决策单，负责人和关闭证据齐全。",
      "向合作方发出清单，且对方回复收到视为发出成功。",
    ), "result-daily"),
    /third-party response a completion condition/,
  );
  assert.throws(
    () => validateResultArtifact(validWeeklyBody().replace(
      "形成可签字的发布决定",
      "生成并发送超级个体结果周复盘",
    ), "result-weekly"),
    /self-referential report outcome/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "1. 交付一份可验收决策单，负责人和关闭证据齐全。",
      "1. 结果一。\n2. 结果二。\n3. 结果三。\n4. 结果四。",
    ), "result-daily"),
    /between 1 and 3 outcomes/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "1. 交付一份可验收决策单，负责人和关闭证据齐全。",
      "1. 交付决策单 — 建议最晚 今天 18:30 Asia/Shanghai — Evander。",
    ), "result-daily", { date: "2026-07-29", generatedAt: "2026-07-29T12:30:00.000Z" }),
    /deadline earlier than report generation time/,
  );
  assert.equal(validateResultArtifact(validDailyBody().replace(
    "建议最晚时间：今日 22:00。",
    "建议最晚时间：下一个自然日 10:00 Asia/Shanghai。",
  ), "result-daily", { date: "2026-07-29", generatedAt: "2026-07-29T12:56:00.000Z" }), true);
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "原始估时两小时，按两倍量预留四小时",
      "结果一耗时 15 分钟实测，按两倍量预留 30 分钟",
    ), "result-daily"),
    /planning estimate as measured time/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "原始估时两小时，按两倍量预留四小时",
      "距离午夜还有 3 小时，两个结果不触发容量冲突",
    ), "result-daily"),
    /clock time as available capacity/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "交付一份可验收决策单，负责人和关闭证据齐全。",
      "验证 PAI 结果契约在真实新会话生效。",
    ), "result-daily"),
    /internal-maintenance outcome/,
  );
  assert.throws(
    () => validateResultArtifact(`${validDailyBody()}\n\n时区：CST`, "result-daily"),
    /ambiguous timezone/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "有可追溯的会议和工作记录",
      "Partner 会议尚未发生；有可追溯的会议和工作记录",
    ), "result-daily", {
      calendarFacts: [{ temporal_status_at_report_generation: "ended_before_report_generation" }],
    }),
    /contradicts deterministic calendar status/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "有可追溯的会议和工作记录",
      "参会者包括 Evander；有可追溯的会议和工作记录",
    ), "result-daily"),
    /unsupported attendance claim/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "有可追溯的会议和工作记录",
      "会议确认了算力支持；有可追溯的会议和工作记录",
    ), "result-daily"),
    /unqualified meeting-decision claim/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "有可追溯的会议和工作记录",
      "七牛云确认可提供算力；有可追溯的会议和工作记录",
    ), "result-daily"),
    /unqualified meeting-decision claim/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "原始估时两小时，按两倍量预留四小时",
      "活跃分钟代理 277，其中 244 分钟用于深度工作",
    ), "result-daily"),
    /activity proxy as work time/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "做一次三十分钟的决策单练习",
      "当前时间已偏晚，所以不做练习",
    ), "result-daily"),
    /clock time as available capacity/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "做一次三十分钟的决策单练习",
      "已接近当日末尾，所以不做练习",
    ), "result-daily"),
    /clock time as available capacity/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "1. 交付一份可验收决策单，负责人和关闭证据齐全。",
      "1. 交付一份可验收决策单 — 最晚时间：今日 22:00 — Evander。",
    ), "result-daily"),
    /unlabeled synthesized deadline/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "验收标准：决策单包含决定、风险所有者和关闭条件。",
      "完成说明：决策单包含决定、风险所有者和关闭条件。",
    ), "result-daily"),
    /outcome missing required field: 验收标准/,
  );
  assert.throws(
    () => validateResultArtifact(validDailyBody().replace(
      "1. 交付一份可验收决策单，负责人和关闭证据齐全。",
      "1. 决策单已发布并推送。",
    ), "result-daily"),
    /completed outcome lacks verification evidence/,
  );
});

test("result apply repairs one rejected draft then commits only the valid report", async () => {
  const f = fixture();
  const targetRel = "10_Daily/result-daily-2026-07-29.md";
  const target = path.join(f.root, targetRel);
  const commands = [];
  let calls = 0;
  const gitRunner = async (argv) => {
    commands.push(argv.join(" "));
    const key = argv.join(" ");
    if (key === "rev-parse --is-inside-work-tree") return { status: 0, stdout: "true\n", stderr: "" };
    if (key === "status --porcelain --branch") return { status: 0, stdout: "## main...origin/main\n", stderr: "" };
    if (key === "status --porcelain") return { status: 0, stdout: existsSync(target) ? `?? ${targetRel}\n` : "", stderr: "" };
    if (key === "pull --ff-only" || argv[0] === "add" || argv[0] === "commit" || argv[0] === "push") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (key === "rev-parse HEAD") return { status: 0, stdout: "repair123\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    const result = await runSynthesis({
      argv: ["result-daily", "--apply", "--date", "2026-07-29", "--ledger", path.join(f.evidenceDir, "ledger.json")],
      vaultPath: f.root,
      evidenceDir: f.evidenceDir,
      secretProvider: async () => "test-key",
      gitRunner,
      llmClient: async ({ messages }) => {
        calls++;
        if (calls === 2) {
          assert.match(messages.at(-1).content, /deterministic product gate/);
          assert.match(messages.at(-1).content, /Delete every outcome about this report/);
        }
        return {
          choices: [{ message: { content: calls === 1
            ? validDailyBody().replace("交付一份可验收决策单", "发送超级个体结果日报")
            : validDailyBody() } }],
        };
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.status, "committed");
    assert.match(readFileSync(target, "utf8"), /交付一份可验收决策单/);
    assert.doesNotMatch(readFileSync(target, "utf8"), /发送超级个体结果日报/);
    assert.ok(commands.includes("commit -m chore: result daily 2026-07-29 -- 10_Daily/result-daily-2026-07-29.md"));
  } finally {
    f.cleanup();
  }
});
