#!/usr/bin/env bash
# 本地 Postgres 的 TLS 启动包装：首次启动时生成自签证书，再交给官方入口脚本并开启 ssl。
# Workers VPC 要求数据库启用 TLS（docs/07 §2）；证书只用于本机测试，VPC 服务不校验证书。
# 证书放在数据目录之外，不影响首次 initdb；容器重建后重新生成即可。
set -euo pipefail

TLS_DIR=/var/lib/postgresql/tls
if [[ ! -s "$TLS_DIR/server.key" || ! -s "$TLS_DIR/server.crt" ]]; then
  mkdir -p "$TLS_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj "/CN=product-res-pg" \
    -addext "subjectAltName=DNS:product-res-pg,DNS:postgres,DNS:localhost,IP:127.0.0.1" \
    -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.crt" 2>/dev/null
  chown -R postgres:postgres "$TLS_DIR"
  chmod 600 "$TLS_DIR/server.key"
fi

exec docker-entrypoint.sh "$@" \
  -c ssl=on \
  -c ssl_cert_file="$TLS_DIR/server.crt" \
  -c ssl_key_file="$TLS_DIR/server.key"
