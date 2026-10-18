# 官方 4.48 manifest 同时包含 linux/amd64 与 linux/arm64。
FROM chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d
USER root
RUN apk add --no-cache jq \
  && mkdir -p /data /metadata \
  && chown -R 1000:1000 /data /metadata \
  && chmod 0700 /data /metadata
COPY --chmod=0555 deploy/selfhost/object-storage-entrypoint.sh /usr/local/bin/object-storage-entrypoint
COPY --chmod=0555 deploy/selfhost/object-storage-health.sh /usr/local/bin/object-storage-health
COPY --chmod=0444 deploy/selfhost/object-storage-filer.toml /etc/seaweedfs/filer.toml
USER 1000:1000
# Docker 首次填充 named volume 会复制镜像目录的非 root 属主；不使用 root init。
VOLUME ["/data", "/metadata"]
ENTRYPOINT ["/usr/local/bin/object-storage-entrypoint"]
