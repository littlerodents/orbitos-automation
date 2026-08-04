// Following Monitor Agent Logic — fully decoupled via dependency injection.
// Fetches timeline from X following → filters by engagement → DeepSeek increment judgment → writes monitor digest.
// All external calls (timeline, tweet content, GitHub, DeepSeek) go through injectable runners.

// ============ Injectable runners (DI) ============
let timelineGetter = async () => { throw new Error("timelineGetter not configured"); };
let tweetContentGetter = async (_tweetId) => { throw new Error("tweetContentGetter not configured"); };
let ghCaller = async (_method, _path, _body) => { throw new Error("ghCaller not configured"); };
let deepSeekCaller = async (_messages) => { throw new Error("deepSeekCaller not configured"); };
let tabSignalsGetter = async () => { throw new Error("tabSignalsGetter not configured"); };
let stateVars = { OWNER: "", REPO: "", BRANCH: "" };

export function setTimelineGetter(fn) { timelineGetter = fn; }
export function setTweetContentGetter(fn) { tweetContentGetter = fn; }
export function setGhCaller(fn) { ghCaller = fn; }
export function setDeepSeekCaller(fn) { deepSeekCaller = fn; }
export function setTabSignalsGetter(fn) { tabSignalsGetter = fn; }
export function setStateVars(vars) { stateVars = vars; }
export function resetRunners() {
  timelineGetter = async () => { throw new Error("timelineGetter not configured"); };
  tweetContentGetter = async () => { throw new Error("tweetContentGetter not configured"); };
  ghCaller = async () => { throw new Error("ghCaller not configured"); };
  deepSeekCaller = async () => { throw new Error("deepSeekCaller not configured"); };
  tabSignalsGetter = async () => { throw new Error("tabSignalsGetter not configured"); };
  stateVars = { OWNER: "", REPO: "", BRANCH: "" };
}

// ============ Pure functions ============

export function getEngagementScore(tweet) {
  const likes = Number(tweet.likes) || 0;
  const retweets = Number(tweet.retweets) || 0;
  const replies = Number(tweet.replies) || 0;
  const quotes = Number(tweet.quotes) || 0;
  return likes + retweets + replies + quotes;
}

export function getPeriod(hour) {
  if (hour < 12) return "morning";
  return "afternoon";
}

export function isWithinHours(tweet, hours, now) {
  const created = new Date(tweet.created_at || tweet.created_at_iso || "");
  if (isNaN(created.getTime())) return false;
  const ref = now || new Date();
  const diffMs = ref.getTime() - created.getTime();
  return diffMs >= 0 && diffMs <= hours * 3600 * 1000;
}

export function filterByTime(tweets, hours, now) {
  return tweets.filter(t => isWithinHours(t, hours, now));
}

export function filterByEngagement(tweets, threshold) {
  return tweets.filter(t => getEngagementScore(t) >= threshold);
}

export function filterByEngagementWithTabSignals(tweets, threshold, activeAuthors) {
  const authorSet = new Set((activeAuthors || []).map(a => a.toLowerCase().replace(/^@/, "")));
  return tweets.filter(t => {
    const score = getEngagementScore(t);
    const author = (t.author || t.username || "").toLowerCase().replace(/^@/, "");
    // Active tab authors: threshold drops to 5
    if (authorSet.has(author)) return score >= 5;
    // Everyone else: normal threshold
    return score >= threshold;
  });
}

export function dedupByAuthor(tweets, maxPerAuthor) {
  const counts = new Map();
  return tweets
    .slice()
    .sort((a, b) => getEngagementScore(b) - getEngagementScore(a))
    .filter(t => {
      const author = t.author || t.username || "unknown";
      const count = counts.get(author) || 0;
      if (count >= maxPerAuthor) return false;
      counts.set(author, count + 1);
      return true;
    });
}

export function dedupBySeenIds(tweets, seenIds) {
  const seenSet = new Set(seenIds || []);
  return tweets.filter(t => {
    const id = String(t.id || t.tweet_id || "");
    return id && !seenSet.has(id);
  });
}

export function rankByEngagement(tweets, limit) {
  return tweets
    .slice()
    .sort((a, b) => getEngagementScore(b) - getEngagementScore(a))
    .slice(0, limit);
}

export function buildMonitorMarkdown(entries, date, period) {
  const lines = [
    "---",
    "type: following-monitor",
    "source: following-monitor-agent",
    `date: ${date}`,
    `period: ${period}`,
    "status: unread",
    "---",
    "",
    `# Following Monitor — ${date} ${period === "morning" ? "上午" : "下午"}`,
    "",
  ];
  if (entries.length === 0) {
    lines.push("今日关注对象无高互动新内容。");
    lines.push("");
    return lines.join("\n");
  }
  for (const e of entries) {
    lines.push(`## ${e.author} — ${e.title}`);
    lines.push(`likes=${e.likes} retweets=${e.retweets}`);
    lines.push(e.summary);
    if (e.increment) lines.push(`增量：${e.increment}`);
    if (e.url) lines.push(`[原文](${e.url})`);
    lines.push("");
  }
  return lines.join("\n");
}

// ============ Logic functions (use injectable runners) ============

export async function readVaultBaseline() {
  let baseline = "";
  const dirs = ["30_Research/Selected"];
  for (const dir of dirs) {
    let list;
    try { list = await ghCaller("GET", dir, null); } catch { continue; }
    if (!list || !Array.isArray(list)) continue;
    for (const f of list) {
      if (!f.name || !f.name.endsWith(".md")) continue;
      let file;
      try { file = await ghCaller("GET", f.path, null); } catch { continue; }
      if (!file || !file.content) continue;
      const text = Buffer.from(file.content, "base64").toString("utf8").slice(0, 400);
      baseline += "### " + f.name + "\n" + text + "\n\n";
    }
  }
  let inboxList;
  try { inboxList = await ghCaller("GET", "00_Inbox", null); } catch { inboxList = null; }
  if (inboxList && Array.isArray(inboxList)) {
    const briefs = inboxList.filter(f => f.name && f.name.startsWith("brief-")).slice(-2);
    for (const b of briefs) {
      let file;
      try { file = await ghCaller("GET", b.path, null); } catch { continue; }
      if (!file || !file.content) continue;
      const text = Buffer.from(file.content, "base64").toString("utf8");
      const pattern = text.match(/## PATTERN[\s\S]*?(?=## |$)/);
      if (pattern) baseline += "### " + b.name + " PATTERN\n" + pattern[0].slice(0, 400) + "\n\n";
    }
  }
  return baseline || "(vault empty)";
}

export async function getSeenIds() {
  try {
    const file = await ghCaller("GET", "00_Inbox/.monitor-seen-ids.json", null);
    if (file && file.content) {
      const data = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
      return Array.isArray(data) ? data : [];
    }
  } catch {}
  return [];
}

export async function getTabSignals() {
  try {
    const file = await ghCaller("GET", "00_Inbox/.monitor-tab-signals.json", null);
    if (file && file.content) {
      const data = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
      return data.active_authors || [];
    }
  } catch {}
  return [];
}

export async function saveSeenIds(ids) {
  // slice 防爆：无界增长终会撞 Contents API 1MB 上限，导致 PUT 永久失败、去重静默失效
  const b64 = Buffer.from(JSON.stringify(ids.slice(-2000))).toString("base64");
  try { await ghCaller("PUT", "00_Inbox/.monitor-seen-ids.json", { message: "monitor: update seen ids", content: b64, branch: stateVars.BRANCH }); }
  catch (e) { console.error("saveSeenIds failed:", e.message); }
}

export async function buildSummaryEntry(tweet, vaultBaseline) {
  const score = getEngagementScore(tweet);
  let fullContent = tweet.text || "";
  try {
    const content = await tweetContentGetter(String(tweet.id));
    if (content) fullContent = content.slice(0, 800);
  } catch {}
  // 空正文不进 LLM —— 否则会产出"无法判断增量"的垃圾 entry 写进 vault（2026-08-04 实证）
  if (!fullContent.trim()) return null;

  const prompt = '你是信息助手。主人关注的人发了一条推文。\n\n主人 vault 已有知识：\n' + vaultBaseline + '\n\n推文作者：' + (tweet.author || tweet.username || '') + '\n推文内容：' + fullContent + '\n互动量：' + score + '\n\n请输出：\n1. title: ≤20字中文标题（谁+说了什么）\n2. summary: ≤40字中文摘要\n3. increment: 这条对主人有什么增量？（如果没有增量，输出无增量）\n\n输出JSON: {"title":"","summary":"","increment":""}';

  let resp;
  try {
    resp = await deepSeekCaller([
      { role: "system", content: "你是信息助手，帮主人判断推文的增量价值。" },
      { role: "user", content: prompt }
    ]);
  } catch (e) {
    // fail loud：LLM 调用失败 ≠ "无增量"，日志里必须能区分
    console.error("deepSeekCaller failed for tweet", tweet.id, ":", e.message);
    return null;
  }

  if (!resp || !resp.choices || !resp.choices[0] || !resp.choices[0].message) return null;
  const text = resp.choices[0].message.content || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.title || !parsed.summary) return null; // 残缺的 entry 不收
    if (parsed.increment && /无(增量|法判断|新内容)/.test(parsed.increment)) return null;
    return {
      id: String(tweet.id || ""),
      author: tweet.author || tweet.username || "",
      title: parsed.title || "",
      summary: parsed.summary || "",
      increment: parsed.increment || "",
      likes: tweet.likes || 0,
      retweets: tweet.retweets || 0,
      url: tweet.url || ("https://x.com/i/status/" + tweet.id),
    };
  } catch { return null; }
}

// ============ Main pipeline ============

export async function processMonitorTask(opts = {}) {
  const hours = opts.hours || 24;
  const engagementThreshold = opts.engagementThreshold || 100;
  const maxPerAuthor = opts.maxPerAuthor || 2;
  const maxEntries = opts.maxEntries || 5;

  const now = new Date(); // 真实时间：时间过滤必须用它
  const cstNow = new Date(Date.now() + 8 * 3600 * 1000); // 北京时标签：仅用于 date/period 文件名
  const date = cstNow.toISOString().slice(0, 10);
  const period = getPeriod(cstNow.getUTCHours());

  // 拉取失败直接抛错（fail loud）——绝不容忍"故障被写成'今日无内容'的假 digest"
  const timeline = await timelineGetter();
  if (!timeline || !timeline.length) {
    const md = buildMonitorMarkdown([], date, period);
    return {
      action: "write",
      monitor_path: "00_Inbox/monitor-" + date + "-" + period + ".md",
      monitor_b64: Buffer.from(md, "utf8").toString("base64"),
      monitor_msg: "monitor: " + date + " " + period + " (no content)",
      date, period, entries: 0,
      owner: stateVars.OWNER, repo: stateVars.REPO, branch: stateVars.BRANCH,
    };
  }

  const seenIds = await getSeenIds();
  const filtered = dedupBySeenIds(timeline, seenIds);
  const recent = filterByTime(filtered, hours, now);
  
  // Read tab signals — active authors get lower engagement threshold (5 instead of 100)
  let activeAuthors = [];
  try { activeAuthors = await getTabSignals(); } catch {}
  const engaged = activeAuthors.length > 0
    ? filterByEngagementWithTabSignals(recent, engagementThreshold, activeAuthors)
    : filterByEngagement(recent, engagementThreshold);
  
  const deduped = dedupByAuthor(engaged, maxPerAuthor);
  const ranked = rankByEngagement(deduped, maxEntries * 3);

  const vaultBaseline = await readVaultBaseline();
  const entries = [];
  for (const tweet of ranked) {
    if (entries.length >= maxEntries) break;
    const entry = await buildSummaryEntry(tweet, vaultBaseline);
    if (entry) entries.push(entry);
  }

  const newSeenIds = [...new Set([...seenIds, ...entries.map(e => e.id)])];
  await saveSeenIds(newSeenIds);

  const md = buildMonitorMarkdown(entries, date, period);
  return {
    action: "write",
    monitor_path: "00_Inbox/monitor-" + date + "-" + period + ".md",
    monitor_b64: Buffer.from(md, "utf8").toString("base64"),
    monitor_msg: "monitor: " + date + " " + period + " digest",
    date, period,
    entries: entries.length,
    tweetsScanned: timeline.length,
    tweetsAfterFilter: ranked.length,
    owner: stateVars.OWNER, repo: stateVars.REPO, branch: stateVars.BRANCH,
  };
}
