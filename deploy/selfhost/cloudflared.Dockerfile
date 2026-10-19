# 官方发布二进制，不重新编译；版本与 multiarch index digest 同时固定（amd64/arm64），由 check-bases 校验。
FROM cloudflare/cloudflared:2026.10.0@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07
# 官方 distroless 镜像默认即 nonroot 65532；显式声明，基础镜像默认值变化时也不会静默改为 root。
USER 65532:65532
