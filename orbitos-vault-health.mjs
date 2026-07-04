#!/usr/bin/env node

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_VAULT = "/Users/evander/Obsidian/OrbitOS";
const MAX_TAGS_PER_NOTE = 8;
const MAX_SELECTED_TOPICS = 3;

const SKIP_DIRS = new Set([
  ".git",
  ".obsidian",
  ".trash",
  ".claude",
  ".codex",
  ".gemini",
  ".agents",
  "node_modules",
]);

function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function markdownFiles(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      markdownFiles(root, path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const abs = path.join(dir, entry.name);
    out.push({
      abs,
      rel: toPosix(path.relative(root, abs)),
      basename: path.basename(entry.name, ".md"),
    });
  }
  return out;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: text };
  const raw = text.slice(4, end).split(/\r?\n/);
  const data = {};
  let currentList = null;
  for (const line of raw) {
    const listItem = line.match(/^\s+-\s*(.*)$/);
    if (listItem && currentList) {
      data[currentList].push(cleanScalar(listItem[1]));
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) {
      currentList = null;
      continue;
    }
    const [, key, value] = pair;
    if (value === "") {
      data[key] = [];
      currentList = key;
      continue;
    }
    data[key] = parseScalarOrList(value);
    currentList = null;
  }
  return { data, body: text.slice(end + 4) };
}

function cleanScalar(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function parseScalarOrList(value) {
  const cleaned = cleanScalar(value);
  if (cleaned === "[]") return [];
  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    return cleaned.slice(1, -1).split(",").map(cleanScalar).filter(Boolean);
  }
  return cleaned;
}

function asList(value) {
  if (Array.isArray(value)) return value.map(cleanScalar).filter(Boolean);
  if (typeof value === "string") return value.split(",").map(cleanScalar).filter(Boolean);
  return [];
}

function wikilinkTargets(text) {
  const targets = [];
  const pattern = /!?\[\[([^\]]+)\]\]/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1].split("|")[0].split("#")[0].trim();
    if (!raw || /^https?:\/\//i.test(raw)) continue;
    targets.push(raw.replace(/\.md$/i, "").replace(/\\/g, "/"));
  }
  return targets;
}

function resolveTarget(target, byBase, byRelNoExt) {
  if (target.includes("/")) return byRelNoExt.get(target) || [];
  return byBase.get(target) || [];
}

function selectedNote(note) {
  return note.rel.startsWith("30_Research/Selected/") || note.frontmatter.type === "selected-content";
}

function auditVault({ vault = DEFAULT_VAULT } = {}) {
  const root = realpathSync(vault);
  const files = markdownFiles(root);
  const byBase = new Map();
  const byRelNoExt = new Map();
  const findings = [];
  const inbound = new Map();

  for (const file of files) {
    const relNoExt = file.rel.replace(/\.md$/i, "");
    byRelNoExt.set(relNoExt, [file.rel]);
    if (!byBase.has(file.basename)) byBase.set(file.basename, []);
    byBase.get(file.basename).push(file.rel);
    inbound.set(file.rel, 0);
  }

  for (const [basename, rels] of byBase.entries()) {
    if (rels.length <= 1) continue;
    findings.push({
      type: "duplicate-basename",
      severity: "warn",
      basename,
      files: rels,
      message: `Duplicate markdown basename '${basename}' appears ${rels.length} times.`,
    });
  }

  const notes = files.map((file) => {
    const text = readFileSync(file.abs, "utf8");
    const parsed = parseFrontmatter(text);
    return { ...file, text, frontmatter: parsed.data };
  });

  for (const note of notes) {
    for (const target of wikilinkTargets(note.text)) {
      const resolved = resolveTarget(target, byBase, byRelNoExt);
      if (!resolved.length) {
        findings.push({
          type: "broken-wikilink",
          severity: "warn",
          file: note.rel,
          target,
          message: `${note.rel} links to missing note [[${target}]].`,
        });
        continue;
      }
      for (const rel of resolved) inbound.set(rel, (inbound.get(rel) || 0) + 1);
    }
  }

  for (const note of notes) {
    const tags = asList(note.frontmatter.tags);
    const topics = asList(note.frontmatter.topics);
    const related = asList(note.frontmatter.related);
    if (tags.length > MAX_TAGS_PER_NOTE) {
      findings.push({
        type: "tag-inflation",
        severity: "warn",
        file: note.rel,
        count: tags.length,
        limit: MAX_TAGS_PER_NOTE,
        message: `${note.rel} has ${tags.length} tags; limit is ${MAX_TAGS_PER_NOTE}.`,
      });
    }
    if (selectedNote(note) && topics.length > MAX_SELECTED_TOPICS) {
      findings.push({
        type: "topic-inflation",
        severity: "warn",
        file: note.rel,
        count: topics.length,
        limit: MAX_SELECTED_TOPICS,
        message: `${note.rel} has ${topics.length} topics; selected notes should have at most ${MAX_SELECTED_TOPICS}.`,
      });
    }
    if (selectedNote(note) && related.length === 0 && (inbound.get(note.rel) || 0) === 0) {
      findings.push({
        type: "orphan-selected",
        severity: "warn",
        file: note.rel,
        message: `${note.rel} is selected but has no inbound wikilinks and no related property.`,
      });
    }
  }

  const counts = {
    files: files.length,
    duplicateBasenames: findings.filter((finding) => finding.type === "duplicate-basename").length,
    brokenWikilinks: findings.filter((finding) => finding.type === "broken-wikilink").length,
    orphanSelected: findings.filter((finding) => finding.type === "orphan-selected").length,
    tagInflation: findings.filter((finding) => finding.type === "tag-inflation" || finding.type === "topic-inflation").length,
  };

  return {
    ok: findings.length === 0,
    vault: root,
    counts,
    findings,
  };
}

function printHuman(result) {
  if (result.ok) {
    process.stdout.write(`OrbitOS vault health OK: ${result.counts.files} markdown files checked.\n`);
    return;
  }
  process.stdout.write(`OrbitOS vault health found ${result.findings.length} issue(s).\n`);
  for (const finding of result.findings) {
    process.stdout.write(`- [${finding.type}] ${finding.message}\n`);
  }
}

async function main() {
  const args = parseArgs();
  const vault = args.vault || DEFAULT_VAULT;
  if (!existsSync(vault) || !statSync(vault).isDirectory()) {
    throw new Error(`Vault does not exist or is not a directory: ${vault}`);
  }
  const result = auditVault({ vault });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHuman(result);
  }
  if (!result.ok) process.exitCode = 1;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(thisFile)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

export {
  auditVault,
  parseFrontmatter,
  wikilinkTargets,
};
