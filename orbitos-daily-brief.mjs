#!/usr/bin/env node
// orbitos-daily-brief: 本地复活日报/周报（原 n8n 云端 workflow 的本地替代）
//   输入(全本地): 24h 内新书签整理、7 天 Selected 未读、行动队列、活跃项目、monitor 摘要
//   → DeepSeek 按 99_System/Prompts/Daily_Brief.md 的格式写 00_Inbox/brief-<date>.md
//   → git commit "chore: daily brief <date>"（brief-push 检测该提交并送飞书 DM）
//   → 顺带重写 Today.md
// 手动: node orbitos-daily-brief.mjs [--weekly]
// 定时: com.evander.orbitos-daily-brief.plist（工作日 08:00）/ weekly（周日 10:00）

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.mjs";
import { gatherTrendingForBrief } from "./github-trending.mjs";

const TRACKER_URL = "https://awvzqp87lyb.feishu.cn/base/LyUQbzSEPaGVmFs8ezScDyVhn1e";

// 行动数据源 = 飞书追踪表（唯一权威）；launchd 无 PATH 需注入
const SAFE_PATH = `/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/Users/evander/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`;
function larkJson(args) {
  const r = spawnSync(cfg.lark_cli_path, [...args, "--as", "user", "--format", "json"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${SAFE_PATH}:${process.env.PATH || ""}` },
  });
  if (r.status !== 0) return null;
  try {
    const out = JSON.parse(r.stdout);
    return out.ok ? (out.data ?? out) : null;
  } catch { return null; }
}

function actionsFromTracker() {
  try {
    const T = JSON.parse(readFileSync(join(homedir(), ".config/orbitos-automation/tracker.config.json"), "utf8"));
    const d = larkJson(["base", "+record-list", "--base-token", T.base_token, "--table-id", T.action_table]);
    if (!d) return [];
    const cols = d.fields || [];
    const ai = cols.indexOf("行动"), si = cols.indexOf("状态"), di = cols.indexOf("开始卡于"), ri = cols.indexOf("为什么这么做");
    const todayMs = Date.now() + 8 * 3600e3;
    return (d.data || []).map(vals => {
      const start = String((Array.isArray(vals[di]) ? vals[di][0] : vals[di]) || "").slice(0, 10);
      const startMs = start ? new Date(`${start}T00:00:00+08:00`).getTime() : todayMs;
      const age = Math.max(0, Math.floor((todayMs - startMs) / 86400e3));
      return {
        text: (Array.isArray(vals[ai]) ? vals[ai][0] : vals[ai]) || "",
        status: (Array.isArray(vals[si]) ? vals[si][0] : vals[si]) || "未动",
        rationale: String((Array.isArray(vals[ri]) ? vals[ri][0] : vals[ri]) || ""),
        start,
        age,
      };
    });
  } catch { return []; }
}

const cfg = loadConfig();
const DS_KEY = process.env.DEEPSEEK_API_KEY || cfg.deepseek_api_key || "";
const VAULT = cfg.vault_path;
const weekly = process.argv.includes("--weekly");
// 2026-10-24 加：无副作用验证（不写 vault、不 commit、不调 tracker/飞书）
const dryRun = process.argv.includes("--dry-run");

async function withRetry(fn, attempts = 3, baseMs = 1000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw lastErr;
}

async function callDeepSeek(messages) {
  return withRetry(async () => {
    const resp = await fetch(cfg.deepseek_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${DS_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.deepseek_model, messages, temperature: 0.4 }),
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`deepseek: ${resp.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  });
}

function readHead(p, max = 1800) {
  try { return readFileSync(p, "utf8").slice(0, max); } catch { return ""; }
}

function filesNewerThan(dir, days, filter = () => true) {
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - days * 86400e3;
  return readdirSync(dir)
    .filter(f => f.endsWith(".md") && filter(f))
    .map(f => ({ f, p: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .filter(x => x.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime);
}

async function gatherInputs() {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);

  // 1. 书签整理产物（Selected/bookmarks-*.md，7 天内）
  const bookmarkNotes = filesNewerThan(join(VAULT, "30_Research/Selected"), weekly ? 7 : 2, f => f.startsWith("bookmarks-"))
    .map(x => `--- ${x.f} ---\n${readHead(x.p)}`);

  // 2. 其他 Selected 未读（researcher/analyst 产物）
  const selectedNotes = filesNewerThan(join(VAULT, "30_Research/Selected"), 7, f => !f.startsWith("bookmarks-"))
    .map(x => `--- ${x.f} ---\n${readHead(x.p, 1200)}`);

  // 3. 行动表（飞书追踪表，唯一权威；卡龄降序 = 最老的最优先）
  const allActions = actionsFromTracker();
  const actions = allActions.filter(a => a.status === "未动" || a.status === "进行中")
    .filter(a => !a.text.startsWith("[学习·"))
    .sort((a, b) => b.age - a.age);
  const learningActions = allActions.filter(a => a.text.startsWith("[学习·"));
  const doneN = allActions.filter(a => a.status === "已完成").length;
  const actionLines = actions.slice(0, 6)
    .map(a => `- [${a.start ? a.start.slice(5).replace("-", "/") + " 卡起" : "新入"}·${a.age}天] ${a.text}\n  依据: ${(a.rationale || "（未记录——在飞书表'为什么这么做'列补上）").replace(/\n/g, " ⏎ ")}`)
    .join("\n");
  const learningLines = learningActions
    .map(a => `- ${a.text}`)
    .join("\n");

  // 3b. 对外账（反向指标，2026-10-24）：全部从追踪表实测，无数据源的一律标"未记录"
  const OUTWARD_PREFIXES = ["【主线·分发】", "【主线·转化】", "【主线·产品】", "【主线·链路】"];
  const outward = allActions.filter(a => OUTWARD_PREFIXES.some(p => a.text.startsWith(p)));
  const outwardStuck = outward.filter(a => a.status === "未动" || a.status === "进行中");
  const outwardDone = outward.filter(a => a.status === "已完成");
  const outwardOldest = outwardStuck.slice().sort((a, b) => b.age - a.age)[0] || null;
  const outwardAccount = {
    total: allActions.length,
    outwardTotal: outward.length,
    outwardDone: outwardDone.length,
    outwardStuck: outwardStuck.length,
    learningTotal: learningActions.length,
    oldestAge: outwardOldest?.age ?? 0,
    oldestText: (outwardOldest?.text || "").slice(0, 60),
    sharePct: allActions.length ? Math.round((outward.length / allActions.length) * 100) : 0,
    learningPct: allActions.length ? Math.round((learningActions.length / allActions.length) * 100) : 0,
  };

  // 4. 活跃项目名
  const projDir = join(VAULT, "20_Project");
  const projects = existsSync(projDir)
    ? readdirSync(projDir).flatMap(e => {
        const p = join(projDir, e);
        if (e.endsWith(".md")) return [e.replace(/\.md$/, "")];
        try { return readdirSync(p).filter(f => f.endsWith(".md")).map(f => e); } catch { return []; }
      })
    : [];

  // 5. 原始书签增量（未处理数）
  const matsDir = join(VAULT, "30_Research/YouMind/X书签简报/Materials");
  let pendingBookmarks = 0;
  if (existsSync(matsDir)) {
    pendingBookmarks = readdirSync(matsDir).filter(f => f.endsWith(".md") && !readHead(join(matsDir, f), 400).includes("processed:")).length;
  }

  return { dateStr, bookmarkNotes, selectedNotes, actionLines, learningLines, doneN, projects, pendingBookmarks, trendingLines: "", outwardAccount };
}

// 6. GitHub Trending（开发者工具风向）——单独异步取，失败不拖垮日报
// 对外账的机械注记：不依赖 LLM 是否听话，条件命中就由系统直接写进周报
export function outwardAlertLine(a) {
  if (!a || !a.total) return "";
  if (!(a.outwardStuck >= 5 && a.oldestAge > 14)) return "";
  return `> ⚠️ 系统实测（非模型判断）：对外动作 ${a.outwardStuck} 条未动，最久 ${a.oldestAge} 天；学习类占追踪表 ${a.learningPct}%。本周真正卡住的是对外动作。`;
}

async function attachTrending(inp) {
  if (weekly) return inp; // 周报不加（避免把"本周热门"当商业趋势）
  try {
    inp.trendingLines = await gatherTrendingForBrief({ today: inp.dateStr });
  } catch (e) {
    console.error(`trending failed (non-fatal): ${String(e.message || e).slice(0, 200)}`);
    inp.trendingLines = "";
  }
  return inp;
}

const SYSTEM = `你是 Evander 的 vault 思考伙伴。为 OrbitOS 写${weekly ? "周报" : "日报"}。不要拒绝，不要解释你是谁，直接写正文。
OrbitOS 是极简系统：飞书是提醒面，Obsidian 存精选。他在意的主线：一人公司(OPC)落地、程序化SEO、个人AI基础设施、AI agent 工程。
格式（严格遵守）：
## TL;DR
一句话，≤30 个汉字，**今天 5 分钟内能启动的具体动作**（打开什么网站/文件、写下什么、发布什么），禁止抽象口号（如"完成发布""持续推进"这类空话必须换成具体第一步）。
## 行动提醒
从行动表里挑 2-3 项最该动的（卡得越久越优先）。每项按四段写：
1. **第一步**：打开哪个网址/文件、做什么、几分钟（行动文本里已带，复述强化）。
2. **为什么**：背景一句话（依据栏有现成答案）。
3. **最优吗**：如果有更优路径或已对比过的替代方案，直说；没有就不编。
4. **时间账**：花几分钟 vs 已经卡了多少天；若沉没成本已超收益（价值衰减、窗口过期），直接建议把状态改「已放弃」——放弃也是完成决策，不要为了催而催。
## 学习增量
${weekly ? "本周" : "今日"}三线学习清单（直接照着读，每条带原文链接和分钟数）——从用户消息的「${weekly ? "本周" : "今日"}学习行动」区原样列出；该区为空则写「（今日学习行动未生成——见行动追踪表）」。
另外可补充书签整理/研究笔记里最值得精读的 ≤2 条：标题 + 一句话理由 + wikilink。没有就说没有，不要编。
## CONNECTIONS
书签/研究/项目之间 ≤3 个真实连接，用 [[wikilink]]。不足 3 个就诚实说。
${weekly ? `## 对外账
用「对外账」区的实测数字回答一个问题：**这周我让谁看见了我？**
必须包含：
1. 对外动作在追踪表里的占比（用原数字，如 7/76=9%），对比学习类占比。
2. 未动的对外动作几条、最久卡了几天、第一条是什么。
3. 一行：\`被拒绝/被批评/被忽视：\` 后面只写「未记录（系统无数据源）」，**绝对禁止编造次数**。
硬规则：
- 数字只能引用「对外账」区给的值，不得推算或模糊化。
- 如果未动的对外动作 ≥ 5 且最久 > 14 天，必须在 TL;DR 或本段第一句直说：本周真正卡住的是对外动作，不是学习。
- 禁止安抚式措辞（「已经很努力」「方向是对的」「持续积累中」「别焦虑」）。只陈述事实与代价。
` : ""}${weekly ? "" : `## 工具风向
只在这批 trending 里有**和你主线直接相关**的东西（skill/plugin/agent 基础设施）时写，≤3 行，每行：repo + 一句话为什么和你有关。
硬规则：
- 这是开发者工具榜，不是市场/生意信号 —— 禁止从它推导商业趋势、用户需求、SEO 机会。
- 没有相关项就写「今日无相关」，不要硬凑；不要罗列排名；不要复述 star 数。
- 不存在的项不要编。
`}## PATTERN
一个正在变得清晰的偏好/模式，2-4 句。`;

async function main() {
  if (!DS_KEY) { console.error("no deepseek key"); process.exit(1); }
  const inp = await attachTrending(await gatherInputs());
  if (dryRun) console.log(`[dry-run] trending lines: ${inp.trendingLines ? inp.trendingLines.split("\n").length + " 行" : "（空）"}`);

  if (!inp.bookmarkNotes.length && !inp.selectedNotes.length && weekly === false) {
    // 无新料也照发：行动提醒本身就是价值
  }

  const user = `今天是 ${inp.dateStr}${weekly ? "（周报）" : "（工作日日报）"}。
活跃项目: ${inp.projects.join(", ") || "无"}
未处理书签积压: ${inp.pendingBookmarks} 条
行动完成度: ${inp.doneN} 项已完成

### 行动表（按卡龄降序，前 6）
${inp.actionLines || "（空）"}

### 今日学习行动（三线：Agent / PG / 独立开发）
${inp.learningLines || "（未生成）"}

### 最近书签整理产物
${inp.bookmarkNotes.join("\n\n") || "（无新增）"}

### 最近研究精选笔记
${inp.selectedNotes.join("\n\n") || "（无新增）"}
${weekly ? `\n### 对外账（系统从追踪表实测，非估算）
- 追踪表总数: ${inp.outwardAccount.total}
- 对外类动作（分发/转化/产品/链路）: ${inp.outwardAccount.outwardTotal} 条，占 ${inp.outwardAccount.sharePct}%
- 其中已完成: ${inp.outwardAccount.outwardDone}；未动/进行中: ${inp.outwardAccount.outwardStuck}
- 最久未动的对外动作: ${inp.outwardAccount.oldestAge} 天 —— ${inp.outwardAccount.oldestText}
- 学习类动作: ${inp.outwardAccount.learningTotal} 条，占 ${inp.outwardAccount.learningPct}%
- 被拒绝/被批评次数: 无数据源（系统未记录，不得编造）
` : ""}
### GitHub Trending（今日开发者工具榜；仅供判断工具生态，不是商业信号）
${inp.trendingLines || "（未取到）"}

写出${weekly ? "周报" : "日报"}正文（从 ## TL;DR 开始，不要自己加一级标题）。`;

  const resp = await callDeepSeek([
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ]);
  const body = (resp.choices?.[0]?.message?.content || "").trim();
  if (!body.startsWith("## TL;DR")) { console.error("LLM 输出格式异常，放弃:\n", body.slice(0, 300)); process.exit(1); }

  const tldr = body.match(/## TL;DR\n(.+)/)?.[1]?.trim() || "";

  if (dryRun) {
    console.log(`[dry-run] 将写入 ${weekly ? "10_Daily" : "00_Inbox"}；不落盘、不 commit、不调 tracker`);
    console.log(`[dry-run] TL;DR: ${tldr}`);
    console.log(`[dry-run] 正文 ${body.length} 字，含工具风向段: ${/## 工具风向/.test(body)}`);
    if (/## 工具风向[\s\S]*?(?=\n## |$)/.test(body)) {
      console.log("[dry-run] 工具风向段内容:\n" + body.match(/## 工具风向[\s\S]*?(?=\n## |$)/)[0]);
    }
    if (/## 对外账[\s\S]*?(?=\n## |$)/.test(body)) {
      console.log("[dry-run] 对外账段内容:\n" + body.match(/## 对外账[\s\S]*?(?=\n## |$)/)[0]);
    } else if (weekly) {
      console.log("[dry-run] ✗ 缺 ## 对外账 段");
    }
    console.log(`[dry-run] 实测对外数据: ${JSON.stringify(inp.outwardAccount)}`);
    const alert = outwardAlertLine(inp.outwardAccount);
    console.log(`[dry-run] 系统注记: ${alert || "（未触发：对外未动<5 或 最久<=14天）"}`);
    return;
  }

  if (weekly) {
    // 周报写 10_Daily/weekly-W<ww>-<monday>.md
    const now = new Date();
    const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const ww = String(Math.ceil((((monday - new Date(monday.getFullYear(), 0, 1)) / 86400e3) + 1) / 7)).padStart(2, "0");
    const outName = `weekly-W${ww}-${monday.toISOString().slice(0, 10)}.md`;
    const outPath = join(VAULT, "10_Daily", outName);
    const alert = outwardAlertLine(inp.outwardAccount);
    writeFileSync(outPath, `---\ntype: weekly-synthesis\ndate: ${inp.dateStr}\nstatus: unread\nmodel: ${cfg.deepseek_model}\nsource: local-daily-brief\n---\n# Weekly — ${outName.replace(/\.md$/, "")}\n\n${alert ? alert + "\n\n" : ""}${body}\n`);
    commit(join(VAULT, "10_Daily", outName), `chore: weekly synthesis ${inp.dateStr}`);
    console.log(`weekly written: ${outName}`);
  } else {
    const outName = `brief-${inp.dateStr}.md`;
    const outPath = join(VAULT, "00_Inbox", outName);
    writeFileSync(outPath, `---\ntype: daily-brief\ndate: ${inp.dateStr}\nstatus: unread\nmodel: ${cfg.deepseek_model}\nsource: local-daily-brief\n---\n# Brief — ${inp.dateStr}\n\n${body}\n\n---\n📊 [每日追踪表（打卡/勾行动）](${TRACKER_URL})\n`);
    commit(join(VAULT, "00_Inbox", outName), `chore: daily brief ${inp.dateStr}`);
    console.log(`brief written: ${outName}`);

    // Today.md 重写（无 LLM，模板化）
    const todayMd = `---\ntype: daily-hub\ndate: ${inp.dateStr}\nstatus: auto-generated\n---\n# Today\n\n**TL;DR**: ${tldr}\n\n## 快速入口\n- 📊 [每日追踪表（打卡/勾行动）](${TRACKER_URL})\n- 今日书签整理: [[bookmarks-${inp.dateStr}]]\n- 最近日报: [[brief-${inp.dateStr}]]\n\n## 数据\n- 未处理书签: ${inp.pendingBookmarks} 条\n- 活跃项目: ${inp.projects.length} 个\n`;
    writeFileSync(join(VAULT, "Today.md"), todayMd);
    commit(join(VAULT, "Today.md"), `chore: today hub update ${inp.dateStr}`);
  }

  // 学习行动生成（三线各一条，进飞书行动表）——先于 tracker，让行动完成计数包含它们
  try {
    const here = new URL(".", import.meta.url).pathname;
    execSync(`/opt/homebrew/opt/node@22/bin/node learning-actions.mjs`, { cwd: here, encoding: "utf8", stdio: "pipe" });
  } catch (e) { console.error(`learning actions failed: ${String(e.message).slice(0, 200)}`); }

  // 追踪表同步（每日行 / 周复盘行 + 状态回同步）
  // launchd 环境无 PATH，node/lark-cli 都必须绝对路径
  try {
    const here = new URL(".", import.meta.url).pathname;
    execSync(`/opt/homebrew/opt/node@22/bin/node feishu-tracker.mjs${weekly ? " --weekly" : ""}`, { cwd: here, encoding: "utf8", stdio: "pipe" });
  } catch (e) { console.error(`tracker sync failed: ${String(e.message).slice(0, 200)}`); }
}

function commit(absPath, msg) {
  try {
    const rel = absPath.replace(VAULT + "/", "");
    execSync(`git add "${rel}" && git commit -m "${msg}"`, { cwd: VAULT, encoding: "utf8", stdio: "pipe" });
  } catch (e) { console.error(`commit failed: ${e.message?.slice(0, 200)}`); }
}

// 只有直接运行才执行 main：被 import 时不得触发真实写 vault / commit / 推送
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(thisFile)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
