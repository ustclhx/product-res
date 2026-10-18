#!/usr/bin/env bash
# 把挂载进来的证书复制到 postgres 用户可读、权限为 600 的位置，再交给官方入口脚本。
# 绑定挂载的文件属主与权限取决于宿主机，Postgres 拒绝权限过宽的私钥，因此不能直接使用。
set -euo pipefail
SRC=/etc/postgresql/tls-src
DST=/var/lib/postgresql/tls
if [[ ! -s "$SRC/server.crt" || ! -s "$SRC/server.key" ]]; then
  echo "pg-entrypoint: 缺少 $SRC/server.crt 或 server.key（可先运行 ./gen-self-signed.sh）" >&2
  exit 1
fi
mkdir -p "$DST"
cp "$SRC/server.crt" "$SRC/server.key" "$DST/"
chown -R postgres:postgres "$DST"
chmod 600 "$DST/server.key"
exec docker-entrypoint.sh "$@"
