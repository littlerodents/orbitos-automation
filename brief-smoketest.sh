#!/bin/zsh
# brief-smoketest: 冒烟跑一次日报生成链路（2026-10-25）
#   目的：在 launchd 的环境里（干净 PATH、无代理变量）验证
#     DeepSeek + trending + 闸门 + 文件写入 四段能不能跑通。
#   安全：--out-dir 写到临时目录；不覆盖正式 brief、不 commit、不推飞书、不调 tracker。
# 手动: zsh brief-smoketest.sh
# 产物: /tmp/orbitos-smoketest/<时间戳>/（LATEST 指向最新一次）

set -u

NODE=/opt/homebrew/opt/node@22/bin/node
SCRIPT=/Users/evander/Labs/codex/orbitos-automation/orbitos-daily-brief.mjs
BASE=/tmp/orbitos-smoketest
TS=$(date '+%Y%m%d-%H%M%S')
OUT="$BASE/$TS"
mkdir -p "$OUT"

{
  echo "=== 何时 / 谁在跑 ==="
  date '+%F %T %Z'
  echo "触发: ${1:-manual}"
  echo
  echo "=== launchd 环境（关键差异点）==="
  echo "PATH=$PATH"
  echo "HOME=$HOME"
  env | grep -i -E 'proxy|http_' || echo "(无 proxy 环境变量)"
  "$NODE" -v 2>&1
  echo
} > "$OUT/diagnostics.txt" 2>&1

START=$(date +%s)
"$NODE" "$SCRIPT" --out-dir "$OUT" >> "$OUT/run.log" 2>&1
CODE=$?
END=$(date +%s)

BRIEF=$(ls "$OUT"/brief-*.md 2>/dev/null | head -1)
{
  echo "=== 结果 ==="
  echo "exit=$CODE  duration=$((END-START))s"
  echo "brief=${BRIEF:-（未生成）}"
  echo
  echo "=== 产物清单 ==="
  ls -la "$OUT"
  echo
  if [ -n "$BRIEF" ]; then
    echo "=== brief 头部 ==="
    head -8 "$BRIEF"
    echo
    echo "=== 工具风向段 ==="
    sed -n '/## 工具风向/,/^## /p' "$BRIEF" | head -6
    echo
    echo "=== 段落齐备性 ==="
    for s in "## TL;DR" "## 行动提醒" "## 学习增量" "## CONNECTIONS" "## 工具风向" "## PATTERN"; do
      if grep -q "^$s" "$BRIEF"; then echo "有 $s"; else echo "缺 $s"; fi
    done
  fi
} >> "$OUT/diagnostics.txt" 2>&1

ln -sfn "$OUT" "$BASE/LATEST" 2>/dev/null || true

# 输出到 launchd 日志（便于 tail）
cat "$OUT/diagnostics.txt"
exit "$CODE"
