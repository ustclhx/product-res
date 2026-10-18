#!/usr/bin/env bash
# Orca worktree archive：worktree 归档 / 删除前运行，删除该 worktree 专属的本地数据库。
set -euo pipefail

cd "${ORCA_WORKTREE_PATH:-$PWD}"
# shellcheck source=scripts/orca/lib.sh
source "$(dirname "$0")/lib.sh"

db="$(worktree_db_name)"

# 只删除本脚本命名规则下的 worktree 库，绝不触碰 product_res_dev 或其他库
if [[ "$db" != product_res_wt_* || "$db" == "product_res_wt_" ]]; then
  echo "[orca-archive] 数据库名 $db 不符合 worktree 规则，跳过" >&2
  exit 0
fi

if pg_available; then
  pg_exec "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)"
  echo "[orca-archive] 已删除数据库 $db"
else
  echo "[orca-archive] 本地 Postgres 容器未运行，未删除数据库 $db" >&2
fi
