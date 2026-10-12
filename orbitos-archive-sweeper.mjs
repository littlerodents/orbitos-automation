#!/usr/bin/env node
// orbitos-archive-sweeper — 内容生命周期"减少"机制（只移不删）
//   sweep（默认）:
//     Materials: frontmatter processed 满 N 天 → 99_System/Archives/X书签简报/<YYYY>/<MM>/
//     Selected : bookmarks-*.md 只保留最新 K 批，更旧 → 99_System/Archives/Selected/<YYYY>/
//   collect-x-to-markdown: 一次性，把散落在 ~ 下的 x-to-markdown 捕获收进 vault（留 manifest）
//   backfill-marks: 一次性，给 state 已处理但 frontmatter 缺 processed 的 Materials 补标记
// 手动: node orbitos-archive-sweeper.mjs [sweep|collect-x-to-markdown|backfill-marks] [--dry-run] [--days 30] [--keep 12] [--no-git]
// 定时: com.evander.orbitos-archive-sweeper（每天 04:30，经 run-with-alert 告警）
// 原则: 只移不删；目标重名 → 跳过并计数（绝不覆盖）；失败可见（计数 + 日志 + 告警链）。

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { loadConfig } from "./lib/config.mjs";

const cfg = loadConfig();
const VAULT = cfg.vault_path;
const MATERIALS_DIR = join(VAULT, "30_Research/YouMind/X书签简报/Materials");
const SELECTED_DIR = join(VAULT, "30_Research/Selected");
const ARCHIVE_ROOT = join(VAULT, "99_System/Archives");
const STATE_FILE = join(VAULT, ".bookmark-organizer-state.json");
const TIME_ZONE = "Asia/Shanghai";

function log(message) {
  process.stdout.write(`[archive-sweeper] ${message}\n`);
}

export function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv && kv[2].trim()) fields[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return fields;
}

function localDateStr(ms) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

// --- sweep: Materials ---

export function planMaterialsSweep({ materialsDir, archiveRoot, days, nowMs }) {
  const actions = [];
  const notReady = [];
  const missingMark = [];
  if (!existsSync(materialsDir)) return { actions, notReady, missingMark, files: 0 };
  const files = readdirSync(materialsDir).filter((f) => f.endsWith(".md")).sort();
  for (const file of files) {
    const fm = parseFrontmatter(readFileSync(join(materialsDir, file), "utf8"));
    const processed = fm.processed;
    if (!processed) {
      missingMark.push(file);
      continue;
    }
    const processedMs = Date.parse(`${processed}T00:00:00+08:00`);
    if (!Number.isFinite(processedMs) || nowMs - processedMs < days * 86400000) {
      notReady.push(file);
      continue;
    }
    // 目的地按内容日期分月（fm.date 优先，回退 processed），档案馆镜像内容时间线
    const originSource = /^\d{4}-\d{2}/.test(fm.date || "") ? fm.date : processed;
    const origin = originSource.slice(0, 7).replace("-", "/");
    actions.push({ from: join(materialsDir, file), to: join(archiveRoot, "X书签简报", origin, file) });
  }
  return { actions, notReady, missingMark, files: files.length };
}

// --- sweep: Selected ---

export function planSelectedSweep({ selectedDir, archiveRoot, keep }) {
  const actions = [];
  let kept = [];
  if (!existsSync(selectedDir)) return { actions, kept, files: 0 };
  const files = readdirSync(selectedDir)
    .filter((f) => /^bookmarks-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort(); // 按文件名日期升序
  const cut = Math.max(0, files.length - keep);
  kept = files.slice(cut);
  for (const file of files.slice(0, cut)) {
    const year = file.slice("bookmarks-".length, "bookmarks-".length + 4);
    actions.push({ from: join(selectedDir, file), to: join(archiveRoot, "Selected", year, file) });
  }
  return { actions, kept, files: files.length };
}

// --- 通用移动执行（sweep 与 collect 共用） ---

export function applyActions(actions, { dryRun = false, git = true, commitMessage = "archive: lifecycle sweep" } = {}) {
  const moved = [];
  const conflicts = [];
  const missing = [];
  for (const action of actions) {
    if (!existsSync(action.from)) {
      missing.push(action.from);
      continue;
    }
    if (existsSync(action.to)) {
      conflicts.push(action);
      continue;
    }
    if (dryRun) {
      moved.push(action);
      continue;
    }
    mkdirSync(dirname(action.to), { recursive: true });
    renameSync(action.from, action.to);
    moved.push(action);
  }
  let commit = null;
  if (!dryRun && git && moved.length > 0) {
    commit = gitCommitMoves(moved, commitMessage);
  }
  return { moved, conflicts, missing, commit };
}

function gitCommitMoves(moved, message) {
  try {
    // 只对 vault 内路径做 git 操作：collect 的源路径在 vault 外，直接传给 git add 会被拒。
    const insideVault = (p) => p === VAULT || p.startsWith(`${VAULT}/`);
    const paths = moved.flatMap((m) => [m.from, m.to]).filter(insideVault);
    if (paths.length === 0) return { ok: false, detail: "no vault paths to commit" };
    const add = spawnSync("git", ["-C", VAULT, "add", "-A", "--", ...paths], { encoding: "utf8" });
    if (add.status !== 0) return { ok: false, detail: (add.stderr || "").trim().slice(0, 300) };
    const commit = spawnSync("git", ["-C", VAULT, "commit", "-m", message], { encoding: "utf8" });
    if (commit.status !== 0) {
      const out = `${commit.stdout || ""}${commit.stderr || ""}`.trim();
      return { ok: /nothing to commit/i.test(out), detail: out.slice(0, 300) };
    }
    return { ok: true, detail: (commit.stdout || "").trim().slice(0, 200) };
  } catch (error) {
    return { ok: false, detail: String(error).slice(0, 200) };
  }
}

// --- 一次性: 收拢散落的 x-to-markdown ---

export function defaultCollectItems(home, vault) {
  const sources = [
    [join(home, "x-to-markdown/garrytan/2042925773300908103"), join(vault, "x-to-markdown/garrytan/2042925773300908103")],
    [join(home, "x-to-markdown/thedankoe/2010042119121957316"), join(vault, "x-to-markdown/thedankoe/2010042119121957316")],
    [join(home, "x-to-markdown/0xHvdes/2094075106096009695"), join(vault, "x-to-markdown/0xHvdes/2094075106096009695")],
    [join(home, "x-to-markdown/2010035785211289600/2010035785211289600"), join(vault, "x-to-markdown/2010035785211289600/2010035785211289600")],
    [join(home, "Labs/x-to-markdown/karpathy/1886192184808149383"), join(vault, "x-to-markdown/karpathy/1886192184808149383")],
    [join(home, "Labs/codex/x-to-markdown/2057094527236665598/2057094527236665598"), join(vault, "x-to-markdown/2057094527236665598/2057094527236665598")],
    [join(home, "Labs/codex/x-to-markdown/SebastienBubeck/2057187978720719114"), join(vault, "x-to-markdown/SebastienBubeck/2057187978720719114")],
    [join(home, "url-to-markdown/x.com/thread-by-karpathy.md"), join(vault, "x-to-markdown/karpathy/thread-by-karpathy.md")],
    [join(home, "url-to-markdown/x.com/thread-by-karpathy-captured.html"), join(vault, "x-to-markdown/karpathy/thread-by-karpathy-captured.html")],
  ];
  return sources.map(([from, to]) => ({ from, to }));
}

// --- 一次性: 补 processed 标记 ---

export function planBackfill({ materialsDir, stateFile }) {
  const updates = [];
  if (!existsSync(materialsDir) || !existsSync(stateFile)) return { updates };
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const known = new Set(state.processed || []);
  const dateStr = localDateStr(statSync(stateFile).mtimeMs); // 保守上界：state 最后写入日
  for (const file of readdirSync(materialsDir).filter((f) => f.endsWith(".md")).sort()) {
    const filePath = join(materialsDir, file);
    const fm = parseFrontmatter(readFileSync(filePath, "utf8"));
    if (fm.processed) continue;
    const id = fm.youmind_id || file;
    if (!known.has(id)) continue;
    updates.push({ path: filePath, date: dateStr });
  }
  return { updates };
}

function applyBackfill(updates, dryRun) {
  let changed = 0;
  for (const update of updates) {
    if (dryRun) {
      changed += 1;
      continue;
    }
    const raw = readFileSync(update.path, "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    writeFileSync(update.path, raw.replace(/^---\n[\s\S]*?\n---/, `---\n${m[1]}\nprocessed: "${update.date}"\n---`));
    changed += 1;
  }
  return changed;
}

// --- CLI ---

function numberFlag(args, name, fallback) {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return Number(inline.slice(name.length + 1)) || fallback;
  const idx = args.indexOf(name);
  if (idx >= 0) return Number(args[idx + 1]) || fallback;
  return fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith("--")) || "sweep";
  const dryRun = args.includes("--dry-run");
  const git = !args.includes("--no-git");
  const days = numberFlag(args, "--days", 30);
  const keep = numberFlag(args, "--keep", 12);
  const nowMs = Date.now();

  if (command === "sweep") {
    const materials = planMaterialsSweep({ materialsDir: MATERIALS_DIR, archiveRoot: ARCHIVE_ROOT, days, nowMs });
    const selected = planSelectedSweep({ selectedDir: SELECTED_DIR, archiveRoot: ARCHIVE_ROOT, keep });
    log(`materials: files=${materials.files}; eligible=${materials.actions.length}; not_ready=${materials.notReady.length}; missing_mark=${materials.missingMark.length}`);
    log(`selected: files=${selected.files}; eligible=${selected.actions.length}; kept=${selected.kept.length}`);
    for (const a of [...materials.actions, ...selected.actions]) log(`  move ${a.from} -> ${a.to}`);
    const result = applyActions([...materials.actions, ...selected.actions], {
      dryRun,
      git,
      commitMessage: `archive: sweep materials=${materials.actions.length} selected=${selected.actions.length}`,
    });
    log(`result: moved=${result.moved.length}; conflicts=${result.conflicts.length}; missing=${result.missing.length}; dry_run=${dryRun}`);
    for (const c of result.conflicts) log(`  conflict(skip): ${c.from} -> ${c.to}`);
    for (const m of result.missing) log(`  missing(skip): ${m}`);
    if (result.commit) log(`git: ok=${result.commit.ok} ${result.commit.detail}`);
    return;
  }

  if (command === "collect-x-to-markdown") {
    const items = defaultCollectItems(process.env.HOME, VAULT);
    log(`collect: items=${items.length}; dry_run=${dryRun}`);
    for (const item of items) log(`  move ${item.from} -> ${item.to}`);
    const result = applyActions(items, { dryRun, git, commitMessage: "archive: collect scattered x-to-markdown into vault" });
    log(`result: moved=${result.moved.length}; conflicts=${result.conflicts.length}; missing=${result.missing.length}`);
    if (result.commit) log(`git-moves: ok=${result.commit.ok} ${result.commit.detail}`);
    if (!dryRun) {
      const manifestPath = join(VAULT, "x-to-markdown", `.collect-manifest-${localDateStr(nowMs)}.json`);
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify({
        collected_at: new Date().toISOString(),
        moved: result.moved,
        conflicts: result.conflicts,
        missing: result.missing,
      }, null, 2));
      log(`manifest: ${manifestPath}`);
      if (git && result.moved.length > 0) {
        const add = spawnSync("git", ["-C", VAULT, "add", "--", manifestPath], { encoding: "utf8" });
        const commit = add.status === 0
          ? spawnSync("git", ["-C", VAULT, "commit", "-m", "archive: x-to-markdown collect manifest"], { encoding: "utf8" })
          : null;
        log(`git-manifest: ok=${Boolean(commit && commit.status === 0)}`);
      }
    }
    return;
  }

  if (command === "backfill-marks") {
    const { updates } = planBackfill({ materialsDir: MATERIALS_DIR, stateFile: STATE_FILE });
    log(`backfill: candidates=${updates.length}; dry_run=${dryRun}`);
    for (const u of updates) log(`  mark ${u.path} processed=${u.date}`);
    const changed = applyBackfill(updates, dryRun);
    log(`result: marked=${changed}`);
    return;
  }

  process.stderr.write(`unknown command: ${command}\nusage: orbitos-archive-sweeper.mjs [sweep|collect-x-to-markdown|backfill-marks] [--dry-run] [--days 30] [--keep 12] [--no-git]\n`);
  process.exitCode = 2;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(thisFile)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
