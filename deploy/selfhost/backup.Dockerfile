# 与 PG 服务共享 multiarch PG17 底座、客户端版本和 postgres UID999。
FROM postgres:17-trixie@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f
ARG TARGETARCH
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=0555 deploy/selfhost/install-walg.sh /usr/local/bin/install-walg.sh
RUN /usr/local/bin/install-walg.sh "$TARGETARCH" \
  && rm /usr/local/bin/install-walg.sh \
  && install -d -m 0700 -o 999 -g 999 /var/lib/selfhost-backup /var/lib/selfhost-backup/tmp \
  && install -d -m 0755 /usr/local/lib/selfhost-backup
COPY --chmod=0444 deploy/selfhost/backup/ /usr/local/lib/selfhost-backup/
RUN printf '#!/bin/sh\nexec python3 /usr/local/lib/selfhost-backup/walg.py "$@"\n' > /usr/local/bin/selfhost-walg \
  && chmod 0555 /usr/local/bin/selfhost-walg
ENV PGHOST=/var/run/postgresql PGUSER=postgres PGDATABASE=product_res_production \
  BACKUP_STATE_DIR=/var/lib/selfhost-backup TMPDIR=/var/lib/selfhost-backup/tmp
USER 999:999
ENTRYPOINT ["python3", "/usr/local/lib/selfhost-backup/backup.py"]
CMD ["schedule"]
