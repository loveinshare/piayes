#!/usr/bin/env bash
# piano-follow 部署脚本 (在 192.168.1.111 上跑)
#
# 流程: git pull -> npm ci -> npm run build -> 重启 systemd user 服务
#
# 用法:
#   ~/code/piano-follow/scripts/deploy.sh          # 常规部署
#   ~/code/piano-follow/scripts/deploy.sh --no-pull # 跳过 pull (本地已改好)
set -euo pipefail

REPO="$HOME/code/piano-follow"
SERVICE="piano-follow.service"
PULL=1
[[ "${1:-}" == "--no-pull" ]] && PULL=0

cd "$REPO"

if [[ $PULL -eq 1 ]]; then
  echo "=== git pull ==="
  # server-data/ 是数据库**快照** (npm run db:backup 生成的副本), 不是活库.
  # 活库在 ~/.config/piano-follow/data, 服务一直在写 —— 拉代码不受它影响.
  # 但快照文件是 git 跟踪的, 本地跑过 backup 就变成「已修改」, 会挡住 pull.
  # 直接还原成 HEAD 版本 (快照随时能重新生成, 丢了无所谓).
  git checkout -- server-data/ 2>/dev/null || true
  git pull --ff-only
fi

echo "=== npm ci ==="
# package-lock.json 存在时 npm ci 更快且可复现; 不存在则退回 npm install
if [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

echo "=== npm run build ==="
npm run build

echo "=== restart $SERVICE ==="
systemctl --user restart "$SERVICE"

sleep 1
systemctl --user --no-pager status "$SERVICE" | head -12

echo "=== db backup ==="
# 把活库快照进仓库 (server-data/) —— 数据跟着 git 走, 丢了能还原.
# 不自动 commit (提交时机由人决定).
npm run db:backup || echo "备份失败 (不影响部署)"

echo "=== done ==="
