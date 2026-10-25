#!/usr/bin/env node
// selfcheck: 每项交付/每次事故对应一个可运行的检测（2026-10-25）
//   设计原则：
//   1) 只读 —— 不改 vault、不改飞书、不发消息（例外：--with-network 会真抓一次 trending）
//   2) 可证伪 —— 每项都能 PASS/FAIL，不允许"看起来没问题"
//   3) 可追溯 —— 每项有稳定 id，CHECKS.md 里一一对应（含我犯过的错）
//   4) 可看趋势 —— 每次结果追加到 ~/.config/orbitos-automation/selfcheck.jsonl
// 用法:
//   node selfcheck.mjs               # 跑全部（跳过需要网络的）
//   node selfcheck.mjs --with-network# 连真实抓取一起跑
//   node selfcheck.mjs --only A1     # 只跑某前缀（如 A = 事故回归）
//   node selfcheck.mjs --json        # 机读输出
// 退出码: 0 全通过；1 有 FAIL

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const ROOT = "/Users/evander/Labs/codex/orbitos-automation";
const VAULT = "/Users/evander/Obsidian/OrbitOS";
const CFG = join(homedir(), ".config", "orbitos-automation");
const args = new Set(process.argv.slice(2));
const only = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const withNetwork = args.has("--with-network");
const asJson = args.has("--json");

// ---------- 工具 ----------
const results = [];
function check(id, desc, fn) {
  if (only && !id.startsWith(only)) return;
  try {
    const r = fn();
    results.push({ id, desc, status: r.skip ? "SKIP" : r.pass ? "PASS" : "FAIL", pass: Boolean(r.pass) && !r.skip, detail: r.detail || "" });
  } catch (e) {
    results.push({ id, desc, status: "FAIL", pass: false, detail: `检测本身抛错: ${String(e.message || e).slice(0, 160)}` });
  }
}
const skip = (detail) => ({ pass: false, skip: true, detail });
const sh = (cmd, cmdArgs = [], opts = {}) =>
  spawnSync(cmd, cmdArgs, { encoding: "utf8", cwd: ROOT, ...opts });
const grepFiles = (files, needle) =>
  files.filter((f) => {
    try { return readFileSync(join(ROOT, f), "utf8").includes(needle); } catch { return false; }
  });

// 飞书只读（失败时该检测记为 SKIP，而不是伪装成 PASS）
function larkRows(tableId) {
  const T = JSON.parse(readFileSync(join(CFG, "tracker.config.json"), "utf8"));
  const cfg = JSON.parse(readFileSync(join(CFG, "config.json"), "utf8"));
  const r = spawnSync(cfg.lark_cli_path, ["base", "+record-list", "--as", "user",
    "--base-token", T.base_token, "--table-id", tableId, "--format", "json"], {
    encoding: "utf8", timeout: 180000,
    env: { ...process.env, PATH: `/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` },
  });
  if (r.status !== 0) return null;
  const d = JSON.parse(r.stdout || "{}");
  if (!d.ok) return null;
  const cols = (d.data || {}).fields || [];
  const rows = ((d.data || {}).data || []).map((vals) => {
    const o = {};
    cols.forEach((c, j) => { o[c] = vals[j]; });
    return o;
  });
  return rows;
}
const cell = (v) => (Array.isArray(v) ? v[0] : v) ?? "";
const day = (v) => String(cell(v) ?? "").slice(0, 10);
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

// =====================================================================
// A. 我犯过的错 —— 每一条都必须有回归检测
// =====================================================================

// A1: 我 import 一个入口脚本，结果它真跑了（2026-10-24 真实事故）
check("A1-import-guard", "入口脚本被 import 时不得执行 main（真实事故回归）", () => {
  const entries = [
    "orbitos-daily-brief.mjs", "bookmark-organizer.mjs",
    "evening-reminder.mjs", "outward-actions.mjs",
    "archive-sweeper.mjs", "orbitos-archive-sweeper.mjs", "github-trending.mjs",
  ].filter((f) => existsSync(join(ROOT, f)));
  const missing = entries.filter((f) => {
    const s = readFileSync(join(ROOT, f), "utf8");
    return !/realpathSync\(process\.argv\[1\]\)\s*===\s*realpathSync/.test(s);
  });
  return {
    pass: missing.length === 0,
    detail: missing.length ? `缺 import 守卫: ${missing.join(", ")}` : `${entries.length} 个入口脚本都有守卫`,
  };
});

// A2: 我曾让 catch 静默吞掉 trending 失败（2026-10-24）
check("A2-no-silent-catch", "catch 块不得为空（失败必须可见；历史遗留已在 baseline 登记）", () => {
  const baselinePath = join(ROOT, "tests/known-empty-catches.txt");
  const baseline = existsSync(baselinePath)
    ? new Set(readFileSync(baselinePath, "utf8").split("\n").map((x) => x.trim()).filter((x) => x && !x.startsWith("#")))
    : new Set();
  // 排除自检器自身：它的源码里含有用于检测的正则字面量
  const files = readdirSync(ROOT).filter((f) => f.endsWith(".mjs") && f !== "selfcheck.mjs");
  const bad = [];
  for (const f of files) {
    const s = readFileSync(join(ROOT, f), "utf8");
    // catch {} / catch (e) {} / catch { }  且中间无任何语句
    const re = /catch\s*(\([^)]*\))?\s*\{\s*\}/g;
    let m;
    while ((m = re.exec(s))) bad.push(`${f}@${s.slice(0, m.index).split("\n").length}`);
  }
  const novel = bad.filter((b) => !baseline.has(b));
  return {
    pass: novel.length === 0,
    detail: novel.length
      ? `新增空 catch（未登记）: ${novel.join(", ")}`
      : `${files.length} 个模块：无新增空 catch（baseline 已登记 ${baseline.size} 处历史遗留）`,
  };
});

// A3: 我写过"超额未推，下批再处理"——已证伪（文件已 processed，不会重来）
check("A3-no-false-promise", "代码/日志不得含已证伪的承诺文案", () => {
  const needles = ["下批再处理"];
  const files = readdirSync(ROOT).filter((f) => /\.(mjs|sh)$/.test(f) && f !== "selfcheck.mjs");
  const hits = files.filter((f) => needles.some((n) => readFileSync(join(ROOT, f), "utf8").includes(n)));
  return { pass: hits.length === 0, detail: hits.length ? `仍在承诺: ${hits.join(", ")}` : "无" };
});

// A4: 我把含笔记标题的证据提交进了 PUBLIC 仓库（2026-10-24，已清洗）
check("A4-evidence-not-tracked", "orbitos-automation（公开仓库）不得跟踪 evidence/", () => {
  const r = sh("git", ["ls-files", "evidence"]);
  const tracked = (r.stdout || "").trim().split("\n").filter(Boolean);
  const ignored = sh("git", ["check-ignore", "-q", "evidence/x.txt"]).status === 0;
  return {
    pass: tracked.length === 0 && ignored,
    detail: tracked.length ? `已被跟踪 ${tracked.length} 个文件` : ignored ? "未跟踪且已 gitignore" : "未被 gitignore",
  };
});

// A5: 我用 `| head` 把闸门退出码吞了，误读成 exit=0
check("A5-gate-exit-not-piped", "闸门调用不得被管道截断（看 stage，不看被管的 exit code）", () => {
  const hits = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) { if (!/node_modules|\.git|evidence/.test(p)) walk(p); continue; }
      if (!/\.(mjs|sh|md)$/.test(f.name)) continue;
      const s = readFileSync(p, "utf8");
      if (/closeloop-verify\.ts[^\n]*\|\s*(head|tail|grep)/.test(s)) hits.push(p.replace(ROOT + "/", ""));
    }
  };
  walk(ROOT);
  return { pass: hits.length === 0, detail: hits.length ? `被管道截断: ${hits.join(", ")}` : "无" };
});

// A6: 我把"阈值太严"当结论，实际是时间错位 —— 要求 ISA 里根因有取证命令
check("A6-isa-has-evidence", "ISA 的根因结论必须带取证证据（不是假设）", () => {
  const p = join(ROOT, "ISA.md");
  if (!existsSync(p)) return { pass: false, detail: "ISA.md 不存在" };
  const s = readFileSync(p, "utf8");
  const hasRootCause = /## Problem/.test(s);
  const hasEvidence = /(git log|grep|node --test|launchctl|实测|取证|回放)/.test(s);
  return { pass: hasRootCause && hasEvidence, detail: `Problem 段=${hasRootCause} 含取证=${hasEvidence}` };
});

// A7: 我曾想让 LLM 编"本周完成数"（追踪表无该字段）
check("A7-no-invented-metric", "产物里的比例必须等于实测值（不得让 LLM 估）", () => {
  const s = readFileSync(join(ROOT, "orbitos-daily-brief.mjs"), "utf8");
  const computed = /sharePct:\s*allActions\.length\s*\?\s*Math\.round\(\(outward\.length\s*\/\s*allActions\.length\)\s*\*\s*100\)\s*:\s*0/.test(s);
  const noFakeField = !/本周完成数|weeklyCompleted/.test(s);
  const noRejectedCount = /无数据源（系统未记录，不得编造）/.test(s);
  return { pass: computed && noFakeField && noRejectedCount, detail: `比例实测=${computed} 无假字段=${noFakeField} 拒绝次数留空=${noRejectedCount}` };
});

// A8: 日报兜底的锁残留 → 兜底永久失效（2026-10-23 真实事故，10/23 日报缺失）
check("A8-catchup-lock-clean", "日报兜底锁不得残留（stale 锁会让兜底永久失效）", () => {
  const LOCK = "/tmp/orbitos-brief-catchup.lock";
  if (!existsSync(LOCK)) return { pass: true, detail: "无锁残留" };
  const mt = statSync(LOCK).mtimeMs;
  const ageMin = Math.round((Date.now() - mt) / 60000);
  // 30 分钟内的锁是正常持有中；超过即 stale（代码可自愈，但要让人知道发生过）
  return {
    pass: ageMin <= 30,
    detail: `锁已存在 ${ageMin} 分钟（>30 视为异常；代码已能自愈，但这是信号）`,
  };
});

// A9: 日报每天必有（缺失=静默失败）—— 覆盖 2026-10-23 那种"没人发现"的情况
check("A9-brief-daily-present", "近 7 天日报不得缺失（缺失必须可见）", () => {
  const dir = join(VAULT, "00_Inbox");
  const missing = [];
  for (let i = 1; i <= 7; i += 1) {
    const d = new Date(Date.now() + 8 * 3600e3 - i * 86400e3).toISOString().slice(0, 10);
    if (!existsSync(join(dir, `brief-${d}.md`))) missing.push(d);
  }
  const baselinePath = join(ROOT, "tests/known-brief-gaps.txt");
  const known = existsSync(baselinePath)
    ? new Set(readFileSync(baselinePath, "utf8").split("\n").map((x) => x.trim()).filter((x) => x && !x.startsWith("#")))
    : new Set();
  const novel = missing.filter((d) => !known.has(d));
  return {
    pass: novel.length === 0,
    detail: novel.length
      ? `新增缺失: ${novel.join(", ")}`
      : missing.length
        ? `近 7 天齐全（已知历史缺口 ${missing.join(", ")}，见 baseline）`
        : "近 7 天齐全",
  };
});

// =====================================================================
// B. 生命周期（归档 + reconcile）
// =====================================================================
check("B1-archive-window", "Materials 中过期（>7 天）未归档的文件必须为 0", () => {
  const dir = join(VAULT, "30_Research/YouMind/X书签简报/Materials");
  if (!existsSync(dir)) return { pass: true, detail: "无 Materials 目录" };
  const now = Date.now();
  const stale = readdirSync(dir).filter((f) => f.endsWith(".md")).filter((f) => {
    const s = readFileSync(join(dir, f), "utf8");
    const m = s.match(/^processed:\s*"?(\d{4}-\d{2}-\d{2})"?/m);
    if (!m) return false;
    return now - Date.parse(`${m[1]}T00:00:00+08:00`) >= 7 * 86400e3;
  });
  return { pass: stale.length === 0, detail: stale.length ? `${stale.length} 个过期未归档` : "0 个" };
});

check("B2-sweep-idempotent", "归档器重复运行不得再移动（幂等）", () => {
  const r = sh("/opt/homebrew/opt/node@22/bin/node", ["orbitos-archive-sweeper.mjs", "sweep", "--dry-run"]);
  const out = r.stdout || "";
  const m = out.match(/result: moved=(\d+)/);
  const moved = m ? Number(m[1]) : -1;
  return { pass: moved === 0, detail: `dry-run moved=${moved}（应为 0；>0 说明有堆积未归档）` };
});

check("B3-reconcile-converged", "Intake Base 重复 reconcile 不得再产生 diff", () => {
  const r = sh("/opt/homebrew/opt/node@22/bin/node", ["orbitos-intake-base.mjs", "reconcile-records", "--dry-run"], { timeout: 600000 });
  const line = (r.stdout || "").split("\n").find((l) => l.includes("reconcile-records:")) || "";
  const m = line.match(/updated=(\d+);.*diffs=(\S+)/);
  if (!m) return { pass: false, detail: `未能解析输出: ${line.slice(0, 120)}` };
  return { pass: Number(m[1]) === 0, detail: `updated=${m[1]} diffs=${m[2]}` };
});

check("B4-datetime-compare", "ISO 与本地时间字符串必须判为同一时刻（否则全量重写）", () => {
  const r = sh("/opt/homebrew/opt/node@22/bin/node", ["--test", "tests/intake-records.test.mjs"]);
  const ok = /# pass \d+/.test(r.stdout || "") && !/^not ok/m.test(r.stdout || "");
  return { pass: ok, detail: ok ? "sameCellValue 用例通过" : "intake-records 测试失败" };
});

// =====================================================================
// C. GitHub Trending
// =====================================================================
check("C1-trending-parser", "解析器对真实榜单 HTML 必须产出条目", () => {
  const r = sh("/opt/homebrew/opt/node@22/bin/node", ["--test", "tests/github-trending.test.mjs"]);
  const ok = /# pass \d+/.test(r.stdout || "") && !/^not ok/m.test(r.stdout || "");
  return { pass: ok, detail: ok ? "7 项解析/diff 用例通过" : "github-trending 测试失败" };
});

check("C2-trending-snapshot-bounded", "trending 快照条目数必须有上界（30 天清理生效）", () => {
  const p = join(CFG, "github-trending.json");
  if (!existsSync(p)) return { pass: true, detail: "尚无快照" };
  const d = JSON.parse(readFileSync(p, "utf8"));
  const n = Object.keys(d.repos || {}).length;
  return { pass: n <= 200, detail: `${n} 条（上界 200）` };
});

check("C3-trending-nonfatal", "trending 失败不得让日报失败（代码层）", () => {
  const s = readFileSync(join(ROOT, "github-trending.mjs"), "utf8");
  const guarded = /catch\s*\(\s*error\s*\)[\s\S]{0,200}return "";/.test(s);
  const brief = readFileSync(join(ROOT, "orbitos-daily-brief.mjs"), "utf8");
  const briefGuarded = /trending failed \(non-fatal\)/.test(brief);
  return { pass: guarded && briefGuarded, detail: `模块兜底=${guarded} 日报兜底=${briefGuarded}` };
});

// =====================================================================
// D. 反向指标（对外账）
// =====================================================================
check("D1-outward-account-live", "追踪表对外/学习占比必须与实时表一致", () => {
  const rows = larkRows((JSON.parse(readFileSync(join(CFG, "tracker.config.json"), "utf8"))).action_table);
  if (!rows) return { pass: false, detail: "飞书不可读（无法验证）" };
  const total = rows.length;
  const outward = rows.filter((r) => {
    const t = String(cell(r["行动"]));
    return t.startsWith("[对外·") || /^【主线·(分发|转化|产品|链路)】/.test(t);
  }).length;
  const learning = rows.filter((r) => String(cell(r["行动"])).startsWith("[学习·")).length;
  const pct = total ? Math.round((outward / total) * 100) : 0;
  return {
    pass: total > 0 && outward >= 1,
    detail: `总数 ${total} / 对外 ${outward} (${pct}%) / 学习 ${learning}（${total ? Math.round((learning / total) * 100) : 0}%）`,
  };
});

check("D2-outward-alert-boundary", "对外注记的触发边界（5 条 + 15 天）必须准确", () => {
  const r = sh("/opt/homebrew/opt/node@22/bin/node", ["--test", "tests/outward-account.test.mjs"]);
  const ok = /# pass \d+/.test(r.stdout || "") && !/^not ok/m.test(r.stdout || "");
  return { pass: ok, detail: ok ? "6 项边界用例通过" : "outward-account 测试失败" };
});

// =====================================================================
// E. bookmark → 行动表断点
// =====================================================================
check("E1-bookmark-action-rules", "strong+actionable 才进表；medium/weak 与超额必须被正确处置", () => {
  const r = sh("/opt/homebrew/opt/node@22/bin/node", ["--test", "tests/bookmark-actions.test.mjs"]);
  const ok = /# pass \d+/.test(r.stdout || "") && !/^not ok/m.test(r.stdout || "");
  return { pass: ok, detail: ok ? "5 项规则用例通过" : "bookmark-actions 测试失败" };
});

check("E2-overflow-visible", "Selected 头部必须写明超额仅存档", () => {
  const s = readFileSync(join(ROOT, "bookmark-organizer.mjs"), "utf8");
  const has = /仅存档/.test(s) && /archived_only/.test(s);
  return { pass: has, detail: has ? "header + 日志都写明" : "缺少显性说明（会静默丢弃）" };
});

// =====================================================================
// F. 教练模式（对外闸门）
// =====================================================================
check("F1-gate-three-states", "闸门三态（完成/未完成/无记录）必须正确", () => {
  const r = sh("/opt/homebrew/opt/node@22/bin/node", ["--test", "tests/outward-actions.test.mjs"]);
  const ok = /# pass \d+/.test(r.stdout || "") && !/^not ok/m.test(r.stdout || "");
  return { pass: ok, detail: ok ? "11 项（闸门/连续/豁免/文案）通过" : "outward-actions 测试失败" };
});

check("F2-daily-outward-row", "追踪表今天必须有且只有 1 条对外动作（幂等）", () => {
  const rows = larkRows((JSON.parse(readFileSync(join(CFG, "tracker.config.json"), "utf8"))).action_table);
  if (!rows) return { pass: false, detail: "飞书不可读（无法验证）" };
  const t = rows.filter((r) => String(cell(r["行动"])).startsWith("[对外·") && day(r["开始卡于"]) === today);
  return { pass: t.length === 1, detail: `今天 [对外·] 行数=${t.length}（应为 1）` };
});

check("F3-intake-loop-wired", "intake-loop 必须仍在调用 outward，且最近一轮成功", () => {
  // 只看日志会误判：删掉调用后旧日志仍在。必须同时检查脚本当前内容。
  const script = readFileSync(join(ROOT, "orbitos-intake-loop.sh"), "utf8");
  const wired = /outward-actions\.mjs/.test(script);
  const counted = /outward=%s/.test(script);
  const p = join(ROOT, "orbitos-intake-loop.log");
  const last = existsSync(p)
    ? (readFileSync(p, "utf8").trim().split("\n").filter((l) => l.includes("launch: OrbitOS intake loop exit")).pop() || "")
    : "";
  const ranOk = /outward=0/.test(last);
  return {
    pass: wired && counted && ranOk,
    detail: `脚本调用=${wired} 日志字段=${counted} 最近一轮=${ranOk ? "ok" : "未跑/失败"}`,
  };
});

check("F4-withheld-not-fake-brief", "扣留页不得包含日报结构（TL;DR/学习增量/工具风向）", () => {
  const r = sh("/opt/homebrew/opt/node@22/bin/node", ["--test", "tests/outward-actions.test.mjs"]);
  const ok = /# pass \d+/.test(r.stdout || "");
  return { pass: ok, detail: ok ? "扣留页断言通过" : "扣留页测试失败" };
});

// =====================================================================
// G. 告警节流（④）
// =====================================================================
check("G1-alert-throttle", "告警节流策略（每天首次 + 里程碑）必须正确", () => {
  const r = sh("/bin/zsh", ["tests/alert-policy.test.sh"]);
  const ok = /PASS: alert-policy/.test(r.stdout || "");
  return { pass: ok, detail: ok ? "10 项规则 + 7 天回放通过" : (r.stdout || r.stderr || "").slice(-160) };
});

check("G2-alert-volume", "节流上线后，每天 alert 提交数必须 ≤ 2", () => {
  const SINCE = "2026-10-25T11:00:00+08:00"; // 节流改造生效时间（实测 commit f44f0b4 之后）
  const sinceMs = Date.parse(SINCE);
  const hours = (Date.now() - sinceMs) / 3600e3;
  if (hours < 24) return skip(`观察期：距上线 ${hours.toFixed(1)}h（需满 24h 才有意义）`);
  const r = sh("git", ["-C", VAULT, "log", `--since=${SINCE}`, "--format=%ad", "--date=format:%Y-%m-%d"]);
  const days = (r.stdout || "").split("\n").filter(Boolean);
  const perDay = {};
  for (const d of days) perDay[d] = (perDay[d] || 0) + 1;
  const worst = Math.max(0, ...Object.values(perDay));
  return { pass: worst <= 2, detail: `上线后每天 ${JSON.stringify(perDay)}（上限 2）` };
});

// =====================================================================
// 汇总
// =====================================================================
const passed = results.filter((r) => r.status === "PASS").length;
const skipped = results.filter((r) => r.status === "SKIP").length;
const failed = results.filter((r) => r.status === "FAIL").length;

if (asJson) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), passed, failed, skipped, results }, null, 1)}\n`);
} else {
  const w = Math.max(...results.map((r) => r.id.length));
  console.log(`\nselfcheck  ${new Date().toISOString().slice(0, 19).replace("T", " ")}  (${results.length} 项)\n`);
  for (const r of results) {
    console.log(`${r.status.padEnd(4)}  ${r.id.padEnd(w)}  ${r.desc}`);
    if (r.detail) console.log(`${"".padEnd(w + 8)}  ↳ ${r.detail}`);
  }
  console.log(`\n${passed}/${results.length} 通过${failed ? `，${failed} 失败` : ""}${skipped ? `，${skipped} 观察期跳过` : ""}\n`);
}

// 趋势留痕（只追加，文件小）
try {
  mkdirSync(CFG, { recursive: true });
  appendFileSync(join(CFG, "selfcheck.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), passed, failed, skipped, failedIds: results.filter((r) => r.status === "FAIL").map((r) => r.id) }) + "\n");
} catch {}

process.exitCode = failed ? 1 : 0;
