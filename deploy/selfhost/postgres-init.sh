#!/usr/bin/env bash
set -euo pipefail
source /usr/local/bin/selfhost-postgres-entrypoint.sh

read_password_file APP_DB_PASSWORD
read_password_file MIGRATOR_DB_PASSWORD
read_password_file READONLY_DB_PASSWORD

# getenv 将密码从环境交给 psql 变量，再由 SQL 字面量转义；不放进 -v 参数或拼接 SQL。
psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 --username=postgres --dbname="$POSTGRES_DB" <<'SQL'
\getenv app_pw APP_DB_PASSWORD
\getenv migrator_pw MIGRATOR_DB_PASSWORD
\getenv readonly_pw READONLY_DB_PASSWORD
\i /usr/local/share/selfhost/01-roles.sql
\i /usr/local/share/selfhost/02-db-grants.sql
SQL
unset APP_DB_PASSWORD MIGRATOR_DB_PASSWORD READONLY_DB_PASSWORD
