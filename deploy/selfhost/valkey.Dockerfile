FROM valkey/valkey:8.1.6@sha256:1f84517eca8e0dd9585ed57c572796f32839e1b0e7ce07ad28e6bce098468371
USER root
RUN install -d -o 999 -g 999 -m 0700 /data
COPY --chmod=0555 deploy/selfhost/valkey-entrypoint.sh /usr/local/bin/selfhost-valkey
COPY --chmod=0555 deploy/selfhost/valkey-health.sh /usr/local/bin/valkey-health
USER 999:999
ENTRYPOINT ["/usr/local/bin/selfhost-valkey"]
