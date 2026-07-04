// Shared config loader — all modules read from ~/.config/orbitos-automation/config.json
// Friends fork the repo, edit config.json, and everything works.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".config", "orbitos-automation");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  vault_path: join(homedir(), "Obsidian", "OrbitOS"),
  lark_cli_path: join(homedir(), ".npm-global", "bin", "lark-cli"),
  feishu_user_id: "",
  github_owner: "",
  github_repo: "",
  github_branch: "main",
  cdp_proxy_url: "http://localhost:3456",
  n8n_base_url: "",
  deepseek_url: "https://api.deepseek.com/v1/chat/completions",
  deepseek_model: "deepseek-v4-pro",
  exa_api_url: "https://api.exa.ai/search",
};

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2));
    console.log(`[config] Created default config at ${CONFIG_FILE} — edit it with your values.`);
    return DEFAULTS;
  }
  const userConfig = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  return { ...DEFAULTS, ...userConfig };
}

export function getConfigPath() {
  return CONFIG_FILE;
}
