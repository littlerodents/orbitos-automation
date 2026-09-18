#!/usr/bin/env node
// orbitos-daily-brief: 本地复活日报/周报（原 n8n 云端 workflow 的本地替代）
//   输入(全本地): 24h 内新书签整理、7 天 Selected 未读、行动队列、活跃项目、monitor 摘要
//   → DeepSeek 按 99_System/Prompts/Daily_Brief.md 的格式写 00_Inbox/brief-<date>.md
//   → git commit "chore: daily brief <date>"（brief-push 检测该提交并送飞书 DM）
//   → 顺带重写 Today.md
// 手动: node orbitos-daily-brief.mjs [--weekly]
// 定时: com.evander.orbitos-daily-brief.plist（工作日 08:00）/ weekly（周日 10:00）

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { loadConfig } from "./lib/config.mjs";

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
    const ai = cols.indexOf("行动"), si = cols.indexOf("状态"), di = cols.indexOf("开始卡于");
    const todayMs = Date.now() + 8 * 3600e3;
    return (d.data || []).map(vals => {
      const start = String((Array.isArray(vals[di]) ? vals[di][0] : vals[di]) || "").slice(0, 10);
      const startMs = start ? new Date(`${start}T00:00:00+08:00`).getTime() : todayMs;
      const age = Math.max(0, Math.floor((todayMs - startMs) / 86400e3));
      return {
        text: (Array.isArray(vals[ai]) ? vals[ai][0] : vals[ai]) || "",
        status: (Array.isArray(vals[si]) ? vals[si][0] : vals[si]) || "未动",
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

function gatherInputs() {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);

  // 1. 书签整理产物（Selected/bookmarks-*.md，7 天内）
  const bookmarkNotes = filesNewerThan(join(VAULT, "30_Research/Selected"), weekly ? 7 : 2, f => f.startsWith("bookmarks-"))
    .map(x => `--- ${x.f} ---\n${readHead(x.p)}`);

  // 2. 其他 Selected 未读（researcher/analyst 产物）
  const selectedNotes = filesNewerThan(join(VAULT, "30_Research/Selected"), 7, f => !f.startsWith("bookmarks-"))
    .map(x => `--- ${x.f} ---\n${readHead(x.p, 1200)}`);

  // 3. 行动表（飞书追踪表，唯一权威；卡龄降序 = 最老的最优先）
  const actions = actionsFromTracker()
    .filter(a => a.status === "未动" || a.status === "进行中")
    .sort((a, b) => b.age - a.age);
  const doneN = actionsFromTracker().filter(a => a.status === "已完成").length;
  const actionLines = actions.slice(0, 8)
    .map(a => `- [${a.start ? a.start.slice(5).replace("-", "/") + " 卡起" : "新入"}·${a.age}天] ${a.text}`)
    .join("\n");

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

  return { dateStr, bookmarkNotes, selectedNotes, actionLines, doneN, projects, pendingBookmarks };
}

const SYSTEM = `你是 Evander 的 vault 思考伙伴。为 OrbitOS 写${weekly ? "周报" : "日报"}。不要拒绝，不要解释你是谁，直接写正文。
OrbitOS 是极简系统：飞书是提醒面，Obsidian 存精选。他在意的主线：一人公司(OPC)落地、程序化SEO、个人AI基础设施、AI agent 工程。
格式（严格遵守）：
## TL;DR
一句话，≤30 个汉字，**今天 5 分钟内能启动的具体动作**（打开什么网站/文件、写下什么、发布什么），禁止抽象口号（如"完成发布""持续推进"这类空话必须换成具体第一步）。
## 行动提醒
从行动表里挑 2-3 项最该动的（卡龄越长越优先）。**每条必须给出具体第一步：打开哪个网址/文件、做什么动作、大约几分钟**。行动文本里通常已带第一步，直接复述并强化。如果他一直没动某项，点破卡了多少天。
## 学习增量
${weekly ? "本周" : "昨日"}书签整理/研究笔记里最值得精读的 ≤3 条：标题 + 一句话理由 + wikilink。没有就说没有，不要编。
## CONNECTIONS
书签/研究/项目之间 ≤3 个真实连接，用 [[wikilink]]。不足 3 个就诚实说。
## PATTERN
一个正在变得清晰的偏好/模式，2-4 句。`;

async function main() {
  if (!DS_KEY) { console.error("no deepseek key"); process.exit(1); }
  const inp = gatherInputs();

  if (!inp.bookmarkNotes.length && !inp.selectedNotes.length && weekly === false) {
    // 无新料也照发：行动提醒本身就是价值
  }

  const user = `今天是 ${inp.dateStr}${weekly ? "（周报）" : "（工作日日报）"}。
活跃项目: ${inp.projects.join(", ") || "无"}
未处理书签积压: ${inp.pendingBookmarks} 条
行动完成度: ${inp.doneN} 项已完成

### 行动表（按卡龄降序，前 8）
${inp.actionLines || "（空）"}

### 最近书签整理产物
${inp.bookmarkNotes.join("\n\n") || "（无新增）"}

### 最近研究精选笔记
${inp.selectedNotes.join("\n\n") || "（无新增）"}

写出${weekly ? "周报" : "日报"}正文（从 ## TL;DR 开始，不要自己加一级标题）。`;

  const resp = await callDeepSeek([
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ]);
  const body = (resp.choices?.[0]?.message?.content || "").trim();
  if (!body.startsWith("## TL;DR")) { console.error("LLM 输出格式异常，放弃:\n", body.slice(0, 300)); process.exit(1); }

  const tldr = body.match(/## TL;DR\n(.+)/)?.[1]?.trim() || "";

  if (weekly) {
    // 周报写 10_Daily/weekly-W<ww>-<monday>.md
    const now = new Date();
    const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const ww = String(Math.ceil((((monday - new Date(monday.getFullYear(), 0, 1)) / 86400e3) + 1) / 7)).padStart(2, "0");
    const outName = `weekly-W${ww}-${monday.toISOString().slice(0, 10)}.md`;
    const outPath = join(VAULT, "10_Daily", outName);
    writeFileSync(outPath, `---\ntype: weekly-synthesis\ndate: ${inp.dateStr}\nstatus: unread\nmodel: ${cfg.deepseek_model}\nsource: local-daily-brief\n---\n# Weekly — ${outName.replace(/\.md$/, "")}\n\n${body}\n`);
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

main().catch(e => { console.error(e); process.exit(1); });
