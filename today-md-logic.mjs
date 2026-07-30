// Today.md Automation Logic — fully decoupled via dependency injection.
// Reads vault files (brief, researcher, analyst, filter, monitor, feishu flags)
// → extracts summaries → assembles Today.md → writes to vault root.
// No LLM calls — pure assembly, zero token cost.

import { loadConfig } from "./lib/config.mjs";

// ============ Injectable runners (DI) ============
let ghCaller = async (_method, _path, _body) => { throw new Error("ghCaller not configured"); };
let stateVars = { OWNER: "", REPO: "", BRANCH: "" };
let nowProvider = () => new Date();

export function setGhCaller(fn) { ghCaller = fn; }
export function setStateVars(vars) { stateVars = vars; }
export function setNowProvider(fn) { nowProvider = fn; }
export function resetRunners() {
  ghCaller = async () => { throw new Error("ghCaller not configured"); };
  stateVars = { OWNER: "", REPO: "", BRANCH: "" };
  nowProvider = () => new Date();
}

function nowCst() {
  return new Date(nowProvider().getTime() + 8 * 3600 * 1000);
}

// ============ Pure functions ============

export function extractTldr(briefContent) {
  if (!briefContent) return "今天还没有 brief";
  const m = briefContent.match(/## TL;DR[\s\S]*?\n([\s\S]*?)(?=\n## |$)/);
  if (m) return m[1].trim();
  const m2 = briefContent.match(/## CONNECTIONS[\s\S]*?\n([\s\S]*?)(?=\n## |$)/);
  if (m2) return m2[1].trim().slice(0, 300);
  return briefContent.replace(/^---[\s\S]*?---\n/, "").trim().slice(0, 300);
}

export function extractResearcherSummary(content, fileName) {
  if (!content) return null;
  const keyMatch = content.match(/source_key:\s*(.+)/);
  const sourceKey = keyMatch ? keyMatch[1].trim() : fileName.replace(/\.md$/, "");
  const bodyMatch = content.replace(/^---[\s\S]*?---\n/, "").trim();
  const firstLines = bodyMatch.split("\n").filter(l => l.trim() && !l.startsWith("#")).slice(0, 3).join(" ");
  return { link: sourceKey, summary: firstLines.slice(0, 100) };
}

export function extractAnalystSignposts(content) {
  if (!content) return [];
  const signposts = [];
  const sections = content.split(/## 路标/);
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    const direction = section.match(/^[^：\n]*：(.+)/)?.[1]?.trim() || section.split("\n")[0].trim();
    const judgment = section.match(/判断[：:]\s*(.+)/)?.[1]?.trim() || "";
    if (direction) signposts.push({ direction: direction.slice(0, 50), judgment: judgment.slice(0, 80) });
  }
  return signposts;
}

export function extractFilterDigest(content) {
  if (!content) return [];
  const sections = content.split(/^## /m).slice(1);
  const entries = [];
  for (const section of sections) {
    const title = section.split("\n")[0].trim();
    const lines = section.split("\n").slice(1).filter(l => l.trim().startsWith("-")).slice(0, 1);
    if (lines.length > 0 && title) {
      entries.push({ topic: title.slice(0, 30), summary: lines[0].trim().slice(0, 80) });
    }
  }
  return entries.slice(0, 3);
}

export function extractMonitorEntries(content) {
  if (!content) return [];
  if (content.includes("无高互动新内容")) return [];
  const sections = content.split(/^## /m).slice(1);
  const entries = [];
  for (const section of sections) {
    const title = section.split("\n")[0].trim();
    if (!title || title.includes("无高互动")) continue;
    const summary = section.split("\n").slice(1).filter(l => l.trim() && !l.startsWith("likes") && !l.startsWith("增量")).slice(0, 1).join("");
    if (title) entries.push({ author: title.slice(0, 40), summary: summary.slice(0, 60) });
  }
  return entries.slice(0, 3);
}

export function extractFeishuFlags(fileList) {
  if (!fileList || !Array.isArray(fileList)) return [];
  const flags = fileList.filter(f => f.name && f.name.startsWith("feishu-") && f.name.endsWith(".md"));
  if (flags.length === 0) return [];
  return [{ count: flags.length, latest: flags[0].name.replace(/\.md$/, "") }];
}

export function isRecentFile(fileName, hours, now) {
  const today = now || new Date();
  const dateMatch = fileName.match(/(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) return false;
  const fileDate = new Date(dateMatch[1]);
  const diffMs = today.getTime() - fileDate.getTime();
  return diffMs >= 0 && diffMs <= hours * 3600 * 1000;
}

export function buildTodayMd(data) {
  const { date, tldr, researcher, analyst, filter, monitor, feishuFlags } = data;
  const lines = [
    "---",
    "type: daily-hub",
    `date: ${date}`,
    "status: auto-generated",
    "---",
    "",
    `# 今天 — ${date}`,
    "",
    "## TL;DR",
    tldr || "今天还没有 brief",
    "",
    "---",
    "",
    "## AI 帮你发现的新东西",
    "",
  ];

  let hasAny = false;

  if (researcher && researcher.length > 0) {
    hasAny = true;
    lines.push("**深度研究**");
    for (const r of researcher) {
      lines.push(`- [[${r.link}]] — ${r.summary}`);
    }
    lines.push("");
  }

  if (analyst && analyst.length > 0) {
    hasAny = true;
    lines.push("**跨篇路标**");
    for (const a of analyst) {
      lines.push(`- ${a.direction}：${a.judgment}`);
    }
    lines.push("");
  }

  if (filter && filter.length > 0) {
    hasAny = true;
    lines.push("**外部信息**");
    for (const f of filter) {
      lines.push(`- ${f.topic}：${f.summary}`);
    }
    lines.push("");
  }

  if (monitor && monitor.length > 0) {
    hasAny = true;
    lines.push("**关注对象**");
    for (const m of monitor) {
      lines.push(`- ${m.author}：${m.summary}`);
    }
    lines.push("");
  }

  if (!hasAny) {
    lines.push("*今天还没有新的 AI 产出。写一条 #task researcher 试试？*");
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## 上次标记要看但还没看的");
  if (feishuFlags && feishuFlags.length > 0) {
    lines.push(`飞书有 ${feishuFlags[0].count} 条标记未处理（最近：${feishuFlags[0].latest}）`);
  } else {
    lines.push("*（空 — 在飞书里 flag 一条你觉得今天有用的消息，明天这里就会出现。）*");
  }
  lines.push("");

  return lines.join("\n");
}

// ============ Logic functions (use injectable runners) ============

async function ghGet(path) {
  try { return await ghCaller("GET", path, null); } catch { return null; }
}

export async function readBrief(today) {
  const file = await ghGet(`00_Inbox/brief-${today}.md`);
  if (!file || !file.content) return null;
  return Buffer.from(file.content, "base64").toString("utf8");
}

export async function readResearcherNotes(today, hours) {
  const list = await ghGet("30_Research/Selected");
  if (!list || !Array.isArray(list)) return [];
  const now = nowCst();
  const recent = list.filter(f => f.name && f.name.startsWith("researcher-") && isRecentFile(f.name, hours || 24, now));
  const results = [];
  for (const f of recent) {
    const file = await ghGet(f.path);
    if (!file || !file.content) continue;
    const content = Buffer.from(file.content, "base64").toString("utf8");
    const summary = extractResearcherSummary(content, f.name);
    if (summary) results.push(summary);
  }
  return results;
}

export async function readAnalystNote(today) {
  const file = await ghGet(`30_Research/Selected/analyst-${today}-pattern.md`);
  if (!file || !file.content) return [];
  const content = Buffer.from(file.content, "base64").toString("utf8");
  return extractAnalystSignposts(content);
}

export async function readFilterDigests(today) {
  const list = await ghGet("00_Inbox");
  if (!list || !Array.isArray(list)) return [];
  const filterFiles = list.filter(f => f.name && f.name.startsWith(`filter-${today}`) && f.name.endsWith(".md"));
  const results = [];
  for (const f of filterFiles) {
    const file = await ghGet(f.path);
    if (!file || !file.content) continue;
    const content = Buffer.from(file.content, "base64").toString("utf8");
    results.push(...extractFilterDigest(content));
  }
  return results.slice(0, 3);
}

export async function readMonitorDigests(today) {
  const list = await ghGet("00_Inbox");
  if (!list || !Array.isArray(list)) return [];
  const monitorFiles = list.filter(f => f.name && f.name.startsWith(`monitor-${today}`) && f.name.endsWith(".md"));
  const results = [];
  for (const f of monitorFiles) {
    const file = await ghGet(f.path);
    if (!file || !file.content) continue;
    const content = Buffer.from(file.content, "base64").toString("utf8");
    results.push(...extractMonitorEntries(content));
  }
  return results.slice(0, 3);
}

export async function readFeishuFlags() {
  const list = await ghGet("00_Inbox");
  if (!list || !Array.isArray(list)) return [];
  const now = nowCst();
  const recent = list.filter(f => f.name && f.name.startsWith("feishu-") && isRecentFile(f.name, 168, now));
  return extractFeishuFlags(recent);
}

// ============ Main pipeline ============

export async function processTodayTask() {
  const now = nowCst();
  const today = now.toISOString().slice(0, 10);

  const briefContent = await readBrief(today);
  const tldr = extractTldr(briefContent);
  const researcher = await readResearcherNotes(today, 24);
  const analyst = await readAnalystNote(today);
  const filter = await readFilterDigests(today);
  const monitor = await readMonitorDigests(today);
  const feishuFlags = await readFeishuFlags();

  const md = buildTodayMd({ date: today, tldr, researcher, analyst, filter, monitor, feishuFlags });
  const mdB64 = Buffer.from(md, "utf8").toString("base64");

  // Get existing Today.md sha for overwrite
  let sha = "";
  try {
    const existing = await ghCaller("GET", "Today.md", null);
    if (existing && existing.sha) sha = existing.sha;
  } catch {}

  return {
    action: "write",
    path: "Today.md",
    b64: mdB64,
    msg: `today: ${today} hub`,
    sha,
    date: today,
    sections: {
      tldr: !!briefContent,
      researcher: researcher.length,
      analyst: analyst.length,
      filter: filter.length,
      monitor: monitor.length,
      feishuFlags: feishuFlags.length,
    },
    owner: stateVars.OWNER,
    repo: stateVars.REPO,
    branch: stateVars.BRANCH,
  };
}
