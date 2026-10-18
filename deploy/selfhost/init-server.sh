#!/usr/bin/env bash
set -euo pipefail
# 不下载后立即执行远端代码；入口与同版支持文件随审核后的 bundle 交付。
command -v python3 >/dev/null || { echo 'init-server: Python 3 is required in the base OS' >&2; exit 1; }
exec python3 "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/init-server.py" "$@"
