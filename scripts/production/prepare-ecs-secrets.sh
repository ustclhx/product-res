#!/usr/bin/env bash
# 在 product-res-ecs 上准备部署目录 /opt/product-res：随机密钥与 PG 私有 CA/证书；不输出任何密钥值。
# 用法（操作员电脑）：ssh product-res-ecs 'bash -s' < scripts/production/prepare-ecs-secrets.sh
# 已有 secrets 时拒绝覆盖；.env 从同 SHA release bundle 的 .env.example 复制后再填写。
# 权限按 deploy/selfhost/secrets.example：PG/Valkey 999，web/jobs/migrate 1000；CA 私钥只留在 /root/product-res-prep。
set -euo pipefail
umask 077
D=/opt/product-res
P=/root/product-res-prep
DB=product_res_production

# 上一次被中止的服务器构建留下的源码目录
rm -rf "$D/build"
if [[ -e "$D/secrets/auth_secret" ]]; then
  echo 'secrets already exist; refusing to overwrite' >&2
  exit 1
fi
install -d -m 0700 -o root -g root "$D" "$D/secrets" "$D/certs" "$D/certs/postgres" "$D/certs/caddy" "$P"
# AI Provider 与数据源凭据：secrets/optional/<NAME>，文件缺失即未配置
install -d -m 0700 -o 1000 -g 1000 "$D/secrets/optional"

rand() { openssl rand -hex 32; }
write() { # 文件名 属主UID 值
  printf '%s' "$3" >"$D/secrets/$1"
  chown "$2:$2" "$D/secrets/$1"
  chmod 0600 "$D/secrets/$1"
}

pg=$(rand)
app=$(rand)
mig=$(rand)
ro=$(rand)
vk=$(rand)
write postgres_password 999 "$pg"
write app_db_password 999 "$app"
write migrator_db_password 999 "$mig"
write readonly_db_password 999 "$ro"
write valkey_password 999 "$vk"
write app_database_url 1000 "postgres://app:${app}@postgres:5432/${DB}?sslmode=verify-full"
write migrator_database_url 1000 "postgres://migrator:${mig}@postgres:5432/${DB}?sslmode=verify-full"
write valkey_url 1000 "redis://default:${vk}@valkey:6379/0"
write auth_secret 1000 "$(openssl rand -base64 48 | tr -d '\n')"
# readonly 连接串只留在操作员目录，不挂给应用
printf 'postgres://readonly:%s@postgres:5432/%s?sslmode=verify-full' "$ro" "$DB" >"$P/readonly_database_url"

# 私有 CA 与 PG 证书（SAN DNS:postgres，verify-full 校验服务名）
openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj '/CN=product-res-internal-CA' \
  -keyout "$P/ca.key" -out "$D/certs/ca.crt" 2>/dev/null
cat >"$P/pg.ext" <<'X'
subjectAltName=DNS:postgres
extendedKeyUsage=serverAuth
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
X
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=postgres' \
  -keyout "$D/certs/postgres/server.key" -out "$P/pg.csr" 2>/dev/null
openssl x509 -req -in "$P/pg.csr" -CA "$D/certs/ca.crt" -CAkey "$P/ca.key" -CAcreateserial \
  -days 825 -extfile "$P/pg.ext" -out "$D/certs/postgres/server.crt" 2>/dev/null
chown 999:999 "$D/certs/postgres" "$D/certs/postgres/server.crt" "$D/certs/postgres/server.key"
chmod 0600 "$D/certs/postgres/server.key"
chmod 0644 "$D/certs/postgres/server.crt" "$D/certs/ca.crt"
# 应用容器只读挂载公开 CA；PG 私钥仍只有 UID 999 可读
chmod 0755 "$D/certs"
openssl verify -CAfile "$D/certs/ca.crt" "$D/certs/postgres/server.crt"
find "$D" -maxdepth 3 -printf '%m %u:%g %p\n' | sort -k3
