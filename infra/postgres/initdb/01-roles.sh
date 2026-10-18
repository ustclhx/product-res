#!/usr/bin/env bash
# 集群级账号（只在数据卷首次初始化时执行），密码取自 .env。权限由 02-db-grants.sql 设置。
set -euo pipefail
psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -v app_pw="$APP_DB_PASSWORD" -v migrator_pw="$MIGRATOR_DB_PASSWORD" -v readonly_pw="$READONLY_DB_PASSWORD" <<'SQL'
CREATE ROLE app LOGIN PASSWORD :'app_pw';
CREATE ROLE migrator LOGIN PASSWORD :'migrator_pw';
CREATE ROLE readonly LOGIN PASSWORD :'readonly_pw';
GRANT pg_monitor TO readonly;
SQL
psql -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'
