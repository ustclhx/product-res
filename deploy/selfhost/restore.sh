#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
  restore|check|promote|cleanup) exec python3 "$root/backup/restore.py" "$@" ;;
  *) exec python3 "$root/backup/restore.py" restore "$@" ;;
esac
