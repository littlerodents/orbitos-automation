import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const files = {
  daily: "com.evander.orbitos-result-daily.plist.template",
  weekly: "com.evander.orbitos-result-weekly.plist.template",
  push: "com.evander.orbitos-result-push-shadow.plist.template",
  primary: "com.evander.orbitos-result-evidence-primary.plist.template",
};

test("result launchd plists are valid, key-free, and use non-overlapping schedules", () => {
  for (const file of Object.values(files)) {
    const lint = spawnSync("/usr/bin/plutil", ["-lint", file], { encoding: "utf8" });
    assert.equal(lint.status, 0, lint.stderr || lint.stdout);
    assert.doesNotMatch(readFileSync(file, "utf8"), /api[_-]?key|authorization|bearer|secret/i);
  }

  const daily = readFileSync(files.daily, "utf8");
  assert.match(daily, /<string>result-daily<\/string>/);
  assert.match(daily, /<string>--apply<\/string>/);
  assert.match(daily, /<key>Hour<\/key>\s*<integer>10<\/integer>/);
  assert.match(daily, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.doesNotMatch(daily, /<key>Weekday<\/key>/);

  const weekly = readFileSync(files.weekly, "utf8");
  assert.match(weekly, /<string>result-weekly<\/string>/);
  assert.match(weekly, /<key>Weekday<\/key>\s*<integer>0<\/integer>/);
  assert.match(weekly, /<key>Minute<\/key>\s*<integer>15<\/integer>/);

  const push = readFileSync(files.push, "utf8");
  assert.match(push, /<string>--send<\/string>/);
  assert.match(push, /<integer>300<\/integer>/);

  const primary = readFileSync(files.primary, "utf8");
  assert.match(primary, /<integer>900<\/integer>/);
  assert.match(primary, /orbitos-result-evidence-primary\.sh/);
});

test("cutover scripts pass zsh syntax and fail closed around live activation", () => {
  for (const file of [
    "orbitos-synthesis-launchd.sh",
    "orbitos-result-evidence-primary.sh",
    "orbitos-result-shadow-cutover.sh",
    "orbitos-result-deploy-from-primary.sh",
  ]) {
    const syntax = spawnSync("/bin/zsh", ["-n", file], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `${file}: ${syntax.stderr || syntax.stdout}`);
  }
  const shadow = readFileSync("orbitos-result-shadow-cutover.sh", "utf8");
  const primary = readFileSync("orbitos-result-deploy-from-primary.sh", "utf8");
  assert.match(shadow, /ORBITOS_CUTOVER_APPROVED/);
  assert.match(primary, /ORBITOS_CUTOVER_APPROVED/);
  assert.match(shadow, /ORBITOS_CLOUD_DAILY_WEEKLY_DISABLED/);
  assert.match(primary, /ORBITOS_CLOUD_DAILY_WEEKLY_DISABLED/);
  assert.match(shadow, /cd "\$REPO"/);
  assert.match(primary, /\/usr\/local\/bin\/node/);
  assert.match(primary, /ORBITOS_NODE/);
  assert.match(shadow, /com\.evander\.orbitos-synthesis-daily/);
  assert.match(shadow, /com\.evander\.orbitos-synthesis-weekly/);
  assert.match(shadow, /com\.evander\.orbitos-brief-push-shadow/);
  assert.doesNotMatch(shadow, /enable "\$DOMAIN\/\$old"/);
});

test("primary evidence sync is atomic, non-interactive, and keeps packets outside the vault", () => {
  const script = readFileSync("orbitos-result-evidence-primary.sh", "utf8");
  assert.match(script, /BatchMode=yes/);
  assert.match(script, /HostKeyAlias/);
  assert.match(script, /evander-shadowdeMac-mini\.local/);
  assert.match(script, /\.local\/share\/orbitos-result-evidence/);
  assert.match(script, /\.tmp-primary/);
  assert.match(script, /chmod 600/);
  assert.match(script, /mv '\$REMOTE_TMP' '\$REMOTE_FILE'/);
  assert.doesNotMatch(script, /Obsidian|evander-orbitos-vault|sk-[A-Za-z0-9]/);
});
