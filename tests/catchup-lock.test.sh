#!/bin/zsh
# catchup-lock 行为测试：不依赖 vault、不发通知。
# 跑法: zsh tests/catchup-lock.test.sh
set -u

SCRIPT_DIR="${0:A:h}"
source "$SCRIPT_DIR/../lib/catchup-lock.sh"

TMP=$(mktemp -d)
FAILS=0
ok()   { echo "ok   - $1"; }
bad()  { echo "FAIL - $1"; FAILS=$((FAILS + 1)); }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

LOCK="$TMP/lock"

# 1. 锁不存在 → 能抢到
catchup_lock_acquire "$LOCK" 1800
assert "空锁目录时可获取" '[ -d "$LOCK" ]'

# 2. 锁新鲜 → 抢不到（互斥）
catchup_lock_acquire "$LOCK" 1800
assert "锁新鲜时第二次获取失败（互斥生效）" '[ $? -ne 0 ]'

# 3. 锁过期 → 可被抢走（2026-10-23 事故的核心）
touch -t 202610231509 "$LOCK"
AGE=$(catchup_lock_age "$LOCK")
assert "过期锁能被识别出 age>0" '[ "$AGE" -gt 1700 ]'
catchup_lock_acquire "$LOCK" 1800
assert "过期锁被抢走并重建" '[ -d "$LOCK" ]'

# 4. 释放后能再次获取
catchup_lock_release "$LOCK"
assert "释放后目录消失" '[ ! -d "$LOCK" ]'
catchup_lock_acquire "$LOCK" 1800
assert "释放后可重新获取" '[ -d "$LOCK" ]'

# 5. 幂等释放（重复调用不报错）
catchup_lock_release "$LOCK"
catchup_lock_release "$LOCK"
ok "重复释放不报错"

# 6. 真实事故回放：残留 2 天的锁，新的 acquire 必须能自愈
LOCK2="$TMP/stale-2days"
mkdir "$LOCK2"
touch -t 202610231509 "$LOCK2"
BEFORE_AGE=$(catchup_lock_age "$LOCK2")
if catchup_lock_acquire "$LOCK2" 1800; then
  ok "2026-10-23 的 2 天残留锁可被自愈（age=${BEFORE_AGE}s > 1800s）"
else
  bad "残留锁仍会永久堵死兜底（age=${BEFORE_AGE}s）"
fi

# 7. 锁目录内若有文件（非空），rmdir 会失败 —— 这是一个真实陷阱，必须显式记录
LOCK3="$TMP/nonempty"
mkdir "$LOCK3"
touch "$LOCK3/somefile"
catchup_lock_release "$LOCK3"
if [ -d "$LOCK3" ]; then
  ok "非空锁目录 rmdir 失败（符合预期：调用方不得往锁目录写文件）"
else
  bad "非空锁目录被意外删除"
fi

rm -rf "$TMP"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "PASS: catchup-lock 全部通过"
  exit 0
else
  echo "FAIL: $FAILS 项不通过"
  exit 1
fi
