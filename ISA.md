---
task: "内容生命周期减少机制"
slug: 20261012-orbitos-lifecycle-reduce
phase: in-progress
progress: 5/6
started: 2026-10-12T06:30:00Z
updated: 2026-10-12T08:55:00Z
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

- [ ] ISC-6: closeloop-verify exit 0。

## Anti-claims

- A1: 归档器不得移动未到期或未处理的文件 → 单测覆盖"fresh/unmarked 不动"。
- A2: 目标重名时不得覆盖 → 单测覆盖冲突分支，原文件内容不变。
- A3: reconcile 首跑不得出现异常大规模误归档 → 真实执行前先 `--dry-run` 核对 counts。
- A4: ensure-jobs 不得因新任务刷失败日志 → 手动跑一次 ensure-jobs.sh，确认无 `FAILED`/`missing`。

## Decisions

- D1 归档锚点用 frontmatter `processed:` 日期（唯一可靠的"已完成"信号）；state 已处理但缺标记的 19 篇用一次性 `backfill-marks` 补 `processed: 2026-10-02`（state 文件最后写入日，保守上界）。被否：用文件 mtime（等于同步时间，不反映处理）。
- D2 归档目的地按内容日期（fm `date`）分 `YYYY/MM`，档案馆镜像内容时间线。被否：按处理时间分月（与内容无关）。
- D3 reconcile 挂进 10 分钟一班（与 sync-vault 同频，复用既有 auth 与负载模型），顺序 `sync-vault → promote → reconcile`。被否：单独开低频任务（多一个守护面，收益小）。
- D4 Selected 保留最新 12 批（CLI 可覆盖）。被否：保留全部（不减）。
- D5 归档器自带 git 提交（`--no-git` 可关），提交失败不算任务失败（下一轮 git-sync/obsidian-git 兜底）。被否：依赖 obsidian-git（不可控）。
- D6 顺手修正 ensure-jobs 名单里 monitor-timeline-fetcher 的标签笔误（多写了 `orbitos-`，导致它从未被真正守护、每轮刷 "missing" 日志）。证据：`ensure-jobs.log` 长期出现该行。
- D7 修复 `sameCellValue` 的 datetime 比较（Base 存 ISO，本地算 `YYYY-MM-DD HH:mm:ss`）：不修则 reconcile 每轮把 203 个 current 行全量重写。修后首轮 327→165 diff，跑一遍后收敛为 0。证据：`evidence/2026-10-12-lifecycle/reconcile-dry-run.txt` 与 runtime.txt。
- D8 `gitCommitMoves` 只对 vault 内路径做 `git add`：collect 的源路径在 vault 外，直接传给 git 会被拒（首跑移动成功但提交失败；已修复 + e2e 复验，真实 vault 的迁移已补交为 `b033128`）。

## Verification

全套复跑：`node --test tests/archive-sweeper.test.mjs tests/intake-records.test.mjs` → **24 pass / 0 fail**（evidence/2026-10-12-lifecycle/tests.txt）

- ISC-1: `zsh orbitos-intake-loop.sh` exit 0；日志 `[2026-10-12 16:47:54 CST] launch: OrbitOS intake loop exit views=0 sync=0 promote=0 reconcile=0`；真实 reconcile `updated=165`；复跑 `updated=0; unchanged=366; diffs=none`（runtime.txt）
- ISC-2: 真实 vault dry-run `materials: files=86; eligible=0; not_ready=86; missing_mark=0`；CLI 沙盒真实移动 1 → 归档区 + 二次运行 moved=0；红队 E1/E2/E3 全过（redteam.txt）
- ISC-3: 单测 15 批 → 保留 12 / 移出 3（oldest 按文件名日期）；真实目录 4 批 → eligible=0（tests.txt / runtime.txt）
- ISC-4: `launchctl print gui/501/com.evander.orbitos-archive-sweeper` 存在（state = not running，等 04:30）；ensure-jobs.sh JOBS 含 archive-sweeper 且 monitor 标签笔误已修；仓库 `launchd/` 快照已放（runtime.txt）
- ISC-5: vault 内 `x-to-markdown/` 10 个文件（9 收拢 + 1 原有），旧位置残留 0，manifest 提交 `f4aff5b`、补交 `b033128`（owner-entrypoint.txt）
- ISC-6: 首轮闸门 PARTIAL — OWNER_ENTRYPOINT 的 BEFORE_AFTER 机器证据被内核判 unfit（REPLACEMENT 成功需 MATCH parity），符合“不得代理自证”的设计；待主人飞书回「确认 EEE2B9」后以 OWNER_CONFIRMATION + `feishu:orbitos-lifecycle-reduce-v1` 复跑，exit 0 → DONE
- 补充证据：Feishu Intake Base 366 行 → raw=203 + **archived=163**（137 源文件已移除 + 26 历史版本），即“源文件消失 → 行自动归档”的端到端闭环

## Remaining Work

- **ISC-6 待主人确认**：请在飞书回一句「确认 EEE2B9」；收到后复跑闸门关账（stage DONE + owner_attested）。
- 第一次真实自动归档在 10-16/17/18（processed=09-16/17/18 的 67 篇到期）与 11-01（backfill 的 19 篇到期）；届时看 `archive-sweeper.out.log` 与 `99_System/Archives/` 落点。
- 已知局限：Materials 归档会让 Intake Base 对应行变「[源文件已移除] + archived」（设计如此，链路已通）；`.bookmark-organizer-state.json` 里的 processed id 不随归档清理（无害，未处理）。
