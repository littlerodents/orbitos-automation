---
task: "内容生命周期减少机制"
slug: 20261012-orbitos-lifecycle-reduce
phase: complete
progress: 7/7
started: 2026-10-12T06:30:00Z
updated: 2026-10-15T04:05:00Z
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
