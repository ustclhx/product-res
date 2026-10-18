#!/bin/sh
set -eu
# valkey-cli 支持进程环境输入，避免密码参数和认证警告。
REDISCLI_AUTH=$(cat "$VALKEY_PASSWORD_FILE" 2>/dev/null)
export REDISCLI_AUTH
[ "$(valkey-cli --no-auth-warning ping 2>/dev/null)" = PONG ]
