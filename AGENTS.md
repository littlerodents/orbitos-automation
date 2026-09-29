# OrbitOS Automation — Agent 守则

本目录是 OrbitOS 自动化的唯一代码源：本地日报/周报生成、飞书追踪表同步、X 书签整理、git 同步、CDP 代理全部在这里，由 launchd 常驻运行。配置在 `~/.config/orbitos-automation/`。

## 清理/删除前的硬性规则

**动本目录或 `~/Library/LaunchAgents/` 里任何 `com.evander.*` 之前，必须先跑：**

```bash
cd ~/Labs/codex/orbitos-automation && git status
```

- 有**未提交的变更/删除**（` D` / ` M`）→ **停下来问主人**，不要继续删。
- 归档遗留文件只收进 `_retired-n8n-era/`（git mv），**不要直接 rm**。
- 改动后当场 `git commit`——这是断档恢复的唯一保险。

背景：2026-09-21 一次清理把本地日报管线（orbitos-daily-brief.mjs、orbitos-brief-push.mjs 等，它们**不是** n8n 文件）误删，系统静默空转 8 天。详见 git log "restore wrongly-deleted local brief pipeline"。

## 结构速查

- `orbitos-daily-brief.mjs` — 每天 11:30 日报（唯一大脑，删了系统就死）
- `orbitos-brief-push.mjs` — 每 5 分钟，日报送达飞书
- `bookmark-organizer.mjs` — 每 6 小时，X 书签→分类提炼→飞书行动表
- `feishu-tracker.mjs` — 日报尾部调用，写每日总结行 + 行动表维护
- `monitor-timeline-fetcher.mjs` — 每小时 X 时间线抓取（依赖 CDP 代理 :9222 专用 Chrome）
- `orbitos-git-sync.sh` — 每 5 分钟同步推送；**尾部挂着 ensure-jobs.sh 自愈守卫**
- `ensure-jobs.sh` + `launchd/` — 任务掉线自动拉起、plist 被删自动从仓库副本恢复；**和它对着干的删除会在 5 分钟内被恢复并飞书告警，请走 git 而不是 rm**

## 技术红线

- launchd 无 PATH：node 用绝对路径 `/opt/homebrew/opt/node@22/bin/node`，调 lark-cli 必须注入 PATH（现有脚本已处理，新脚本照抄模式）
- 提交信息 `chore: daily brief <date>` 是 brief-push 的识别正则，不能改作他用
- 大文件（PDF/epub/视频）永不进 OrbitOS 的 git
