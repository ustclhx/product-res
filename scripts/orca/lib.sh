#!/usr/bin/env bash
# Orca setup / archive 脚本共用的约定。
#
# 本地开发约定（P0 任务 3.1 的 infra/local/docker-compose.yml 必须与此一致）：
#   - 本地 Postgres 容器名 product-res-pg，超级用户 postgres，宿主机端口 5432
#   - 账号 app（DML）/ migrator（DDL）/ readonly（SELECT），本地密码与账号名相同
#   - 单库权限由 infra/local/initdb/02-db-grants.sql 设置，setup 对每个 worktree 库执行一次
#   - 主 checkout 使用数据库 product_res_dev；每个 Orca worktree 使用独立数据库 product_res_wt_<名称>
#   - 每个 worktree 的数据库名与端口写入 .env.worktree（已 gitignore），由 vite / wrangler 配置读取

PG_CONTAINER="${PRODUCT_RES_PG_CONTAINER:-product-res-pg}"
PG_HOST_PORT="${PRODUCT_RES_PG_PORT:-5432}"
PG_APP_USER="${PRODUCT_RES_PG_APP_USER:-app}"
PG_APP_PASSWORD="${PRODUCT_RES_PG_APP_PASSWORD:-app}"
PG_MIGRATOR_USER="${PRODUCT_RES_PG_MIGRATOR_USER:-migrator}"
PG_MIGRATOR_PASSWORD="${PRODUCT_RES_PG_MIGRATOR_PASSWORD:-migrator}"
PG_DB_GRANTS_SQL="infra/local/initdb/02-db-grants.sql"

worktree_name() {
  # Orca 传入 ORCA_WORKSPACE_NAME；手动运行时退回到目录名
  local name="${ORCA_WORKSPACE_NAME:-$(basename "${ORCA_WORKTREE_PATH:-$PWD}")}"
  printf '%s' "$name"
}

worktree_db_name() {
  # 只保留 [a-z0-9_]，加前缀，截断到 PG 标识符上限 63
  local slug
  slug="$(worktree_name | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9]/_/g' -e 's/__*/_/g' -e 's/^_//' -e 's/_$//')"
  printf 'product_res_wt_%s' "$slug" | cut -c1-63
}

worktree_port_base() {
  # 按名称哈希分配 20000–29990 之间、步长 10 的端口段，同一名称每次结果相同
  local hash
  hash="$(worktree_name | cksum | awk '{print $1}')"
  printf '%s' $(( 20000 + (hash % 1000) * 10 ))
}

pg_available() {
  command -v docker >/dev/null 2>&1 \
    && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"
}

pg_exec() {
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -tAc "$1"
}

pg_exec_file() {
  # 以超级用户在指定数据库中执行宿主机上的 SQL 文件：pg_exec_file <db> <file>
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -q -U postgres -d "$1" < "$2"
}
