#!/usr/bin/env bash
# Orca worktree setup：在新 worktree 根目录运行。
# 每一步在前置条件不满足时跳过并提示，而不是失败，使脚手架尚未完成时也能创建 worktree。
set -euo pipefail

cd "${ORCA_WORKTREE_PATH:-$PWD}"
# shellcheck source=scripts/orca/lib.sh
source "$(dirname "$0")/lib.sh"

name="$(worktree_name)"
db="$(worktree_db_name)"
base="$(worktree_port_base)"
echo "[orca-setup] worktree=$name db=$db ports=$base-$((base + 9))"

# 1. 依赖
if [[ -f package.json ]]; then
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  else
    echo "[orca-setup] 未找到 pnpm，跳过依赖安装" >&2
  fi
else
  echo "[orca-setup] 尚无 package.json，跳过依赖安装"
fi

# 2. 专属数据库
if pg_available; then
  if [[ "$(pg_exec "SELECT 1 FROM pg_database WHERE datname = '$db'")" != "1" ]]; then
    pg_exec "CREATE DATABASE \"$db\""
    echo "[orca-setup] 已创建数据库 $db"
  else
    echo "[orca-setup] 数据库 $db 已存在，保留"
  fi
  # 账号存在时按 infra/local 的约定设置权限（app 只有 DML，DDL 归 migrator）
  if [[ "$(pg_exec "SELECT count(*) FROM pg_roles WHERE rolname IN ('$PG_APP_USER', '$PG_MIGRATOR_USER')")" == "2" \
    && -f "$PG_DB_GRANTS_SQL" ]]; then
    pg_exec_file "$db" "$PG_DB_GRANTS_SQL"
    echo "[orca-setup] 已设置数据库 $db 的账号权限"
  else
    echo "[orca-setup] 未找到账号 $PG_APP_USER / $PG_MIGRATOR_USER 或 $PG_DB_GRANTS_SQL，跳过授权" >&2
  fi
else
  echo "[orca-setup] 本地 Postgres 容器 $PG_CONTAINER 未运行，跳过建库（启动后重新运行 bash scripts/orca/setup.sh）" >&2
fi

# 3. 端口与连接串
db_url="postgres://$PG_APP_USER:$PG_APP_PASSWORD@localhost:$PG_HOST_PORT/$db"
migrate_url="postgres://$PG_MIGRATOR_USER:$PG_MIGRATOR_PASSWORD@localhost:$PG_HOST_PORT/$db"
cat > .env.worktree <<EOF
# 由 scripts/orca/setup.sh 生成，勿提交。
WORKTREE_NAME=$name
DATABASE_URL=$db_url
MIGRATION_DATABASE_URL=$migrate_url
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=$db_url
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED=$db_url
WEB_PORT=$base
JOBS_PORT=$((base + 1))
WEB_INSPECTOR_PORT=$((base + 2))
JOBS_INSPECTOR_PORT=$((base + 3))
EOF
echo "[orca-setup] 已写入 .env.worktree"

# 4. 本地认证配置（支付另用各 worktree 的根 .env.local，不自动复制）
if [[ ! -f .dev.vars && ! -f apps/web/.dev.vars ]]; then
  echo "[orca-setup] 未找到认证 .dev.vars（参照 apps/web/.dev.vars.example；主 checkout 中配置后经 .worktreeinclude 复制）"
fi

if [[ ! -f .env.local && -f .env.example ]]; then
  echo "[orca-setup] 支付配置可按根 .env.example 自建 .env.local；勿复制 staging 连接，离线测试无需支付凭据"
fi
