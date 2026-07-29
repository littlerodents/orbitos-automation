import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("brief-push launchd template is uninstalled, dry-run, local mode, and key-free", () => {
  const plist = readFileSync("com.evander.orbitos-brief-push-shadow.plist.template", "utf8");
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /\/Users\/shadow\/Work\/orbitos-automation\/orbitos-brief-push-launchd\.sh/);
  assert.match(plist, /--dry-run/);
  assert.match(plist, /\/Users\/shadow\/Work\/evander-orbitos-vault/);
  assert.match(plist, /\/Users\/shadow\/Library\/Logs\/orbitos-brief-push-shadow\.launchd\.out\.log/);
  assert.match(plist, /\/Users\/shadow\/Library\/Logs\/orbitos-brief-push-shadow\.launchd\.err\.log/);
  assert.doesNotMatch(plist, /api[_-]?key|authorization|bearer|token|secret|user[_-]?id/i);
});

test("brief-push launchd wrapper uses absolute Shadow paths and explicit dry-run local mode", () => {
  const sh = readFileSync("orbitos-brief-push-launchd.sh", "utf8");
  assert.match(sh, /NODE="\/opt\/homebrew\/bin\/node"/);
  assert.match(sh, /REPO="\/Users\/shadow\/Work\/orbitos-automation"/);
  assert.match(sh, /DEFAULT_VAULT="\$\{ORBITOS_VAULT_PATH:-\/Users\/shadow\/Work\/evander-orbitos-vault\}"/);
  assert.match(sh, /--dry-run --local-repo "\$VAULT"/);
  assert.match(sh, /--bootstrap --local-repo "\$VAULT"/);
  assert.match(sh, /--send/);
  assert.match(sh, /orbitos-brief-push\.mjs" --local-repo "\$VAULT"/);
  assert.doesNotMatch(sh, /api[_-]?key|authorization|bearer|token|secret|user[_-]?id/i);
});
