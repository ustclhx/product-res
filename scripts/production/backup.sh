#!/bin/bash
# 生产逻辑备份（add-cloud-production-neon 4.1）：PG17 pg_dump（自定义格式）→ age 加密 → R2。
# 明文 dump 不落盘；连接串与密钥只经环境变量传入，不出现在命令参数或输出中。
# 必需环境变量：BACKUP_DATABASE_URL、BACKUP_AGE_RECIPIENT；上传时另需
#   R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY、BACKUP_BUCKET。
# BACKUP_DRY_RUN=1 只生成加密文件并校验，不上传（本地验证用）；BACKUP_OUTPUT 指定输出路径。
set -euo pipefail

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"
case "$BACKUP_AGE_RECIPIENT" in age1*) ;; *) echo "BACKUP_AGE_RECIPIENT is not an age public key" >&2; exit 1 ;; esac

PG_IMAGE=${BACKUP_PG_IMAGE:-postgres:17}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
key="neon/product_res_production/$(date -u +%Y/%m/%d)/product_res_production-$stamp.dump.age"
out=${BACKUP_OUTPUT:-${RUNNER_TEMP:-/tmp}/product_res_production-$stamp.dump.age}
started=$(date +%s)

# --no-owner/--no-privileges：恢复到临时目标时不依赖原角色，恢复后再执行权限脚本
docker run --rm --network host -e BACKUP_DATABASE_URL "$PG_IMAGE" \
  sh -c 'exec pg_dump --format=custom --no-owner --no-privileges --dbname="$BACKUP_DATABASE_URL"' \
  | age -r "$BACKUP_AGE_RECIPIENT" > "$out"

size=$(wc -c < "$out" | tr -d ' ')
header=$(head -c 21 "$out")
if [ "$header" != "age-encryption.org/v1" ] || [ "$size" -lt 1024 ]; then
  echo "backup output is not a valid age file or is too small ($size bytes)" >&2
  rm -f "$out"; exit 1
fi
sha=$(shasum -a 256 "$out" | cut -d' ' -f1)
echo "encrypted dump: $size bytes, sha256 $sha"

if [ "${BACKUP_DRY_RUN:-}" = 1 ]; then
  echo "dry run: kept $out, upload skipped"
  exit 0
fi

: "${R2_ACCOUNT_ID:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${BACKUP_BUCKET:?}"
export AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY AWS_DEFAULT_REGION=auto
# R2 兼容：只在必需时计算/校验 CRC 校验和
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
endpoint="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
aws s3api put-object --endpoint-url "$endpoint" --bucket "$BACKUP_BUCKET" --key "$key" \
  --body "$out" --metadata "sha256=$sha" --no-cli-pager > /dev/null
remote=$(aws s3api head-object --endpoint-url "$endpoint" --bucket "$BACKUP_BUCKET" --key "$key" \
  --query ContentLength --output text --no-cli-pager)
rm -f "$out"
if [ "$remote" != "$size" ]; then
  echo "uploaded size mismatch: local $size, remote $remote" >&2; exit 1
fi
elapsed=$(( $(date +%s) - started ))
echo "uploaded $key ($size bytes, sha256 $sha, ${elapsed}s)"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '| key | bytes | sha256 | seconds |\n|---|---|---|---|\n| `%s` | %s | `%s` | %s |\n' \
    "$key" "$size" "$sha" "$elapsed" >> "$GITHUB_STEP_SUMMARY"
fi
