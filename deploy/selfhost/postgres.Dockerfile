# 本地 inspect 确认的官方 PG17 Debian trixie 镜像，避免可变 tag 改变运行 UID。
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
  && install -d -m 0755 /usr/local/lib/selfhost-backup \
  && install -d -m 0700 -o 999 -g 999 /var/lib/postgresql/data /var/lib/postgresql/tls \
  && install -d -m 0775 -o 999 -g 999 /var/run/postgresql
COPY --chmod=0444 deploy/selfhost/backup/walg.py /usr/local/lib/selfhost-backup/walg.py
RUN printf '#!/bin/sh\nexec python3 /usr/local/lib/selfhost-backup/walg.py "$@"\n' > /usr/local/bin/selfhost-walg \
  && chmod 0555 /usr/local/bin/selfhost-walg
COPY --chmod=0555 deploy/selfhost/postgres-entrypoint.sh /usr/local/bin/selfhost-postgres-entrypoint.sh
COPY --chmod=0555 deploy/selfhost/postgres-init.sh /docker-entrypoint-initdb.d/01-selfhost.sh
COPY --chmod=0444 deploy/selfhost/pg_hba.conf /etc/postgresql/pg_hba.conf
COPY infra/local/initdb/01-roles.sql infra/local/initdb/02-db-grants.sql /usr/local/share/selfhost/
RUN chmod 0755 /usr/local/share/selfhost && chmod 0444 /usr/local/share/selfhost/*.sql

ENV POSTGRES_USER=postgres POSTGRES_DB=product_res_production PGDATA=/var/lib/postgresql/data
USER 999:999
ENTRYPOINT ["/usr/local/bin/selfhost-postgres-entrypoint.sh"]
CMD ["postgres"]
