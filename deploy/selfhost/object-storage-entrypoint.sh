#!/bin/sh
set -eu
umask 077
[ "$(id -u)" != 0 ] || { echo 'object-storage requires a non-root UID' >&2; exit 1; }
# 只读取挂载文件；任何异常只输出变量名，密钥不放入 argv、环境或日志。
for name in S3_ADMIN_ACCESS_KEY_ID_FILE S3_ADMIN_SECRET_ACCESS_KEY_FILE S3_ACCESS_KEY_ID_FILE S3_SECRET_ACCESS_KEY_FILE; do
  eval 'secret_path=${'"$name"'-}'
  [ -n "$secret_path" ] && [ -r "$secret_path" ] || { echo "Invalid $name" >&2; exit 1; }
done
[ -n "${S3_BUCKET:-}" ] && [ -n "${S3_PUBLIC_DOMAIN:-}" ] || { echo 'Invalid S3_BUCKET or S3_PUBLIC_DOMAIN' >&2; exit 1; }
# jq 通过 --rawfile 打开文件；仅移除一个末尾 LF，临时 JSON 位于私有 tmpfs。
if ! jq -n \
  --rawfile adminKey "$S3_ADMIN_ACCESS_KEY_ID_FILE" \
  --rawfile adminSecret "$S3_ADMIN_SECRET_ACCESS_KEY_FILE" \
  --rawfile appKey "$S3_ACCESS_KEY_ID_FILE" \
  --rawfile appSecret "$S3_SECRET_ACCESS_KEY_FILE" \
  --arg bucket "$S3_BUCKET" '
  def secret: sub("\\n$"; "") | if length == 0 or (contains("\r") or contains("\n") or contains("\u0000")) then error("invalid secret") else . end;
  ($adminKey | secret) as $ak | ($adminSecret | secret) as $as |
  ($appKey | secret) as $pk | ($appSecret | secret) as $ps |
  if $ak == $pk or $as == $ps then error("identities must differ") else
  {identities: [
    {name: "bootstrap-admin", credentials: [{accessKey: $ak, secretKey: $as}], actions: ["Admin"]},
    {name: "application", credentials: [{accessKey: $pk, secretKey: $ps}],
      actions: ["Read:", "Write:", "List:", "Tagging:"] | map(. + $bucket)}
  ]} end' > /tmp/s3-auth.json 2>/dev/null; then
  rm -f /tmp/s3-auth.json
  echo 'Invalid S3 credential files or non-distinct identities' >&2
  exit 1
fi
mkdir -p /metadata/master /metadata/admin
exec /usr/bin/weed -logtostderr=true mini \
  -dir=/data -master.dir=/metadata/master -admin.dataDir=/metadata/admin \
  -ip=127.0.0.1 -ip.bind=0.0.0.0 \
  -s3.config=/tmp/s3-auth.json -s3.externalUrl="https://$S3_PUBLIC_DOMAIN" \
  -s3.autoCreateBucket=false -s3.allowDeleteBucketNotEmpty=false \
  -s3.allowedOrigins= -s3.iam=false -s3.port.iceberg=0 -s3.port.lance=0 \
  -webdav=false -admin.ui=false -master.telemetry=false \
  -volume.index=leveldb -master.volumeSizeLimitMB=128 \
  -s3.concurrentFileUploadLimit=2 -s3.concurrentUploadLimitMB=32 \
  -s3.readerCacheSizeMB=32 -filer.concurrentFileUploadLimit=2 \
  -filer.concurrentUploadLimitMB=32 -filer.disableDirListing=true
