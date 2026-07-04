// Filter Agent Logic — fully decoupled via dependency injection.
// Cron-triggered information filter: reads vault baseline → searches by weighted interests →
// DeepSeek delta compare → writes filter-{date}-{period}.md with only increments.

// ============ Injectable runners (DI) ============
let ghCaller = async (_method, _path, _body) => { throw new Error("ghCaller not configured"); };
let exaSearcher = async (_query, _num) => { throw new Error("exaSearcher not configured"); };
let deepSeekCaller = async (_messages) => { throw new Error("deepSeekCaller not configured"); };
let stateVars = { OWNER: "", REPO: "", BRANCH: "" };

export function setGhCaller(fn) { ghCaller = fn; }
export function setExaSearcher(fn) { exaSearcher = fn; }
export function setDeepSeekCaller(fn) { deepSeekCaller = fn; }
export function setStateVars(vars) { stateVars = vars; }
export function resetRunners() {
  ghCaller = async () => { throw new Error("ghCaller not configured"); };
  exaSearcher = async () => { throw new Error("exaSearcher not configured"); };
  deepSeekCaller = async () => { throw new Error("deepSeekCaller not configured"); };
  stateVars = { OWNER: "", REPO: "", BRANCH: "" };
}

// ============ Base interests with weights ============
export const BASE_INTERESTS = [
  { topic: "AI agent 协作与组织架构", query: "AI agent team organization structure 2026", weight: 3 },
  { topic: "AI 原生产品与创业", query: "AI-native product startup 2026", weight: 3 },
  { topic: "语言康复与患者平台", query: "语言康复 AI 辅助 患者平台", weight: 2 },
  { topic: "LLM 安全与评测", query: "LLM safety evaluation benchmark 2026", weight: 2 },
  { topic: "个人 AI 基础设施与自动化", query: "personal AI infrastructure automation agent 2026", weight: 3 },
  { topic: "项目管理与 OKR", query: "OKR project management AI automation", weight: 3 },
];

// ============ Pure functions ============

export function getPeriod(hour) {
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

export function extractInferredInterests(vaultBaseline) {
  const interests = [];
  const topicPattern = /topics:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = topicPattern.exec(vaultBaseline)) !== null) {
    try {
      const topics = JSON.parse("[" + m[1] + "]");
      for (const t of topics) {
        if (typeof t === "string" && t.length > 1 && !interests.includes(t)) {
          interests.push(t);
        }
      }
    } catch {}
  }
  const patternSection = vaultBaseline.match(/## PATTERN[\s\S]*?(?=## |$)/g);
  if (patternSection) {
    for (const section of patternSection) {
      const keywords = section.match(/[\u4e00-\u9fa5]{2,6}|[A-Za-z]{3,15}/g) || [];
      for (const kw of keywords) {
        if (kw.length > 2 && !interests.includes(kw) && interests.length < 10) {
          interests.push(kw);
        }
      }
    }
  }
  return interests.slice(0, 5);
}

export function mergeInterests(base, inferred) {
  const seen = new Set(base.map(b => b.topic));
  const merged = [...base];
  for (const topic of inferred) {
    if (!seen.has(topic) && !base.some(b => b.topic.includes(topic) || topic.includes(b.topic.slice(0, 4)))) {
      merged.push({ topic, query: topic, weight: 1 });
      seen.add(topic);
    }
  }
  return merged.sort((a, b) => b.weight - a.weight);
}

export function buildFilterMarkdown(sections, date, period) {
  const lines = [
    "---",
    "type: filter-digest",
    "source: filter-agent",
    `date: ${date}`,
    `period: ${period}`,
    "status: unread",
    "---",
    "",
    `# Filter — ${date} ${period}`,
    "",
  ];
  for (const s of sections) {
    lines.push(`## ${s.topic}`);
    if (s.increment) {
      lines.push(s.increment);
    } else {
      lines.push("（无新增）");
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function shouldWriteFilter(sections) {
  return sections.some(s => s.increment && !s.increment.includes("无新增"));
}

// ============ Logic functions (use injectable runners) ============

export async function readVaultBaseline() {
  let baseline = "";
  const dirs = ["30_Research/Selected", "20_Project"];
  for (const dir of dirs) {
    let list;
    try { list = await ghCaller("GET", dir, null); } catch { continue; }
    if (!list || !Array.isArray(list)) continue;
    for (const f of list) {
      if (!f.name || !f.name.endsWith(".md")) continue;
      let file;
      try { file = await ghCaller("GET", f.path, null); } catch { continue; }
      if (!file || !file.content) continue;
      const text = Buffer.from(file.content, "base64").toString("utf8");
      baseline += "### " + f.name + "\n" + text.slice(0, 500) + "\n\n";
    }
  }
  let inboxList;
  try { inboxList = await ghCaller("GET", "00_Inbox", null); } catch { inboxList = null; }
  if (inboxList && Array.isArray(inboxList)) {
    const briefs = inboxList.filter(f => f.name && f.name.startsWith("brief-")).slice(-3);
    for (const b of briefs) {
      let file;
      try { file = await ghCaller("GET", b.path, null); } catch { continue; }
      if (!file || !file.content) continue;
      const text = Buffer.from(file.content, "base64").toString("utf8");
      const patternMatch = text.match(/## PATTERN[\s\S]*?(?=## |$)/);
      if (patternMatch) baseline += "### " + b.name + " PATTERN\n" + patternMatch[0].slice(0, 500) + "\n\n";
    }
  }
  return baseline || "(vault empty)";
}

export async function searchAndCompare(interest, vaultBaseline) {
  let searchResults;
  try { searchResults = await exaSearcher(interest.query, 3); } catch { searchResults = []; }
  if (!searchResults || searchResults.length === 0) return { topic: interest.topic, increment: null, weight: interest.weight };

  const searchDigest = searchResults.slice(0, 3).map(r => "URL: " + r.url + " / 标题: " + (r.title || "") + " / 摘要: " + (r.text || "").slice(0, 300)).join("\n---\n");
  const prompt = "你是信息过滤器。主人对「" + interest.topic + "」感兴趣（权重" + interest.weight + "）。\n\n主人 vault 已有知识：\n" + vaultBaseline + "\n\n搜索到的最新网页结果：\n" + searchDigest + "\n\n判断：这些结果跟主人已有知识相比，有没有增量？\n- 如果有增量：输出 1-3 条，每条格式：- [标题](URL) — 一句话说明增量\n- 如果无增量或不相关：只输出「无新增」\n- 不抄网页原文\n- 中文\n- ≤200字";

  let resp;
  try {
    resp = await deepSeekCaller([
      { role: "system", content: "你是信息过滤器，帮主人判断搜索结果相比已有知识的增量。只输出增量。" },
      { role: "user", content: prompt }
    ]);
  } catch (e) { return { topic: interest.topic, increment: null, weight: interest.weight }; }

  if (!resp || !resp.choices || !resp.choices[0] || !resp.choices[0].message) return { topic: interest.topic, increment: null, weight: interest.weight };
  const content = resp.choices[0].message.content || "";
  if (!content || content.includes("无新增") || content.trim() === "") return { topic: interest.topic, increment: null, weight: interest.weight };
  return { topic: interest.topic, increment: content, weight: interest.weight };
}

// ============ Main pipeline ============

export async function processFilterTask(opts = {}) {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const date = now.toISOString().slice(0, 10);
  const period = getPeriod(now.getUTCHours());
  const maxInterests = opts.maxInterests || 8;

  const vaultBaseline = await readVaultBaseline();
  const inferred = extractInferredInterests(vaultBaseline);
  const interests = mergeInterests(BASE_INTERESTS, inferred).slice(0, maxInterests);

  const sections = await Promise.all(interests.map(interest => searchAndCompare(interest, vaultBaseline)));

  if (!shouldWriteFilter(sections)) {
    return { no_action: true, date, period, interestsChecked: interests.length, reason: "0 increments across all interests" };
  }

  const md = buildFilterMarkdown(sections, date, period);
  const mdB64 = Buffer.from(md, "utf8").toString("base64");
  const filterPath = "00_Inbox/filter-" + date + "-" + period + ".md";

  return {
    action: "write",
    filter_path: filterPath,
    filter_b64: mdB64,
    filter_msg: "filter: " + date + " " + period + " digest",
    date, period,
    interestsChecked: interests.length,
    increments: sections.filter(s => s.increment).length,
    owner: stateVars.OWNER,
    repo: stateVars.REPO,
    branch: stateVars.BRANCH,
  };
}
