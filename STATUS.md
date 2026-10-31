# STATUS — OrbitOS 自动化重构（2026-10-31）

## 一句话
17 个 launchd 任务 → 6 个；修好「断网即永久失效」；周报拆两份；磁盘卫生已上线。

## 当前状态：可用
- 6 个任务已加载并在跑（core 每小时 / daily 11:00 / company 周五17 / personal 周日23 / evening 21 / disk-hygiene 周日03）
- selfcheck：34 PASS / 0 FAIL / 1 SKIP
- 磁盘：26G → 60G（释放 34G）

## 本轮已修（都有检测项）
| 问题 | 修法 | 检测 |
|---|---|---|
| 断网 → git-sync exit 1 → 兜底不执行 → 日报永久缺失 | `trap run_fallback EXIT` | I3 |
| ensure-jobs 漏 source 库（我 10/25 的修复实际没生效） | 补 source 三个 lib | I2 |
| 无网时任务照跑照失败（7天730条噪音） | lib/net-check.sh + pending 标记 | I2 |
| 周报只有一份 | `--weekly-company` / `--weekly-personal` | I4 |
| 缓存无限堆 | disk-hygiene（阈值 60G，只删 L1） | — |
| conda entry point 报错 | 补 libarchive.20.dylib | H1/H2 |
| Shadowrocket 合思/typeless 走美国代理 | 4 条 DIRECT 规则 + always-real-ip | H3 |

## 待办（按价值排序）
- ~~**P0-1 日报重复推送同一卡住项**~~ ✅ 已完成（2026-10-31）：连续 ≥3 天自动剔除 + 强制换策略/降级/放弃三段式；单测 7 项；真实 dry-run 验证生效。
- **P0-2 LLM 幻觉 wikilink 225 处**（`[[opc-launch]]` 49 次等）。
- **P0-3 vault 无人的笔记**：近 7 天 0 篇主人手写；40_Wiki 仅 4 条且 10/8 后未动。
- P1：15 个项目 120-170 天未动、无 git；Archives 含 44 个坏产物（`## ERROR`）。
- 清理：`90_Plans` 空目录。

## 已知副作用
- `family-voice-runtime/tts/.venv` 被 disk-hygiene 删除，TTS 下次启动可能需重建环境。
- 旧 plist 已移出 LaunchAgents（备份在 ~/Backups/orbitos-old-plists-20261030），需重启或手动 bootout 才彻底停。
