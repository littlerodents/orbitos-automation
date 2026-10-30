#!/usr/bin/env node
// disk-hygiene: 磁盘卫生（2026-10-30）
// 原则（按重建成本分层，不按时间瞎删）：
//   L1 可直接删  —— 重建成本 0：.runtime-cache / tmp / .c8coverage / node_modules / .venv / 大日志
//   L2 只报告    —— 外部可重取：下载的模型权重、数据集
//   L3 永不删    —— 你的文档、结果、交付物（本脚本不碰任何 .md/.json 结果）
// 触发条件：可用空间 < 阈值（默认 60G）才动手；空间充裕时只报告不动。
// 用法:
//   node disk-hygiene.mjs              # 按阈值决定是否清理
//   node disk-hygiene.mjs --dry-run    # 只报告
//   node disk-hygiene.mjs --force      # 忽略阈值，执行 L1 清理

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const THRESHOLD_GB = 60;          // 可用空间低于此值才清理
const STALE_DAYS = 7;             // L1 目录多久没动才删
const SCAN_ROOTS = [join(HOME, "Labs"), join(HOME, "Desktop", "2026-Evander-工作台")];
const L1_NAMES = new Set([".runtime-cache", "tmp", ".tmp-c8-src", ".c8coverage_tmp", "node_modules", ".venv"]);

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force");

function dfAvailableGB() {
  const out = execFileSync("df", ["-g", "/"], { encoding: "utf8" });
  const line = out.trim().split("\n").pop().trim().split(/\s+/);
  // df -g: Filesystem Size Used Avail Capacity ...
  return Number(line[3]);
}

function duSh(path) {
  try {
    const out = execFileSync("du", ["-sk", path], { encoding: "utf8", timeout: 30000 });
    return Number(out.split(/\s+/)[0]) * 1024; // bytes
  } catch {
    return 0;
  }
}

function ageDays(path) {
  try {
    return (Date.now() - statSync(path).mtimeMs) / 86400e3;
  } catch {
    return Infinity;
  }
}

// 只在 whitelist 目录名下清理，且必须在 SCAN_ROOTS 之内
function findL1(root, found = []) {
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === ".git") continue;
    const p = join(root, e.name);
    if (L1_NAMES.has(e.name)) {
      found.push({ path: p, bytes: duSh(p), age: ageDays(p) });
      continue; // 不再深入
    }
    // 控制深度，避免扫爆
    if (p.split("/").length - HOME.split("/").length < 5) findL1(p, found);
  }
  return found;
}

function fmt(bytes) {
  return bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)}G` : `${Math.round(bytes / 1e6)}M`;
}

function main() {
  const availBefore = dfAvailableGB();
  console.log(`[hygiene] 磁盘可用: ${availBefore}G（阈值 ${THRESHOLD_GB}G）`);

  const candidates = [];
  for (const root of SCAN_ROOTS) {
    if (existsSync(root)) candidates.push(...findL1(root));
  }

  const stale = candidates.filter((c) => c.age >= STALE_DAYS);
  const fresh = candidates.filter((c) => c.age < STALE_DAYS);
  const reclaimable = stale.reduce((s, c) => s + c.bytes, 0);

  console.log(`[hygiene] L1 候选: ${candidates.length} 个（可删 ${stale.length} 个 / ${fmt(reclaimable)}；${STALE_DAYS} 天内活跃 ${fresh.length} 个跳过）`);
  for (const c of stale.sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
    console.log(`  ${fmt(c.bytes).padStart(7)}  ${Math.round(c.age)}天  ${c.path.replace(HOME, "~")}`);
  }

  const shouldClean = force || availBefore < THRESHOLD_GB;
  if (!shouldClean) {
    console.log(`[hygiene] 空间充足，不清理（如需强制: --force）`);
    return;
  }
  if (dryRun) {
    console.log(`[hygiene] dry-run：将删除 ${stale.length} 个，释放约 ${fmt(reclaimable)}`);
    return;
  }

  let freed = 0;
  let removed = 0;
  for (const c of stale) {
    try {
      rmSync(c.path, { recursive: true, force: true });
      freed += c.bytes;
      removed += 1;
    } catch (e) {
      console.log(`  跳过（占用/权限）: ${c.path.replace(HOME, "~")} — ${String(e.message).slice(0, 60)}`);
    }
  }
  const availAfter = dfAvailableGB();
  console.log(`[hygiene] 已删 ${removed} 个目录，释放 ${fmt(freed)}；可用 ${availBefore}G → ${availAfter}G`);
}

main();
