FROM caddy:2.11.2@sha256:25cdc846626b62d05f6b633b9b40c2c9f6ef89b515dc76133cefd920f7dbe562
RUN addgroup -g 10001 caddy && adduser -D -u 10001 -G caddy caddy \
  # 高端口不需要官方二进制的低端口 file capability。
  && setcap -r /usr/bin/caddy \
  && chown -R 10001:10001 /data /config
COPY --chmod=0444 deploy/selfhost/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0444 deploy/selfhost/tls-acme.caddy /etc/caddy/tls-acme.caddy
COPY --chmod=0444 deploy/selfhost/tls-supplied.caddy /etc/caddy/tls-supplied.caddy
USER 10001:10001
