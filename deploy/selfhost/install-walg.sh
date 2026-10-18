#!/usr/bin/env sh
set -eu

# 摘自 v3.0.8 官方 release API 的各二进制 digest，不能信任下载旁的可变校验文件。
# https://api.github.com/repos/wal-g/wal-g/releases/tags/v3.0.8
case "${1:-}" in
  amd64) asset=wal-g-pg-24.04-amd64; checksum=342574292b1907af738d48ff2d1d771ad90a63e441b40a85208022144253f6b8 ;;
  arm64) asset=wal-g-pg-24.04-aarch64; checksum=a822caafa9ee61c2f96add3e768c06971677d8b7a6781e585253b8735a3bc4f7 ;;
  *) printf 'selfhost-backup: unsupported architecture\n' >&2; exit 1 ;;
esac
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --connect-timeout 20 --max-time 300 \
  "https://github.com/wal-g/wal-g/releases/download/v3.0.8/$asset" -o "$temporary/wal-g"
printf '%s  %s\n' "$checksum" "$temporary/wal-g" | sha256sum --check --status
install -m 0555 "$temporary/wal-g" /usr/local/bin/wal-g
