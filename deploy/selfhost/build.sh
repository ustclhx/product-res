#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
version="${APP_VERSION:-$(git rev-parse HEAD)}"
if [[ ! "$version" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'APP_VERSION must be a full git SHA' >&2
  exit 1
fi
# D 负责发布；此脚本只创建带完整提交号的本机验收镜像。
namespace="${IMAGE_NAMESPACE:-product-res-selfhost}"
for target in web jobs migrate; do
  docker build -f deploy/selfhost/app.Dockerfile --target "$target" \
    --build-arg "APP_VERSION=$version" -t "$namespace/$target:$version" .
done
for service in postgres valkey caddy backup; do
  docker build -f "deploy/selfhost/$service.Dockerfile" -t "$namespace/$service:$version" .
done
