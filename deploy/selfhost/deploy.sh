#!/bin/sh
# 服务器仅需要 Python3、Docker/Compose 与 curl，不安装项目依赖。
set -eu
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$(dirname "$0")/deploy.py" "$@"
