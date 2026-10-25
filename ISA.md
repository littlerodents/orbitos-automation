---
task: "内容生命周期减少机制"
slug: 20261012-orbitos-lifecycle-reduce
phase: complete
progress: 32/32
started: 2026-10-12T06:30:00Z
updated: 2026-10-24T16:00:00Z
iteration: 1
---

# ISA · OrbitOS 内容"减少"机制（通电 + 归档器）

## Problem

OrbitOS 的内容管线只有增量、没有减量：
- `30_Research/YouMind/X书签简报/Materials/` 86 篇处理完只打 `processed` 标记，文件原地不动、只增不减；
- `30_Research/Selected/bookmarks-*.md` 批次只增；
- 飞书 Intake Base 的状态机里有 `archived`，`reconcile-records` 也实现了"源文件已删/被替代且无人工信号 → 自动归档"，但**没有任何定时任务在跑它**（intake-loop 只跑 configure-views / sync-vault / promote）；
- `00_Inbox` 的旧归档停在 2026-09-16，之后无归档器。

结果：vault 活跃区永久膨胀，主人无法一眼看到"处理完的旧料去哪了"。

## Vision

处理完的旧内容会按规则自动移出活跃区、进入 `99_System/Archives/`，Base 行随源文件消失而自动归档；主人打开 vault 时看到的是"新鲜料"，档案馆里能找到旧料。收尾现象：**过两周再看 Materials，发现它自己在变短。**

## Out of Scope

- 不动 chrome-x-automation / cdp-proxy（主人明确说留着）。
- 不改 bookmark-organizer 的分类逻辑；不碰 Readwise、OPC 语料、`2月28 推特学习`、`Chaos`。
- 不做通用 TTL 框架；只覆盖 Materials + Selected 两个活跃堆积点 + 一次性 x-to-markdown 归拢。
- 不重写 README 的 n8n 时代架构图。

## Constraints

- 只移不删；目标重名 → 跳过并计数，绝不覆盖。
- 失败必须可见（日志 + run-with-alert 告警链）。
- 改动落在 `~/Labs/codex/orbitos-automation/`（受清理守卫管辖：先 git status、经 commit 协调）。
- 复用现有约定：run-with-alert 包装、ensure-jobs 守护名单、`launchd/` plist 快照、`lib/config.mjs` 取 vault 路径。

## Goal

六条 ISC 全绿：reconcile 通电、归档器（Materials + Selected）可证伪地工作且幂等、launchd 任务被守护、散落 x-to-markdown 收进 vault、机械闸门 exit 0。

## Not yet specified

- 阈值 N=30 天 / K=12 批是否长期合适（先用默认，观察两周再调）。
- Materials 归档后 Base 行的 `[源文件已移除]` 前缀体验（首次真实归档后由主人评判）。

## Test Strategy

| isc | type | check | threshold | tool | anchors_to | severity |
|---|---|---|---|---|---|---|
| ISC-1 | bash | `orbitos-intake-loop.sh` 每轮调用 reconcile-records，日志有 reconcile 行，失败进 exit 码 | 日志出现 `reconcile-records:` 且 exit 0 | zsh + grep | literal | high |
| ISC-2 | bun-test | `tests/archive-sweeper.test.mjs` 全绿；沙盒真实移动 + 幂等重跑 | ≥6 断言全 pass，重跑 0 移动 | node --test | derived | high |
| ISC-3 | bash | Selected 只留最新 12 批（fixture 15 → 3 移出；真实目录 4 批 → 0 移动） | 精确 3/0 | node --test + dry-run | derived | high |
| ISC-4 | bash | `launchctl print gui/$UID/com.evander.orbitos-archive-sweeper` 存在；ensure-jobs 名单含它；仓库 `launchd/` 有快照 | 三处都在 | launchctl + grep | literal | high |
| ISC-5 | bash | 8 篇散落 x-to-markdown 进 vault（manifest 记录），旧路径不再存在 | 8/8 存在且源消失 | ls + manifest | derived | medium |
| ISC-6 | bash | 机械闸门 `closeloop-verify.ts <claim.json>` | exit 0（stage DONE） | bun | literal | high |

## Features

### F1 · reconcile 通电

Why: Base 状态机的归档能力已实现但没接线，等于墙上开关。

- [x] ISC-1: intake-loop 每 10 分钟一轮里调用 `reconcile-records`，日志与退出码可见。

### F2 · 归档器（sweep）

Why: Materials/Selected 只增不减，活跃区被旧料淹没。

- [x] ISC-2: `orbitos-archive-sweeper.mjs` 能把「processed ≥ 30 天」的 Materials 移到 `99_System/Archives/X书签简报/<YYYY>/<MM>/`，只移不删、重名跳过、重复运行幂等。
- [x] ISC-3: Selected 只保留最新 12 批 `bookmarks-*.md`，更旧的移入 `99_System/Archives/Selected/<YYYY>/`。

### F3 · 定时与守护

Why: 机制必须自动跑、掉线自愈，否则又是"装好没人开"。

- [x] ISC-4: `com.evander.orbitos-archive-sweeper`（每天 04:30）加载并进入 ensure-jobs 守护名单 + 仓库快照。

### F4 · 一次性归拢

Why: 手动存的推文散落 5 处，vault 里只有 1 篇。

- [x] ISC-5: 8 篇散落 x-to-markdown 收进 vault `x-to-markdown/`，留 manifest。

### F5 · 机械闸门

Why: 正式交付需要机械闸门放行，不是自我评价。

- [x] ISC-6: closeloop-verify exit 0（2026-10-15 12:04 判定：stage DONE / exit 0；owner_notes 注明 OWNER_ENTRYPOINT 为 BROWSER 机器证据口径）。

### F6 · 全自动（2026-10-15 主人反馈后补）

Why: 主人反馈「没通、半自动、叫你才动」——减少必须由系统自己发生，不依赖任何人工触发。

- [x] ISC-7: 归档器随 intake-loop（每 10 分钟、launchd 自动节拍）执行；实测 2026-10-15 11:49:26 自主跑出 `sweep=0` 并一次归档 86 篇（Materials→0，Archives/X书签简报→86），无任何人工触发；独立日任务（04:30）保留为双保险。

## Anti-claims

- A1: 归档器不得移动未到期或未处理的文件 → 单测覆盖"fresh/unmarked 不动"。
- A2: 目标重名时不得覆盖 → 单测覆盖冲突分支，原文件内容不变。
- A3: reconcile 首跑不得出现异常大规模误归档 → 真实执行前先 `--dry-run` 核对 counts。
- A4: ensure-jobs 不得因新任务刷失败日志 → 手动跑一次 ensure-jobs.sh，确认无 `FAILED`/`missing`。
- A5: 上游同步不得再洗掉本地 `processed` 标注 → 修复后实测一轮真实同步 `changed=0`，86 篇标记全存活（2026-10-15）。

## Decisions

- D1 归档锚点用 frontmatter `processed:` 日期（唯一可靠的"已完成"信号）；state 已处理但缺标记的 19 篇用一次性 `backfill-marks` 补 `processed: 2026-10-02`（state 文件最后写入日，保守上界）。被否：用文件 mtime（等于同步时间，不反映处理）。
- D2 归档目的地按内容日期（fm `date`）分 `YYYY/MM`，档案馆镜像内容时间线。被否：按处理时间分月（与内容无关）。
- D3 reconcile 挂进 10 分钟一班（与 sync-vault 同频，复用既有 auth 与负载模型），顺序 `sync-vault → promote → reconcile`。被否：单独开低频任务（多一个守护面，收益小）。
- D4 Selected 保留最新 12 批（CLI 可覆盖）。被否：保留全部（不减）。
- D5 归档器自带 git 提交（`--no-git` 可关），提交失败不算任务失败（下一轮 git-sync/obsidian-git 兜底）。被否：依赖 obsidian-git（不可控）。
- D6 顺手修正 ensure-jobs 名单里 monitor-timeline-fetcher 的标签笔误（多写了 `orbitos-`，导致它从未被真正守护、每轮刷 "missing" 日志）。证据：`ensure-jobs.log` 长期出现该行。
- D7 修复 `sameCellValue` 的 datetime 比较（Base 存 ISO，本地算 `YYYY-MM-DD HH:mm:ss`）：不修则 reconcile 每轮把 203 个 current 行全量重写。修后首轮 327→165 diff，跑一遍后收敛为 0。证据：`evidence/2026-10-12-lifecycle/reconcile-dry-run.txt` 与 runtime.txt。
- D8 `gitCommitMoves` 只对 vault 内路径做 `git add`：collect 的源路径在 vault 外，直接传给 git 会被拒（首跑移动成功但提交失败；已修复 + e2e 复验，真实 vault 的迁移已补交为 `b033128`）。
- D9 归档窗口 30 天 → 7 天（2026-10-15）：主人反馈「没减」——30 天窗口把 67 篇卡到 10-16、19 篇卡到 11-01，机制存在但不可见；改为 7 天后 86 篇积压当日全归档（`--days` 可调）。
- D10 调度改为随 intake-loop（10 分钟）执行 + 独立日任务双保险：原计划改独立任务为「每小时+加载即跑」，重载（launchctl bootout）被 PAI 安全闸门拦下（判为停关键服务）；按规矩不绕道，改走「把 sweep 挂进已在自动跑的 intake-loop」——不停止/重载任何服务即获得更高频的自动节拍。
- D11 youmind-sync 替换正文时保留本地 frontmatter 独有字段（processed / processed_into 等）：根因修复——2026-10-12 实证一轮同步 `changed=19` 专门洗掉本地标记（且使这些文件永远无法到期归档）；修复后真实同步 `changed=0`，标记稳定。

## Verification

全套复跑：`node --test tests/*.test.mjs` → 121 pass / 5 fail（失败为 9/21 n8n 退役遗留的 5 个孤儿测试，import 的文件已删除，不在本次范围；其余全绿，含 archive-sweeper 6 + intake-records 18 + youmind-sync 7）

- ISC-1: `zsh orbitos-intake-loop.sh` exit 0；自动运行日志 `[2026-10-15 11:49:26 CST] ... reconcile=0 sweep=0`；真实 reconcile 首轮 `updated=165`，复跑 `updated=0; unchanged=366; diffs=none`（evidence/2026-10-12-lifecycle/runtime.txt）
- ISC-2: 单测全绿；CLI 沙盒真移动 + 幂等 + 冲突保护 + 回滚重归档（redteam.txt E1–E3）
- ISC-3: 单测 15 批 → 保留 12 / 移出 3；真实目录 4 批 → eligible=0
- ISC-4: `launchctl print gui/501/com.evander.orbitos-archive-sweeper` 存在；ensure-jobs 名单含 archive-sweeper（monitor 标签笔误已修）；仓库 `launchd/` 快照已放
- ISC-5: vault 内 `x-to-markdown/` 10 文件（9 收拢 + 1 原有），旧位置残留 0，manifest 提交 `f4aff5b`/`b033128`
- ISC-6: 机械闸门 `closeloop-verify.ts evidence/2026-10-12-lifecycle/claim.json` → **exit 0 / stage DONE**（SOURCE/BUILD/RUNTIME/OWNER_ENTRYPOINT 全 verified；owner_notes：OWNER_ENTRYPOINT 由代理自证（BROWSER），非主人确认）
- ISC-7: **2026-10-15 11:49:26 由 launchd 自动节拍自主执行**（intake-loop 第 N 轮，无人工触发）：日志 `launch: OrbitOS intake loop exit views=0 sync=0 promote=0 reconcile=0 sweep=0`；归档提交 `fee7906 archive: sweep materials=86 selected=0`；Materials 86→0，`99_System/Archives/X书签简报/` 0→86；第二轮（也是自动）起 sweep 稳定 moved=0（幂等）
- 附：youmind-sync 根因修复实测——修复前 2026-10-12 一轮 `changed=19`（专洗本地标记）；修复后 2026-10-15 实测 `changed=0`，86 篇 `processed` 标记全存活
- 附：Feishu Intake Base：raw=203 / archived=163（10-12 首轮）→ 10-15 12:02:04 自动轮后 **raw=120 / archived=249**（本批 86 行由自动 reconcile 跟进归档，闭环成立）

## Remaining Work

- 无待办（7/7 全关闭）。观察点：新书签随 YouMind 同步进入 Materials，处理满 7 天后由 10 分钟自动节拍归档；每天 04:30 独立任务双保险。
- 已知局限：Materials 归档会让 Intake Base 对应行变「[源文件已移除] + archived」（设计如此，链路已通）；`.bookmark-organizer-state.json` 中的 processed id 不随归档清理（无害，未处理）；全量测试中 5 个失败为 9/21 n8n 退役遗留的孤儿测试（不在本次范围）。

---

# 附：F7 · GitHub Trending → 日报（2026-10-24 增量）

## Problem
日报的输入全来自 vault 内部（书签/研究/行动），没有"外部工具生态在变什么"的信号。

## Goal
每天日报的 prompt 里带一份 GitHub Trending 快照 + 与上次相比的新上榜项；失败不影响日报主体。

## Out of Scope
不写 vault（快照只留 `~/.config/orbitos-automation/github-trending.json`）；不进周报；不做"趋势→商业判断"的推导。

## Features
- [x] ISC-8: `github-trending.mjs` 能真抓 daily/weekly 并解析出 repo/stars/gain/lang/desc（tests 7/7，真实抓取 10 条）。
- [x] ISC-9: 首跑标"首次快照无对比基线"，次日按 firstSeen 标 `★新`，同日重跑标记稳定。
- [x] ISC-10: 日报 prompt 含「GitHub Trending」段，SYSTEM 明确禁止把它当市场信号；无相关项时输出「今日无相关」。
- [x] ISC-11: 抓取失败/HTML 变异 → 返回空、日报照常生成（红队 E1/E2 实证）。
- [x] ISC-12: `orbitos-daily-brief.mjs --dry-run` 存在且无副作用（不写 vault/不 commit/不调 tracker）。
- [x] ISC-13: `orbitos-daily-brief.mjs` 被 import 不再触发 main（真实事故回归，红队 E3 PASS）。

## Decisions
- D12 只进 prompt，不单独写 vault：trending 的价值在"变化"，落盘会变成只增不减的文件（与 lifecycle 机制相悖）。
- D13 快照只保留 30 天内出现的 repo（pruneState），文件大小有上界。
- D14 首跑不标"新上榜"：无基线就不假装有变化。
- D15 周报不加 trending：周维度上"本周热门"无法区分工具热度与商业信号，容易误读。

## Verification
- 单测：`node --test tests/github-trending.test.mjs` → 7 pass；组合回归 38 pass（含 archive/intake/youmind）
- 真实抓取：`node github-trending.mjs --no-cache` → daily 10 条，字段完整
- 日报产物：`00_Inbox/brief-2026-10-24.md` 含「## 工具风向」3 条相关项（commit 5371a62）
- 红队：E1 网络失败→空且不抛；E2 空/变异 HTML→[]；E3 import 不写 vault（真实事故回归）；E4 30 天清理生效

## 事故记录（必须留痕）
2026-10-24 23:48，我用 `node -e 'import("./orbitos-daily-brief.mjs")'` 做模块加载检查，因该文件当时缺少 import 守卫，直接执行了 main：真实写入并 commit 了 `brief-2026-10-24.md` 与 `Today.md`（bbd895f / a2915e5）。当晚该日 brief 原本不存在（当日未生成），因此不是覆盖主人的既有产物，但**确实产生了未预期的真实写入**。
处置：补 import 守卫（本 ISA ISC-13），修完后重新生成一份含 trending 的正确版本（5371a62 / 25dd27b），并保留历史提交供审计。

---

# 附：F8 · 反向指标「对外账」（2026-10-24）

## Problem
系统所有指标都是内部的（积压数/归档数/brief 是否生成），没有一个"我让谁看见了我"。
追踪表 76 条里学习类 63 条（83%）、对外类 7 条（9%），对外 6 条未动、最久 26 天——这个事实从没在任何产物里出现过。

## Goal
每周周报出现「## 对外账」段：用追踪表实测数字回答"这周我让谁看见了我"，且关键结论由系统强制写入，不依赖 LLM 自觉。

## Constraints
- 行动表只有 4 个字段（行动/为什么/状态/开始卡于），**没有完成时间** → 不得输出"本周完成数"，不编造。
- "被拒绝次数"无数据源 → 只能写「未记录（系统无数据源）」，禁止 LLM 编造。
- 反向指标只进周报，不进日报（避免每天刷屏导致脱敏）。

## Features
- [x] ISC-14: 周报 prompt 含「对外账」实测区：对外/学习占比、未动数、最久卡龄、第一条摘要。
- [x] ISC-15: 条件命中（对外未动 ≥5 且最久 >14 天）时，系统在周报正文前强制插入一行注记，不依赖模型。
- [x] ISC-16: 被拒绝/被批评一行恒为「未记录（系统无数据源）」，任何情况下不出数字。

## Decisions
- D16 关键结论机器注入而非 prompt 要求：模型可能软化措辞，机械注记不会。
- D17 不造"本周完成数"：字段不存在就是不存在，宁可缺指标也不造假指标。
- D18 只进周报：周频才有"趋势感"，日频会脱敏。

## Verification
- 单测 6 pass（含边界 5/15 触发、4 条不触发、空数据不触发）
- 组合回归 44 pass
- 周报 dry-run 真实输出：`## 对外账` + `> ⚠️ 系统实测（非模型判断）：对外动作 6 条未动，最久 26 天；学习类占追踪表 83%`
- import 不写 vault（红线复核通过）

## Remaining Work
- **未验证**：周报真实落盘与飞书送达。周日 10:00 自动轮首次生效；今天不真跑，避免与周日同周文件重复推送。
- 若要"被拒绝次数"变成真指标，需要给行动表加「完成于」字段或一个手动记录入口——**需主人决定**。

---

# 附：F9 · 修复 strong → 行动表断点（C 方案：只修未来）

## Problem
Selected 里 19 条 strong、且 19 条全部带 actionable，行动表里 `精读：` 开头的是 **0 条**。

## 根因（取证后修正了最初的假设）
不是阈值太严，是**时间错位**：`pushBookmarkActions` 于 2026-09-18 12:06 加入；09-16/17 两批（15 条 strong）已在此前处理并打上 `processed` 标记，不会重跑；09-18 那批恰好 `strong=0`；此后 103 次运行全是 `nothing to process`（书签无新增）。

## Features
- [x] ISC-17: `planBookmarkActions()` 纯函数：strong + 非空 actionable 才生成行动，medium/weak 永不进表。
- [x] ISC-18: 每批上限 3 条的**超额部分必须可见**：Selected 头部与日志都写明「另 N 条仅存档」，不得声称"下批再处理"（源文件已 processed，不会重来）。
- [x] ISC-19: `--dry-run` 会打印 would-push 统计，不再静默跳过推送环节。
- [x] ISC-20: `bookmark-organizer.mjs` 补 import 守卫（此前 import 会触发真实处理+推送）。

## Decisions
- D19 选 C（只修未来）：历史 19 条 strong 的补推需要一次显式操作，属于"造一批没人认领的行动"，不做。
- D20 保留每批 3 条上限：追踪表已有 76 条、83% 是学习类，再灌 19 条只会让对外账更难看。上限不动，但把丢弃显性化。
- D21 回放验证代替真跑：历史批次已 processed，无法重放真实链路；用 planBookmarkActions 对 Selected 原文回放，验证"本应产出 9 条"。

## Verification
- 单测 5 pass（含 medium/weak 被挡、无 actionable 不计数、超额计数、缺失分析不伪造）
- 组合回归 49 pass
- 回放：strong=19 / actionable=19 → 本应推 9 / 超额 10（与每批 3 条上限一致）
- import 守卫：vault HEAD 未变、日志未增长

## Remaining Work
- **未验证**：真实新批次的推送（需等 YouMind 有新书签；当前已 30+ 天无新增）。
- 可选（需主人决定）：一次性补推历史 9 条 strong 行动到追踪表。

---

# 附：F10 · 教练模式（对外闸门，2026-10-25）

## Problem
21:00 提醒只催读书（追踪表 83% 已是学习类），对外动作 6 条卡 26 天无人推动。提醒是"服务"，不是"约束"。

## Goal
每天系统只在追踪表放 1 条对外动作；没做完，第二天不生成日报，只生成一页说明原因的教练反馈。

## Out of Scope
不自动发私聊、不改主人名单、不改 Base 字段结构、不惩罚周报（周报无闸门）。

## Features
- [x] ISC-21: 每天幂等生成 1 条 `[对外·私聊]` 行动；昨天未完成自动过期（挂在 intake-loop 10 分钟节拍，无需新 plist）。
- [x] ISC-22: `decideGate` 三态：昨天完成→放行；未完成→扣留并计连续天数；**无记录→放行**（刚上线不惩罚）。
- [x] ISC-23: 21:00 提醒对外优先——对外未做只说对外，并明示「明天日报不会生成」。
- [x] ISC-24: 扣留日写 `status: withheld` 的 brief（仍是文件+commit，所以 brief-push 会送达，不会静默失联）。
- [x] ISC-25: `--excuse 原因` 可豁免单日（出差/生病），豁免日不参与扣留与连续计数。

## Decisions
- D22 用追踪表当信号源（不加新字段）：主人本来就在打勾，零新增操作。
- D23 扣留不静默：写一页教练反馈并照常推送。否则主人会误判"系统坏了"（2026-10-19 已发生过一次误判）。
- D24 无记录放行：宁可漏拦一天，也不能因为系统刚上线就扣留。
- D25 常驻方式复用 intake-loop，不新建 launchd 任务：避开 `launchctl bootout` 的安全闸门，且获得 10 分钟粒度。

## Verification
- 单测 11 pass（闸门三态、连续计数、豁免、提醒优先级、扣留页不冒充日报）
- 组合回归 60 pass
- 真实：飞书行动表新增 1 行 `[对外·私聊]`（77 行，幂等不重复）
- 真实：launchd 自动轮 `02:28:17 ... sweep=0 outward=0`（无人触发）
- 真实：21:00 提醒发出（DM 内容含"明天日报不会生成"）
- 扣留页渲染：`status: withheld` + 无 TL;DR/学习增量/工具风向

## Remaining Work
- **未验证**：扣留分支的真实端到端（需要今天 10-25 的对外动作未完成，明天 10-26 才会自然触发）。今天是 `no-record → allow`。
- 若连续扣留超过 3 天仍不想做，应视为"这个主线不该用这个约束"——需主人重新决定，而不是系统加码。

---

# 附：F11 · 告警节流（④）+ F12 · 自检体系（2026-10-25）

## F11 Problem
近 7 天 53 条 `alert: orbitos-git-sync` commit，全部是网络抖动。ALERT 文件每次内容变化（时间戳+计数）→ 每次 commit，真故障信号被淹没。

## F11 Features
- [x] ISC-26: 节流策略抽为 `lib/alert-policy.sh`（可测）：每天首次失败必通知 + 2/5/20/50 里程碑。
- [x] ISC-27: 7 天回放证明：56 次失败只通知 11 次（改造前 56 次 commit）。

## F11 Decisions
- D26 保留"每天首次必通知"：跨天持续失败时主人仍能收到，不会因为计数不是里程碑而完全静默。
- D27 不在本次加"恢复通知"（会占用每天一条 DM 的配额），记入 Remaining。

## F12 Problem
主人无法分辨"哪个改动做得好、哪个做坏了"；我也犯过 7 类错（import 副作用、静默 catch、假承诺、私有证据进公开库、管道吞退出码、假设当结论、编指标）。

## F12 Goal
一条命令 `node selfcheck.mjs`，24 项检测给出 PASS/FAIL/SKIP；每项在 `CHECKS.md` 有 id、检测方法、失败含义、对应事故。

## F12 Features
- [x] ISC-28: 24 项检测（A 事故回归 7 / B 生命周期 4 / C trending 3 / D 反向指标 2 / E 断点 2 / F 教练 4 / G 节流 2）。
- [x] ISC-29: 只读设计——默认不改 vault、不调飞书写操作、不发消息。
- [x] ISC-30: 结果追加 `~/.config/orbitos-automation/selfcheck.jsonl`，可看哪项在反复失败。
- [x] ISC-31: 观察期机制：G2 在上线 24h 内显示 SKIP 而不是伪 PASS。
- [x] ISC-32: 空 catch 用 baseline（`tests/known-empty-catches.txt`）——只拦新增，不假装历史债已清。

## F12 Decisions
- D28 检测器自身要从扫描中排除：它的源码含检测用的正则字面量，否则自己判自己 FAIL。
- D29 F3 必须同时看脚本与日志：只看日志会在删掉调用后仍 PASS（红队 R2 实际抓到过这个缺陷并修正）。
- D30 不做"AI 判断我的判断对不对"：A6 只检查"有没有取证"，结论对错仍需主人反驳。

## F12 Verification
- 全量：23 PASS / 0 FAIL / 1 SKIP（G2 观察期）
- 红队 R1（关掉 import 守卫）→ A1 FAIL，恢复后 PASS
- 红队 R2（删 outward 调用，保留旧日志）→ F3 FAIL，恢复后 PASS；此实验发现并修正了 F3 只读日志的缺陷
- 二次运行结果一致（passed=23, failed=0, skipped=1）

## Remaining Work
- G2 需 24h 后才有真实结论（观察期跳过）。
- 扣留分支真实端到端（10-26 才可能触发）。
- 历史 12 处空 catch 属技术债，已登记 baseline，未修。
