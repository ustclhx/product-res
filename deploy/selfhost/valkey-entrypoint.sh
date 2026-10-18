#!/bin/bash
set -eu
umask 077
# 密码不进入 argv；ACL 只含散列，临时文件在 Compose tmpfs 中。
if [ "$(id -u)" = 0 ] || [ -n "${VALKEY_PASSWORD:-}" ] || [ -z "${VALKEY_PASSWORD_FILE:-}" ]; then
  echo 'selfhost-valkey: invalid file configuration' >&2
  exit 1
fi
password=$(cat "$VALKEY_PASSWORD_FILE" 2>/dev/null && printf '.') || exit 1
password=${password%.}
password=${password%$'\n'}
if [[ -z "$password" || "$password" == *$'\n'* || "$password" == *$'\r'* ]]; then
  echo 'selfhost-valkey: invalid password file' >&2
  exit 1
fi
hash=$(printf '%s' "$password" | sha256sum | cut -d ' ' -f 1)
unset password
printf 'user default on #%s ~* &* +@all\n' "$hash" > /tmp/users.acl
exec valkey-server --aclfile /tmp/users.acl --bind 0.0.0.0 --protected-mode yes \
  --appendonly yes --appendfsync everysec --dir /data \
  --maxmemory 256mb --maxmemory-policy noeviction
