#!/usr/bin/env bash
# 生成自签证书到 tls/（没有正式证书时的临时方案；此时 Workers VPC 服务需设置 --cert-verification-mode disabled）。
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p tls
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=postgres" \
  -addext "subjectAltName=DNS:postgres,DNS:localhost" \
  -keyout tls/server.key -out tls/server.crt
chmod 600 tls/server.key
echo "已生成 tls/server.crt 与 tls/server.key"
