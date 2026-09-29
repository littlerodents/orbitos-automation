// Researcher Agent Logic v2 — fully decoupled via dependency injection.
// All external calls (GitHub, Exa, DeepSeek) go through injectable runners.
// No n8n-specific dependencies. Tests inject mock runners.

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

// ============ Pure functions (no dependencies) ============

export function extractPersonName(title) {
  const m = title.match(/([\u4e00-\u9fa5]{2,4})\s/);
  return m ? m[1] : "";
}

function parseUrl(urlStr) {
  const m = (urlStr || "").match(/^https?:\/\/([^/]+)(.*)$/);
  return m ? { domain: m[1].replace(/^www\./, ""), path: m[2] || "" } : null;
}

export function scoreConfidence(searchResults, taskTitle) {
  if (!searchResults || !searchResults.length) return "C0";
  const titleKeywords = taskTitle.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const personName = extractPersonName(taskTitle);
  const personLower = personName ? personName.toLowerCase() : "";
  const hasPerson = !!personLower;
  const domains = new Map();
  let bestScore = "C0";

  for (const r of searchResults) {
    const parsed = parseUrl(r.url);
    if (!parsed) continue;
    const { domain, path: urlPath } = parsed;
    if (!domains.has(domain)) domains.set(domain, []);
    domains.get(domain).push(r);

    const combined = ((r.title || "") + " " + (r.text || "")).toLowerCase();
    const matched = titleKeywords.filter(k => combined.includes(k));
    const ratio = matched.length / Math.max(titleKeywords.length, 1);
    if (ratio < 0.3) continue;
    const mentionsPerson = hasPerson && combined.includes(personLower);

    if (hasPerson) {
      const isInterview = combined.includes("专访") || combined.includes("演讲") || combined.includes("talk") || combined.includes("interview") || combined.includes("实录") || combined.includes("对话");
      const isAuthorBlog = mentionsPerson && (urlPath.includes("/blog/") || domain.includes("dtalk") || domain.includes("medium"));
      if ((isInterview && mentionsPerson) || isAuthorBlog || (domain.includes("arxiv.org") && mentionsPerson)) { if (ratio > 0.4) { bestScore = "C4"; break; } }
      const credible = ["shobserver.com","thepaper.cn","36kr.com","news.cn","people.com.cn","caixin.com","yicai.com","dtalk.org"];
      if (credible.some(cd => domain.includes(cd)) && mentionsPerson && ratio > 0.4) { if (bestScore === "C0" || bestScore === "C1") bestScore = "C2"; }
      if (mentionsPerson && ratio > 0.5 && (r.text || "").length > 200) { if (bestScore === "C0" || bestScore === "C1") bestScore = "C2"; }
    } else {
      if ((domain.includes("arxiv.org") || domain.includes("github.com") || urlPath.includes("/docs/") || urlPath.includes("/blog/")) && ratio >= 0.67) { bestScore = "C4"; break; }
      const credible = ["mckinsey.com","shobserver.com","thepaper.cn","36kr.com","news.cn","people.com.cn","caixin.com","yicai.com","dtalk.org","harvardbusiness.org","hbr.org","forbes.com","techcrunch.com","wired.com"];
      if (credible.some(cd => domain.includes(cd)) && ratio >= 0.5) { if (bestScore === "C0" || bestScore === "C1") bestScore = "C2"; }
      if (ratio >= 0.67 && (r.text || "").length > 500) { if (bestScore === "C0" || bestScore === "C1") bestScore = "C2"; }
    }

    if (ratio > 0.3) { if (bestScore === "C0") bestScore = "C1"; }
  }

  if (bestScore === "C2" && domains.size >= 2) {
    let goodDomains = 0;
    for (const [_d, items] of domains) {
      const hasGood = items.some(r => {
        const combined = ((r.title||"")+" "+(r.text||"")).toLowerCase();
        const matched = titleKeywords.filter(k => combined.includes(k));
        return (matched.length / Math.max(titleKeywords.length, 1)) >= (hasPerson ? 0.4 : 0.5);
      });
      if (hasGood) goodDomains++;
    }
    if (goodDomains >= 2) bestScore = "C3";
  }

  // === Relevance gate: phrase-level check ===
  // If no result contains the task title as a phrase (or 2+ consecutive keywords),
  // the results likely match keywords individually but are about a different entity.
  // Force down to C1 regardless of how many sources or domains match.
  if (titleKeywords.length >= 2 && (bestScore === "C3" || bestScore === "C4")) {
    const titleLower = taskTitle.toLowerCase();
    const hasPhraseMatch = searchResults.some(r => {
      const combined = ((r.title || "") + " " + (r.text || "")).toLowerCase();
      if (combined.includes(titleLower)) return true;
      for (let i = 0; i < titleKeywords.length - 1; i++) {
        if (combined.includes(titleKeywords.slice(i, i + 2).join(" "))) return true;
      }
      return false;
    });
    if (!hasPhraseMatch) bestScore = "C1";
  }

  return bestScore;
}

export function dedupResults(all) {
  const seen = new Map();
  const noUrl = [];
  for (const r of all) {
    const urlStr = r.url || r.canonicalUrl || r.link || "";
    if (!urlStr) { noUrl.push(r); continue; }
    const parsed = parseUrl(urlStr);
    if (!parsed) { noUrl.push(r); continue; }
    const key = parsed.domain + parsed.path.slice(0, 30);
    let found = false;
    for (const [k, ex] of seen) {
      if (k.startsWith(key.slice(0, 20)) && (r.text||"").length > (ex.text||"").length) { seen.set(k, r); found = true; break; }
    }
    if (!found) seen.set(key, r);
  }
  return [...noUrl, ...seen.values()];
}

export function buildQueries(title, round) {
  if (round === 1) return [title];
  if (round === 2) {
    const parts = title.split(/\s+/);
    const q = [];
    if (parts.length >= 2) { q.push(parts.slice(0, Math.ceil(parts.length/2)).join(" ") + " 演讲 2026"); } else { q.push(title + " 演讲 2026"); }
    q.push(title + " AI agent team");
    return q.slice(0, 3);
  }
  if (round === 3) {
    return [title.replace(/[\u4e00-\u9fa5]+/g, "").trim() + " AI-native organization agent", "AI agent framework 2026 " + title.split(/\s+/)[0], title + " 论文 OR talk"].filter(q => q.trim().length > 3).slice(0, 3);
  }
  return [title];
}

export function cleanPageText(rawText, maxChars = 800) {
  if (!rawText) return "";
  const lines = rawText.split("\n").map(l => l.trim());
  const noisePatterns = /^(登录|注册|关注作者|学习|活动|专区|圈层|工具|文章|搜索|发布|关闭|原创|Stars?|Forks?|Watchers?|Open issues?|License|Default branch|Created|Languages?|Topics?|Top Contributors?|contributions|Sponsored|推荐|评论|分享|收藏|举报|相关|关于嘉宾|报名|查看|更多|下载|安装|npm|github\.com|社区首页|专栏|首页|导航|菜单|返回|上一页|下一页|目录|侧边|footer|header|copyright|版权|联系方式|扫码|微信|二维码)/i;
  const clean = [];
  for (const line of lines) {
    if (line.length < 15) continue;
    if (noisePatterns.test(line)) continue;
    if (/^[-•|>*_=#\s]+$/.test(line)) continue;
    if (/^https?:\/\//.test(line)) continue;
    clean.push(line);
  }
  const text = clean.join("\n");
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut + "...";
}

// ============ Logic functions (use injectable runners) ============

export async function readVaultBaseline() {
  let baseline = "";
  const dirs = ["30_Research/Selected", "40_Wiki", "20_Project"];
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
      const text = Buffer.from(file.content, "base64").toString("utf8").slice(0, 500);
      baseline += "### " + b.name + "\n" + text + "\n\n";
    }
  }
  return baseline || "(vault empty)";
}

export async function searchLoop(taskTitle, effectiveQuery, maxRounds) {
  let allResults = [];
  let bestConfidence = "C0";
  let roundsDone = 0;
  let queriesTried = [];

  for (let round = 1; round <= maxRounds; round++) {
    roundsDone = round;
    const queries = buildQueries(effectiveQuery, round);
    for (const q of queries) {
      queriesTried.push(q);
      let sr;
      try { sr = await exaSearcher(q, 3); } catch { sr = []; }
      allResults = dedupResults([...allResults, ...sr]);
      if (sr.some(r => (r.text || "").length > 100)) break;
    }
    bestConfidence = scoreConfidence(allResults, taskTitle);
    if (bestConfidence === "C4" || bestConfidence === "C3") break;
    if (bestConfidence === "C2" && round >= 2) break;
  }

  return { allResults, bestConfidence, roundsDone, queriesTried };
}

export async function deltaCompare(taskTitle, searchResults, vaultBaseline) {
  const searchDigest = searchResults.slice(0, 5).map(r => "URL: " + r.url + " / 标题: " + (r.title || "") + " / 摘要: " + (r.text || "").slice(0, 400)).join("\n---\n");
  const prompt = "你是研究助手。主人搜索「" + taskTitle + "」。\n\n主人 vault 已有知识：\n" + vaultBaseline + "\n\n搜索到的网页结果：\n" + searchDigest + "\n\n请判断搜索结果跟主人已有知识的关系，输出以下内容：\n\n1. 增量比例：完全重复(0%) / 70%重复有小增量 / 50%新增 / 90%+全部新增 — 选一个\n\n2. 核心insight（前2句，不是百科介绍，是主人不知道的新信息）\n\n3. 与已有知识的联系（跟vault里哪个项目/概念有关，怎么补充了它）\n\n4. 可行动项（主人能拿这个信息做什么，一句话）\n\n5. related wikilinks（跟vault里已有笔记的链接，格式 [[笔记名]]）\n\n6. 来源链接（1-3个最有价值的URL）\n\n规则：不抄网页原文。只写主人不知道的增量。中文。正文不超过500字。如果完全重复，只输出「无新增」和原因。";
  const messages = [
    { role: "system", content: "你是研究助手，帮主人判断搜索结果相比已有知识的增量价值。只输出增量，不抄网页原文。" },
    { role: "user", content: prompt }
  ];
  let resp;
  try { resp = await deepSeekCaller(messages); } catch (e) { return "ERROR: " + e.message; }
  if (resp && resp.choices && resp.choices[0] && resp.choices[0].message) return resp.choices[0].message.content || "";
  return "";
}

export function prepareGitHubOps(result, vars) {
  const ops = [];
  const v = vars || stateVars;
  const d = result;

  if (d.action === "selected") {
    ops.push({ method: "PUT", path: d.selected_path, body: { message: d.selected_msg, content: d.selected_b64, branch: v.BRANCH } });
    ops.push({ method: "PUT", path: d.renamed_path, body: { message: d.renamed_msg, content: d.renamed_b64, branch: v.BRANCH } });
    if (d.old_sha) ops.push({ method: "DELETE", path: d.old_path, body: { message: "researcher: remove task " + d.task_title, sha: d.old_sha, branch: v.BRANCH } });
  } else if (d.action === "c1") {
    ops.push({ method: "PUT", path: d.renamed_path, body: { message: d.renamed_msg, content: d.renamed_b64, branch: v.BRANCH } });
    if (d.old_sha) ops.push({ method: "DELETE", path: d.old_path, body: { message: "researcher: remove task " + d.task_title, sha: d.old_sha, branch: v.BRANCH } });
  }

  return ops;
}

export async function executeGitHubOps(ops) {
  const results = [];
  for (const op of ops) {
    try {
      const resp = await ghCaller(op.method, op.path, op.body);
      results.push({ ok: true, method: op.method, path: op.path, resp });
    } catch (e) {
      results.push({ ok: false, method: op.method, path: op.path, error: e.message });
    }
  }
  return results;
}

// ============ Main pipeline ============

export async function processResearchTask(task, opts = {}) {
  const maxRounds = opts.maxRounds ?? 3;
  const d = task.json !== undefined ? task.json : task;
  if (d.no_tasks) return { no_action: true };

  let taskBody = "";
  try { taskBody = Buffer.from(d.content || "", "base64").toString("utf8").trim(); } catch {}
  const taskTitle = d.task_title || (d.name || "").replace(/^#task researcher\s*/, "").replace(/\.md$/, "").trim();
  const searchHint = taskBody && !taskBody.startsWith("---") ? taskBody.split("\n")[0].slice(0, 100) : "";
  const effectiveQuery = searchHint ? taskTitle + " " + searchHint : taskTitle;

  const vaultBaseline = await readVaultBaseline();
  const { allResults, bestConfidence, roundsDone, queriesTried } = await searchLoop(taskTitle, effectiveQuery, maxRounds);

  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const slugBase = taskTitle.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "").slice(0, 60);
  const slug = "researcher-" + today + "-" + slugBase;

  if (bestConfidence === "C2" || bestConfidence === "C3" || bestConfidence === "C4") {
    const insight = await deltaCompare(taskTitle, allResults, vaultBaseline);
    const hasIncrement = insight && !insight.startsWith("ERROR") && !insight.includes("无新增");

    if (hasIncrement) {
      const topics = taskTitle.split(/\s+/).filter(w => w.length > 1).slice(0, 5);
      const confDesc = bestConfidence === "C4" ? "官方/一手来源" : bestConfidence === "C3" ? "2+独立来源交叉验证" : "单一可信来源";
      const sourceUrls = allResults.slice(0, 3).map(r => "- [" + (r.title || r.url).slice(0, 80) + "](" + r.url + ")");
      const md = "---\ntype: selected-content\nsource: researcher-agent\nconfidence: " + bestConfidence + "\ndate: " + today + "\ntopics: [" + topics.map(t => JSON.stringify(t)).join(", ") + "]\nsource_key: " + slug + "\n---\n\n# " + taskTitle + "\n\n" + insight + "\n\n## 来源\n" + sourceUrls.join("\n") + "\n\n---\n置信度: " + bestConfidence + " (" + confDesc + ") | 搜索轮次: " + roundsDone + " | Vault baseline: 已读取";
      const mdB64 = Buffer.from(md, "utf8").toString("base64");
      const renamedName = d.name.replace("#task researcher", "#done researcher");
      const renamedB64 = Buffer.from(taskBody || "# " + taskTitle, "utf8").toString("base64");
      return {
        action: "selected", confidence: bestConfidence, task_title: taskTitle,
        selected_path: "30_Research/Selected/" + slug + ".md", selected_b64: mdB64,
        selected_msg: "researcher: " + taskTitle + " (" + bestConfidence + ")",
        old_path: d.path, old_sha: d.sha,
        renamed_path: "00_Inbox/" + renamedName, renamed_b64: renamedB64,
        renamed_msg: "researcher: rename #task -> #done " + taskTitle,
        queries_tried: queriesTried, rounds: roundsDone,
      };
    } else {
      const notice = taskBody + "\n\n#result C3 无新增\n搜索结果与主人已有知识完全重复。\n\n" + insight;
      const noticeB64 = Buffer.from(notice, "utf8").toString("base64");
      const renamedName = d.name.replace("#task researcher", "#result C3 无新增 researcher");
      return {
        action: "c1", confidence: bestConfidence, task_title: taskTitle,
        old_path: d.path, old_sha: d.sha,
        renamed_path: "00_Inbox/" + renamedName, renamed_b64: noticeB64,
        renamed_msg: "researcher: C3 no increment " + taskTitle,
        queries_tried: queriesTried, rounds: roundsDone,
      };
    }
  } else {
    const notice = taskBody + "\n\n#result C1\n搜索 " + roundsDone + " 轮未找到 C2+ 来源。";
    const noticeB64 = Buffer.from(notice, "utf8").toString("base64");
    const renamedName = d.name.replace("#task researcher", "#result C1 researcher");
    return {
      action: "c1", confidence: bestConfidence, task_title: taskTitle,
      old_path: d.path, old_sha: d.sha,
      renamed_path: "00_Inbox/" + renamedName, renamed_b64: noticeB64,
      renamed_msg: "researcher: C1 result " + taskTitle,
      queries_tried: queriesTried, rounds: roundsDone,
    };
  }
}
