#!/bin/zsh
# alert-policy 的行为测试：不联网、不写 vault、不发飞书。
# 跑法: zsh tests/alert-policy.test.sh
set -u

SCRIPT_DIR="${0:A:h}"
source "$SCRIPT_DIR/../lib/alert-policy.sh"

FAILS=0
check() {
  local desc="$1" expect="$2" count="$3" first="$4"
  local got
  if alert_should_notify "$count" "$first"; then got="notify"; else got="skip"; fi
  if [ "$got" = "$expect" ]; then
    echo "ok   - $desc"
  else
    echo "FAIL - $desc (count=$count first=$first expected=$expect got=$got)"
    FAILS=$((FAILS + 1))
  fi
}

echo "# alert-policy 节流规则"
check "第 1 次失败不通知（未达阈值）"           skip   1 0
check "第 2 次失败通知（首次达阈值）"           notify 2 0
check "第 3 次失败不重复通知"                   skip   3 0
check "第 5 次里程碑通知"                       notify 5 0
check "第 20 次里程碑通知"                      notify 20 0
check "第 50 次里程碑通知"                      notify 50 0
check "第 21 次（非里程碑）不通知"              skip   21 0
check "当天首次失败，即使计数 37 也通知"        notify 37 1
check "当天首次失败，计数 1 也通知（跨天恢复后再次失败）" notify 1 1
check "计数 0 且非当天首次：不通知"             skip   0 0

echo
echo "# 真实场景回放：7 天网络抖动（每天失败 ~8 次，连续累计）"
TOTAL=0
NOTIFY=0
COUNT=0
for day in 1 2 3 4 5 6 7; do
  FIRST=1
  for run in 1 2 3 4 5 6 7 8; do
    COUNT=$((COUNT + 1))
    TOTAL=$((TOTAL + 1))
    if alert_should_notify "$COUNT" "$FIRST"; then
      NOTIFY=$((NOTIFY + 1))
    fi
    FIRST=0
  done
done
echo "失败 ${TOTAL} 次 → 通知 ${NOTIFY} 次（改造前会写 ${TOTAL} 次 ALERT commit）"
if [ "$NOTIFY" -le 12 ]; then
  echo "ok   - 通知次数 ${NOTIFY} ≤ 12（目标：每天不超过 2 条）"
else
  echo "FAIL - 通知次数 ${NOTIFY} > 12"
  FAILS=$((FAILS + 1))
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "PASS: alert-policy 全部通过"
  exit 0
else
  echo "FAIL: $FAILS 项不通过"
  exit 1
fi
