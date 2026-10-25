#!/bin/zsh
# catchup-lock: 带过期自愈的互斥锁（2026-10-25）
# 背景：ensure-jobs 的日报兜底用 mkdir 做锁 + trap EXIT 清理。
#       2026-10-23 一次 catchup 被中断，锁残留在 /tmp，此后兜底永久不再触发，
#       当天日报缺失且无人知道（静默失败）。
# 规则：锁目录 mtime 超过 max_age 秒即视为 stale，可被抢走；进程被杀不再永久堵死。

catchup_lock_age() {
  local dir="$1"
  [ -d "$dir" ] || { echo -1; return; }
  local mt
  mt=$(stat -f %m "$dir" 2>/dev/null || echo 0)
  echo $(( $(date +%s) - mt ))
}

# 0 = 抢到锁；1 = 别人持有且未过期
catchup_lock_acquire() {
  local dir="$1"
  local max_age="${2:-1800}"
  if [ -d "$dir" ]; then
    local age
    age=$(catchup_lock_age "$dir")
    if [ "$age" -ge 0 ] && [ "$age" -gt "$max_age" ]; then
      rmdir "$dir" 2>/dev/null
    fi
  fi
  mkdir "$dir" 2>/dev/null
}

catchup_lock_release() {
  rmdir "$1" 2>/dev/null
}

# 0 = 锁目录不存在（健康）；1 = 存在（需要关注）
catchup_lock_present() {
  [ -d "$1" ]
}
