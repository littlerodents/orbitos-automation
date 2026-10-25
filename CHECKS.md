# CHECKS — 每项改动 / 每次事故的检测方法

一条命令看全部：

```bash
cd ~/Labs/codex/orbitos-automation && node selfcheck.mjs
```

- `PASS` = 当前满足判据
- `FAIL` = 不满足，退出码 1
- `SKIP` = 观察期未到（不是通过，是还不知道）
- `--json` 机读；`--only B` 只跑某一类；`--with-network` 连真实抓取一起跑

趋势（每次运行追加一行，可看哪项在反复失败）：

```bash
tail -20 ~/.config/orbitos-automation/selfcheck.jsonl
```

---

## A. 我犯过的错（回归检测 —— 最重要）

| id | 检测什么 | 怎么检测 | 通过标准 | 失败意味着 |
|---|---|---|---|---|
| **A1** import-guard | 入口脚本被 `import` 时不得执行 main | 静态扫 6 个入口脚本是否含 `realpathSync(process.argv[1]) === realpathSync(...)` 守卫 | 6/6 有守卫 | **会真的写 vault / 发飞书**。2026-10-24 我就这样误生成了一份日报 |
| **A2** no-silent-catch | catch 不得为空 | 正则扫全部 `.mjs` 的空 `catch {}`，与 `tests/known-empty-catches.txt` 基线比对 | 无**新增** | 失败被吞掉，你不知道发生了什么。2026-10-24 trending 失败就是这样被我藏起来的 |
| **A3** no-false-promise | 不得写已证伪的承诺 | 扫源码是否含「下批再处理」 | 0 处 | 我承诺过一个不会发生的行为（超额条目已 processed，不会重来） |
| **A4** evidence-not-tracked | 私有证据不得进公开仓库 | `git ls-files evidence` + `git check-ignore` | 0 个被跟踪且已忽略 | 笔记标题进 GitHub 公开仓库。2026-10-24 发生过，已清洗 |
| **A5** gate-exit-not-piped | 闸门调用不得被 `\|` 截断 | 扫 mjs/sh/md 是否出现 `closeloop-verify ... \| head/tail/grep` | 0 处 | 退出码被管道吃掉，把失败读成成功。我犯过一次 |
| **A6** isa-has-evidence | 根因结论必须带取证 | 检查 `ISA.md` 有 `## Problem` 且含 git/实测/取证类证据 | 两者都有 | 我把假设当结论（说过"阈值太严"，实际是时间错位） |
| **A7** no-invented-metric | 不得让 LLM 编指标 | 检查 brief 里比例是算出来的、无"本周完成数"、拒绝次数明确留空 | 3/3 | 报告里出现无法追溯的数字 |

## B. 生命周期（归档 + 记录层归档）

| id | 检测什么 | 怎么检测 | 通过标准 | 失败意味着 |
|---|---|---|---|---|
| **B1** archive-window | 过期未归档必须为 0 | 扫 `Materials/*.md` 的 `processed` 日期，≥7 天仍留在活跃区 | 0 个 | 归档器没跑或失败 → 活跃区又堆起来了 |
| **B2** sweep-idempotent | 归档器幂等 | 真实 `sweep --dry-run` | `moved=0` | >0 说明有到期文件堆积，10 分钟节拍没生效 |
| **B3** reconcile-converged | 重复 reconcile 不再有 diff | 真实 `reconcile-records --dry-run`（查飞书，约 3 分钟） | `updated=0` | >0 说明比较逻辑又出现全量重写（2026-10-12 那个 ISO/本地时间 bug 复发） |
| **B4** datetime-compare | ISO 与本地时间判为同一时刻 | `node --test tests/intake-records.test.mjs` | 全 pass | 每 10 分钟重写 200+ 行，飞书被刷 |

## C. GitHub Trending

| id | 检测什么 | 怎么检测 | 通过标准 | 失败意味着 |
|---|---|---|---|---|
| **C1** trending-parser | 解析真实榜单 HTML | `node --test tests/github-trending.test.mjs`（用真实 HTML fixture） | 7 项 pass | 榜单改版 → brief 里没有工具风向 |
| **C2** trending-snapshot-bounded | 快照有上界 | 读 `~/.config/orbitos-automation/github-trending.json` 条目数 | ≤200 | 30 天清理失效，文件无限增长 |
| **C3** trending-nonfatal | 抓取失败不拖垮日报 | 扫模块与 brief 是否都有兜底 | 两处都有 | 网络抖一下就没日报 —— 2026-10-24 就是这个风险 |

## D. 反向指标（对外账）

| id | 检测什么 | 怎么检测 | 通过标准 | 失败意味着 |
|---|---|---|---|---|
| **D1** outward-account-live | 占比与实时表一致 | 真读飞书行动表，算 对外/学习/总数 | 总数>0 且对外≥1 | 周报里的数字和表对不上 = 指标失真 |
| **D2** outward-alert-boundary | 注记触发边界 | `node --test tests/outward-account.test.mjs` | 6 项 pass | 该红的时候不红（或反之），约束失效 |

## E. bookmark → 行动表断点

| id | 检测什么 | 怎么检测 | 通过标准 | 失败意味着 |
|---|---|---|---|---|
| **E1** bookmark-action-rules | 谁能进表 | `node --test tests/bookmark-actions.test.mjs` | 5 项 pass | medium/weak 灌进追踪表，或 strong 漏掉 |
| **E2** overflow-visible | 超额丢弃必须可见 | 扫源码是否同时有「仅存档」与 `archived_only` 日志 | 两者都有 | 静默丢弃（我原来就写错过） |

## F. 教练模式（对外闸门）

| id | 检测什么 | 怎么检测 | 通过标准 | 失败意味着 |
|---|---|---|---|---|
| **F1** gate-three-states | 完成/未完成/无记录 | `node --test tests/outward-actions.test.mjs` | 11 项 pass | 该扣留不扣留，或刚上线就误扣留 |
| **F2** daily-outward-row | 今天恰好 1 条对外动作 | 真读飞书行动表，数今天 `[对外·` 行 | =1 | 0 条=生成失败；>1=幂等坏了，表会泛滥 |
| **F3** intake-loop-wired | 自动轮真的带上了 outward | 读 `orbitos-intake-loop.log` 最后一行是否含 `outward=0` | 含 | 我只改了代码但没接线（2026-10-15 就是这个错） |
| **F4** withheld-not-fake-brief | 扣留页不冒充日报 | 断言扣留页不含 TL;DR/学习增量/工具风向 | 通过 | 扣留变成"换个壳的日报"，约束失效 |

## G. 告警节流（④）

| id | 检测什么 | 怎么检测 | 通过标准 | 失败意味着 |
|---|---|---|---|---|
| **G1** alert-throttle | 节流规则 | `zsh tests/alert-policy.test.sh` | 10 项 + 回放通过 | 网络抖动又刷几十条 alert commit |
| **G2** alert-volume | 上线后每天 alert ≤ 2 | 数 vault 里 `alert:` commit（按天） | 每天 ≤2 | 节流没生效。**上线 24h 内显示 SKIP** |

---

## 已知不检测的（诚实边界）

1. **扣留分支的真实端到端**（F 类只测了逻辑与文案）。真实触发条件是"昨天对外动作未完成"，10-26 才可能第一次发生。
2. **brief 真实落盘 + 飞书送达**（周报的对外账段）。周日 10:00 自动轮才验证。
3. **YouMind 同步能否成功**。网络问题不是代码问题，检测器不冒充能测。
4. **我"判断是否正确"**。A6 只能检查"有没有取证"，不能检查"结论对不对"。结论对错只能靠你看证据反驳我。

## 什么时候该跑

- 每次我交付之后（你自己跑一遍，不看我的报告）
- 每天一次随便什么时候（30 秒，除 B3 要 3 分钟）
- 出现「日报没来 / 数字不对 / 行为怪」时，先跑它再问我
