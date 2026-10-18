#!/usr/bin/env bash
set -euo pipefail

# 密码仅接受文件输入；保留引号等字符，移除一个末尾换行，不让值进入 argv 或错误输出。
read_password_file() {
  local name="$1" file_name="${1}_FILE" value
  if declare -p "$name" >/dev/null 2>&1 || [[ -z "${!file_name:-}" ]]; then
    printf 'selfhost-postgres: invalid %s_FILE\n' "$name" >&2
    exit 1
  fi
  if ! value="$(cat -- "${!file_name}" 2>/dev/null && printf '.')"; then
    printf 'selfhost-postgres: invalid %s_FILE\n' "$name" >&2
    exit 1
  fi
  value="${value%.}"
  value="${value%$'\n'}"
  if [[ -z "$value" || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    printf 'selfhost-postgres: invalid %s_FILE\n' "$name" >&2
    exit 1
  fi
  printf -v "$name" '%s' "$value"
  export "$name"
}

selfhost_postgres_main() {
  if [[ "$(id -u)" == 0 ]]; then
    printf 'selfhost-postgres: non-root UID required\n' >&2
    exit 1
  fi
  if [[ "${POSTGRES_USER:-postgres}" != postgres ]]; then
    printf 'selfhost-postgres: invalid POSTGRES_USER\n' >&2
    exit 1
  fi
  read_password_file POSTGRES_PASSWORD
  # 官方入口支持直接变量；只在当前启动进程中转换，并避免其 FILE 冲突。
  unset POSTGRES_PASSWORD_FILE
  if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
    for name in APP_DB_PASSWORD MIGRATOR_DB_PASSWORD READONLY_DB_PASSWORD; do
      read_password_file "$name"
      unset "$name"
    done
  fi

  local src=/etc/postgresql/tls-src dst=/var/lib/postgresql/tls
  if [[ ! -s "$src/server.crt" || ! -r "$src/server.crt" || ! -s "$src/server.key" || ! -r "$src/server.key" ]]; then
    printf 'selfhost-postgres: readable TLS certificate and key required\n' >&2
    exit 1
  fi
  # 镜像已预设属主，初始化和每次重启都不需要 root/chown。
  umask 077
  install -m 0600 "$src/server.crt" "$dst/server.crt"
  install -m 0600 "$src/server.key" "$dst/server.key"
  export POSTGRES_INITDB_ARGS='--auth-local=peer --auth-host=scram-sha-256'
  local -a archive_args=()
  if [[ "${BACKUP_ENABLED:-false}" == true ]]; then
    if [[ ! "${BACKUP_ARCHIVE_TIMEOUT_SECONDS:-60}" =~ ^[1-9][0-9]*$ ]]; then
      printf 'selfhost-postgres: invalid backup archive timeout\n' >&2
      exit 1
    fi
    archive_args=(-c archive_mode=on
      -c "archive_timeout=${BACKUP_ARCHIVE_TIMEOUT_SECONDS:-60}"
      -c 'archive_command=/usr/local/bin/selfhost-walg wal-push %p')
  fi
  exec docker-entrypoint.sh "$@" \
    "${archive_args[@]}" \
    -c listen_addresses='*' \
    -c hba_file=/etc/postgresql/pg_hba.conf \
    -c ssl=on \
    -c ssl_cert_file="$dst/server.crt" \
    -c ssl_key_file="$dst/server.key" \
    -c ssl_min_protocol_version=TLSv1.2 \
    -c password_encryption=scram-sha-256 \
    -c max_connections=100 \
    -c shared_buffers=256MB \
    -c timezone=UTC \
    -c log_timezone=UTC \
    -c logging_collector=off \
    -c log_destination=stderr \
    -c log_statement=none \
    -c log_min_error_statement=panic
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  selfhost_postgres_main "$@"
fi
