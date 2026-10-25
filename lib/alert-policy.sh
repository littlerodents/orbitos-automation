#!/bin/zsh
# alert-policy: 告警写盘/推送的节流策略（2026-10-25）
# 背景：git-sync 网络抖动时，ALERT 文件内容每次变化（时间戳+计数）→ 每次 commit。
#       近 7 天 53 条 alert commit，把「真故障」的信号淹没了。
# 策略：每天首次失败必通知；此后只在里程碑计数（2/5/20/50）再通知。
# 用法：alert_should_notify <连续失败次数> <当天是否首次:0|1>
#   返回 0 = 通知；1 = 跳过

alert_milestones() {
  echo "2 5 20 50"
}

alert_should_notify() {
  local count="${1:-0}"
  local daily_first="${2:-0}"
  [ "$daily_first" -eq 1 ] && return 0
  local m
  for m in ${=$(alert_milestones)}; do
    [ "$count" -eq "$m" ] && return 0
  done
  return 1
}
