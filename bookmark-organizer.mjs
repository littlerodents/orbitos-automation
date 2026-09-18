#!/usr/bin/env node
// bookmark-organizer: X 书签(X书签简报 board)自动整理
//   扫描 30_Research/YouMind/X书签简报/Materials/ 未处理文件 →
//   DeepSeek 分类/定级/提炼 → 写 30_Research/Selected/bookmarks-<date>.md →
//   源文件 frontmatter 打 processed 标记（不动正文）
// 手动: node bookmark-organizer.mjs [--limit 20] [--dry-run]
// 定时: com.evander.orbitos-bookmark-organizer.plist（每 6 小时一批，积压自动消化）

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./lib/config.mjs";

const cfg = loadConfig();
const DS_KEY = process.env.DEEPSEEK_API_KEY || cfg.deepseek_api_key || "";
const VAULT = cfg.vault_path;
const SRC_DIR = join(VAULT, "30_Research/YouMind/X书签简报/Materials");
const OUT_DIR = join(VAULT, "30_Research/Selected");

const TOPICS = [
  "ai-agent", "opc-indie", "seo-growth", "pai-infra",
  "learning-resource", "investment-thinking", "design-aesthetics", "other",
];

// --- 与 monitor-agent 同款重试 ---
async function withRetry(fn, attempts = 3, baseMs = 1000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        console.error(`retry ${i + 1}: ${e.message}`);
        await new Promise(r => setTimeout(r, baseMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}

async function callDeepSeek(messages) {
  return withRetry(async () => {
    const resp = await fetch(cfg.deepseek_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${DS_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.deepseek_model, messages, temperature: 0.3 }),
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`deepseek: ${resp.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  });
}

// --- frontmatter 最小解析（只认第一个 --- 块的 key: value 与 tags 列表） ---
function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { fm: null, body: raw, raw };
  const fmText = m[1];
  const fm = {};
  for (const line of fmText.split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv && kv[2].trim()) fm[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return { fm, body: raw.slice(m[0].length), fmText };
}

function markProcessed(raw, processedDate, intoFile) {
  const { fmText } = parseFrontmatter(raw);
  if (!fmText) return raw; // 无 frontmatter 的极少数：不标记，只跳过重复处理靠 state 文件
  const marked = fmText + `\nprocessed: "${processedDate}"\nprocessed_into: "[[${intoFile}]]"`;
  return raw.replace(/^---\n[\s\S]*?\n---/, `---\n${marked}\n---`);
}

function collectUnprocessed(limit) {
  if (!existsSync(SRC_DIR)) return [];
  const state = loadState();
  return readdirSync(SRC_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => {
      const p = join(SRC_DIR, f);
      const raw = readFileSync(p, "utf8");
      const { fm } = parseFrontmatter(raw);
      const id = fm?.youmind_id || f;
      return { file: f, path: p, raw, fm, id, mtime: statSync(p).mtimeMs };
    })
    .filter(x => !x.fm?.processed && !state.processed.includes(x.id))
    .sort((a, b) => a.mtime - b.mtime)
    .slice(0, limit);
}

function loadState() {
  const p = join(VAULT, ".bookmark-organizer-state.json");
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return { processed: [] }; }
}
function saveState(state) {
  writeFileSync(join(VAULT, ".bookmark-organizer-state.json"), JSON.stringify(state, null, 2));
}

function excerpt(x, max = 2200) {
  const { fm, body } = { fm: x.fm, body: x.raw };
  const url = fm?.url || "";
  const author = fm?.author || "";
  const text = body.replace(/\s+/g, " ").trim().slice(0, max);
  return { id: x.file, url, author, text };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg > -1 ? Number(args[limitArg + 1]) || 20 : 20;

  if (!DS_KEY) { console.error("no deepseek key"); process.exit(1); }

  const batch = collectUnprocessed(limit);
  if (!batch.length) { console.log("nothing to process"); return; }
  console.log(`processing ${batch.length} bookmarks (dry-run=${dryRun})`);

  const payload = batch.map(excerpt);
  const system = `你是 Evander 的书签整理员。他的主线：一人公司打法(OPC)、程序化SEO、个人AI基础设施(PAI)、AI agent 工程。对每条 X 书签输出一个 JSON 对象（数组）：
{"id":"原文件名","topic":"${TOPICS.join("|")} 之一","signal":"strong|medium|weak","essence":"一句中文 essence，≤40字","why":"与他主线的关联或'纯噪声'判断，≤60字","actionable":"可执行动作或空字符串"}
只输出 JSON 数组，不要 markdown 代码块。strong = 直接改变某个主线的打法/有具体数字/一手方法论；medium = 有用但可推迟；weak = 泛泛而谈/纯激励/广告。`;

  const user = payload.map(p => `### ${p.id}\nauthor: ${p.author}\nurl: ${p.url}\n内容: ${p.text}`).join("\n\n");
  const resp = await callDeepSeek([
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  let content = resp.choices?.[0]?.message?.content || "";
  content = content.replace(/^```(json)?\n?|```$/g, "").trim();
  let analyses;
  try { analyses = JSON.parse(content); }
  catch { console.error("LLM 输出不是合法 JSON，放弃本批（源文件未标记，下轮重试）:\n", content.slice(0, 400)); process.exit(1); }

  const byId = new Map(analyses.map(a => [a.id, a]));
  const today = new Date().toISOString().slice(0, 10);
  const outName = `bookmarks-${today}.md`;
  const existing = existsSync(join(OUT_DIR, outName));

  const sections = batch.map(x => {
    const a = byId.get(x.file) || { topic: "other", signal: "weak", essence: "(未解析)", why: "", actionable: "" };
    return `### [${a.signal}] ${a.essence}\n- 主题: ${a.topic} · 作者: ${x.fm?.author || "?"} · 原文: ${x.fm?.url || "?"}\n- 关联: ${a.why}${a.actionable ? `\n- 可做: ${a.actionable}` : ""}\n- 原始捕获: [[${x.file.replace(/\.md$/, "")}]]`;
  }).join("\n\n");

  const strong = batch.filter(x => byId.get(x.file)?.signal === "strong").length;
  const header = `---\ntype: selected-content\nsource: bookmark-organizer\ndate: ${today}\nstatus: unread\n---\n# X 书签整理 — ${today}\n\n> 本批 ${batch.length} 条 · strong ${strong} 条 · 主题分布: ${[...new Set(batch.map(x => byId.get(x.file)?.topic).filter(Boolean))].join(", ")}\n\n`;
  const bodyText = header + sections + "\n";

  if (dryRun) { console.log(bodyText.slice(0, 2000)); return; }

  // 同日追加
  if (existing) {
    const prev = readFileSync(join(OUT_DIR, outName), "utf8");
    writeFileSync(join(OUT_DIR, outName), prev + "\n" + sections + "\n");
  } else {
    writeFileSync(join(OUT_DIR, outName), bodyText);
  }

  // 标记源文件 + state
  const state = loadState();
  for (const x of batch) {
    try { writeFileSync(x.path, markProcessed(x.raw, today, outName.replace(/\.md$/, ""))); } catch (e) { console.error(`mark failed ${x.file}: ${e.message}`); }
    state.processed.push(x.id);
  }
  state.processed = [...new Set(state.processed)].slice(-500);
  saveState(state);
  console.log(`done → ${outName} (${batch.length} bookmarks, strong=${strong})`);
}

main().catch(e => { console.error(e); process.exit(1); });
