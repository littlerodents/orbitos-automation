// Analyst Agent Logic — fully decoupled via dependency injection.
// Reads Selected notes + project context → DeepSeek cross-pattern analysis → writes analyst note.
// No n8n-specific dependencies. Tests inject mock runners.

// ============ Injectable runners (DI) ============
let ghCaller = async (_method, _path, _body) => { throw new Error("ghCaller not configured"); };
let deepSeekCaller = async (_messages) => { throw new Error("deepSeekCaller not configured"); };
let stateVars = { OWNER: "", REPO: "", BRANCH: "" };
let nowProvider = () => new Date();

export function setGhCaller(fn) { ghCaller = fn; }
export function setDeepSeekCaller(fn) { deepSeekCaller = fn; }
export function setStateVars(vars) { stateVars = vars; }
export function setNowProvider(fn) { nowProvider = fn; }
export function resetRunners() {
  ghCaller = async () => { throw new Error("ghCaller not configured"); };
  deepSeekCaller = async () => { throw new Error("deepSeekCaller not configured"); };
  stateVars = { OWNER: "", REPO: "", BRANCH: "" };
  nowProvider = () => new Date();
}

function nowCst() {
  return new Date(nowProvider().getTime() + 8 * 3600 * 1000);
}

// ============ Pure functions ============

export function isRecentFile(fileName, days, now) {
  const today = now || new Date();
  const dateMatch = fileName.match(/(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) return false;
  const fileDate = new Date(dateMatch[1]);
  const diffMs = today.getTime() - fileDate.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays <= days;
}

export function extractNoteTitle(content, fileName) {
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  return fileName.replace(/\.md$/, "").replace(/^analyst-/, "").replace(/^researcher-/, "");
}

export function extractConfidence(content) {
  const m = content.match(/^confidence:\s*(\w+)/m);
  return m ? m[1] : "";
}

export function extractTopics(content) {
  const m = content.match(/^topics:\s*\[([^\]]*)\]/m);
  if (!m) return [];
  try { return JSON.parse("[" + m[1] + "]"); } catch { return []; }
}

export function isNoiseNote(content) {
  return content.includes("#result C1") || content.includes("#result C3 无新增") || content.includes("无新增");
}

export function buildAnalystMarkdown(analysis, date, relatedNotes) {
  const topics = analysis.topics || [];
  const related = relatedNotes.map(n => `"[[${n}]]"`).join(", ");
  const lines = [
    "---",
    "type: selected-content",
    "source: analyst-agent",
    `date: ${date}`,
    "status: selected",
    `topics: [${topics.map(t => JSON.stringify(t)).join(", ")}]`,
    `related: [${related}]`,
    "---",
    "",
    `# Analyst — ${date}`,
    "",
  ];

  if (analysis.signposts && analysis.signposts.length > 0) {
    for (let i = 0; i < analysis.signposts.length; i++) {
      const sp = analysis.signposts[i];
      lines.push(`## 路标 ${i + 1}：${sp.direction || "未命名方向"}`);
      lines.push(`- 信号强度：${sp.strength || "弱"}`);
      lines.push(`- 证据：${(sp.evidence || []).join(" + ")}`);
      if (sp.judgment) lines.push(`- 判断：${sp.judgment}`);
      if (sp.suggestion) lines.push(`- 建议：${sp.suggestion}`);
      lines.push("");
    }
  }

  if (analysis.noise && analysis.noise.length > 0) {
    lines.push("## 噪音");
    for (const n of analysis.noise) {
      lines.push(`- [[${n.note}]]：${n.reason || "与任务主题不相关"}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function shouldWriteAnalystNote(notes, analysis) {
  if (!analysis || !analysis.signposts || analysis.signposts.length === 0) {
    if (!analysis || !analysis.noise || analysis.noise.length === 0) return false;
    if (notes.length <= 2) return false;
  }
  return true;
}

// ============ Logic functions (use injectable runners) ============

export async function readSelectedNotes(days) {
  const list = await ghCaller("GET", "30_Research/Selected", null);
  if (!list || !Array.isArray(list)) return [];

  const now = nowCst();
  const notes = [];
  for (const f of list) {
    if (!f.name || !f.name.endsWith(".md")) continue;
    if (f.name.startsWith("analyst-")) continue;
    if (!isRecentFile(f.name, days || 3, now)) continue;
    let file;
    try { file = await ghCaller("GET", f.path, null); } catch { continue; }
    if (!file || !file.content) continue;
    const content = Buffer.from(file.content, "base64").toString("utf8");
    notes.push({
      name: f.name.replace(/\.md$/, ""),
      fileName: f.name,
      path: f.path,
      content: content.slice(0, 1000),
      title: extractNoteTitle(content, f.name),
      confidence: extractConfidence(content),
      topics: extractTopics(content),
      isNoise: isNoiseNote(content),
    });
  }
  return notes;
}

export async function readProjectContext() {
  let context = "";
  const dirs = ["20_Project"];
  for (const dir of dirs) {
    const list = await ghCaller("GET", dir, null);
    if (!list || !Array.isArray(list)) continue;
    for (const f of list) {
      if (!f.name || !f.name.endsWith(".md")) continue;
      let file;
      try { file = await ghCaller("GET", f.path, null); } catch { continue; }
      if (!file || !file.content) continue;
      const text = Buffer.from(file.content, "base64").toString("utf8").slice(0, 500);
      context += "### " + f.name + "\n" + text + "\n\n";
    }
  }
  const inboxList = await ghCaller("GET", "00_Inbox", null);
  if (inboxList && Array.isArray(inboxList)) {
    const briefs = inboxList.filter(f => f.name && f.name.startsWith("brief-")).slice(-3);
    for (const b of briefs) {
      let file;
      try { file = await ghCaller("GET", b.path, null); } catch { continue; }
      if (!file || !file.content) continue;
      const text = Buffer.from(file.content, "base64").toString("utf8");
      const patternMatch = text.match(/## PATTERN[\s\S]*?(?=## |$)/);
      if (patternMatch) context += "### " + b.name + " PATTERN\n" + patternMatch[0].slice(0, 500) + "\n\n";
    }
  }
  return context || "(no project context)";
}

export async function analyzePatterns(notes, projectContext) {
  if (!notes || notes.length === 0) return { signposts: [], noise: [] };

  const notesDigest = notes.map(n => {
    return "文件: " + n.name + "\n标题: " + n.title + "\n置信度: " + n.confidence + "\n主题: " + n.topics.join(", ") + "\n内容摘要: " + n.content.slice(0, 300) + (n.isNoise ? "\n状态: 噪音/无增量" : "");
  }).join("\n---\n");

  const prompt = "你是分析师。以下是从主人 vault 的 30_Research/Selected/ 里最近几天的 research notes。\n\n主人 vault 项目上下文：\n" + projectContext + "\n\n以下是 Selected notes：\n" + notesDigest + "\n\n请分析这些 notes 之间的跨篇模式：\n\n1. 路标（signposts）：有没有 2+ 篇指向同一方向？如果有，输出每个路标：\n   - direction: 用一句话命名这个方向\n   - strength: 弱(2篇)/中(3篇)/强(4+篇)\n   - evidence: 哪些 notes 共同指向（用文件名不含.md）\n   - judgment: 两篇合在一起在说什么（不抄原文，用你的话判断）\n   - suggestion: 下一步搜索建议（可选）\n\n2. 噪音（noise）：有没有搜错方向/内容不相关的 note？\n   - note: 文件名（不含.md）\n   - reason: 为什么是噪音\n\n3. 如果 notes ≤ 2 篇且无明显模式，直接输出空结果。\n\n规则：不抄 notes 原文。只做跨篇判断。中文。≤400字。\n\n输出 JSON 格式：\n{\"signposts\":[{\"direction\":\"\",\"strength\":\"\",\"evidence\":[\"note1\",\"note2\"],\"judgment\":\"\",\"suggestion\":\"\"}],\"noise\":[{\"note\":\"\",\"reason\":\"\"}],\"topics\":[\"topic1\",\"topic2\"]}";

  let resp;
  try { resp = await deepSeekCaller([
    { role: "system", content: "你是分析师，帮主人找 research notes 之间的跨篇模式。只输出 JSON。" },
    { role: "user", content: prompt }
  ]); } catch (e) { return { signposts: [], noise: [], error: e.message }; }

  if (!resp || !resp.choices || !resp.choices[0] || !resp.choices[0].message) return { signposts: [], noise: [] };
  const text = resp.choices[0].message.content || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { signposts: [], noise: [] };
  try { return JSON.parse(jsonMatch[0]); } catch { return { signposts: [], noise: [] }; }
}

// ============ Main pipeline ============

export async function processAnalystTask(opts = {}) {
  const days = opts.days || 3;
  const notes = await readSelectedNotes(days);
  const projectContext = await readProjectContext();
  const analysis = await analyzePatterns(notes, projectContext);
  const shouldWrite = shouldWriteAnalystNote(notes, analysis);

  if (!shouldWrite) return { no_action: true, notesCount: notes.length, reason: "0 signposts + notes <= 2" };

  const today = nowCst().toISOString().slice(0, 10);
  const relatedNotes = notes.map(n => n.name);
  const md = buildAnalystMarkdown(analysis, today, relatedNotes);
  const mdB64 = Buffer.from(md, "utf8").toString("base64");
  const analystPath = "30_Research/Selected/analyst-" + today + "-pattern.md";

  return {
    action: "write",
    analyst_path: analystPath,
    analyst_b64: mdB64,
    analyst_msg: "analyst: cross-pattern analysis " + today,
    notesCount: notes.length,
    signposts: (analysis.signposts || []).length,
    noise: (analysis.noise || []).length,
    owner: stateVars.OWNER,
    repo: stateVars.REPO,
    branch: stateVars.BRANCH,
  };
}
