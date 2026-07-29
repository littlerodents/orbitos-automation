import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("daily launchd template is uninstalled, dry-run, weekday 08:00, and key-free", () => {
  const plist = readFileSync("com.evander.orbitos-synthesis-daily.plist.template", "utf8");
  assert.match(plist, /orbitos-synthesis-launchd\.sh/);
  assert.match(plist, /--dry-run/);
  assert.match(plist, /<key>Hour<\/key><integer>8<\/integer>/);
  assert.match(plist, /<key>Minute<\/key><integer>0<\/integer>/);
  for (const weekday of [1, 2, 3, 4, 5]) assert.match(plist, new RegExp(`<key>Weekday</key><integer>${weekday}</integer>`));
  assert.match(plist, /\/Users\/shadow\/Library\/Logs\/orbitos-synthesis-daily\.launchd\.out\.log/);
  assert.match(plist, /\/Users\/shadow\/Library\/Logs\/orbitos-synthesis-daily\.launchd\.err\.log/);
  assert.doesNotMatch(plist, /Work\/orbitos-automation\/orbitos-synthesis-daily\.launchd/);
  assert.doesNotMatch(plist, /api[_-]?key|authorization|bearer|token|secret/i);
});

test("weekly launchd template is uninstalled, dry-run, Sunday 10:00, and key-free", () => {
  const plist = readFileSync("com.evander.orbitos-synthesis-weekly.plist.template", "utf8");
  assert.match(plist, /orbitos-synthesis-launchd\.sh/);
  assert.match(plist, /--dry-run/);
  assert.match(plist, /<key>Weekday<\/key>\s*<integer>0<\/integer>/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.match(plist, /\/Users\/shadow\/Library\/Logs\/orbitos-synthesis-weekly\.launchd\.out\.log/);
  assert.match(plist, /\/Users\/shadow\/Library\/Logs\/orbitos-synthesis-weekly\.launchd\.err\.log/);
  assert.doesNotMatch(plist, /Work\/orbitos-automation\/orbitos-synthesis-weekly\.launchd/);
  assert.doesNotMatch(plist, /api[_-]?key|authorization|bearer|token|secret/i);
});

test("launchd wrapper uses absolute node path and enforces Asia/Shanghai timezone", () => {
  const sh = readFileSync("orbitos-synthesis-launchd.sh", "utf8");
  assert.match(sh, /NODE="\/opt\/homebrew\/bin\/node"/);
  assert.match(sh, /Asia\/Shanghai/);
  assert.match(sh, /--dry-run/);
});
