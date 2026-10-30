#!/bin/zsh
# net-check: 网络可用性探测（2026-10-30）
# 背景：断网时任务照跑、照失败、照刷日志（停用前 7 天 730 条 fetch failed），
#       而兜底脚本又被 git-sync 的 exit 1 卡住 —— 结果"没人盯就废"。
# 设计：
#   1) 探测不依赖代理（--noproxy），因为代理本身可能没连
#   2) 只判"能不能发出请求"，不判业务成功
#   3) 探测失败一律视为"没网"，任务应静默跳过而不是记失败

# 0 = 有网；1 = 无网
# 测试钩子：NET_FORCE_DOWN=1 强制视为无网（用于验证断网路径，不影响生产）
net_ok() {
  if [ "${NET_FORCE_DOWN:-0}" = "1" ]; then
    return 1
  fi
  local timeout="${1:-6}"
  local code
  # api.deepseek.com 国内直连可达，适合做基线探测
  code=$(curl -sS -m "$timeout" -o /dev/null -w '%{http_code}' \
    --noproxy '*' https://api.deepseek.com/ 2>/dev/null)
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    return 0
  fi
  # 备用探测：GitHub（走代理也能通）
  code=$(curl -sS -m "$timeout" -o /dev/null -w '%{http_code}' \
    https://api.github.com/zen 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ]
}

# 待办标记：记录"因无网而跳过"的任务，恢复后由 core 补跑
PENDING_DIR="$HOME/.config/orbitos-automation/pending"

net_mark_pending() {
  local job="$1"
  mkdir -p "$PENDING_DIR"
  echo "$(TZ=Asia/Shanghai date '+%F %T')" > "$PENDING_DIR/$job"
}

net_clear_pending() {
  rm -f "$PENDING_DIR/$1" 2>/dev/null
}

net_has_pending() {
  [ -d "$PENDING_DIR" ] && [ -n "$(ls -A "$PENDING_DIR" 2>/dev/null)" ]
}

net_list_pending() {
  [ -d "$PENDING_DIR" ] && ls "$PENDING_DIR" 2>/dev/null
}
