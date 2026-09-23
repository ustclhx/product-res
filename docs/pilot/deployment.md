# product-res pilot deployment and recovery

The pilot is an independent Compose project. It exposes only `127.0.0.1:18081`
and does not claim ports 80, 443, 8080, or 3000 used by the existing services.
The gateway, API, and worker use separate containers and a shared named data
volume. The API and worker each have a 256 MiB limit; the gateway has a 64 MiB
limit. The worker starts with one external task at a time.

## Build and start

Run these commands from the product-res checkout on the build host. The build
uses Node 24, Python 3.12, `web/package-lock.json`, and `uv.lock`; secrets and
SQLite files are excluded by `.dockerignore`.

```sh
cp deploy/pilot.env.example .env
mkdir -p secrets
chmod 700 secrets
# Replace the placeholder workspace UUID in deploy/providers.json and keep
# licensed=false until the operator confirms each source's terms.
# Put credentials in secrets/dataforseo (login:password), secrets/serpapi,
# and secrets/newapi (mode 600) only when those providers are configured.
docker compose -f compose.pilot.yaml config
docker compose -f compose.pilot.yaml build --pull
docker compose -f compose.pilot.yaml up -d
curl --fail http://127.0.0.1:18081/api/v1/health
```

`PUBLIC_URL` is required and must be a loopback HTTP(S) origin for this local
entry point, or an HTTPS origin behind the separately configured public proxy.
The mounted `deploy/providers.json` is non-secret configuration keyed by the
server-created workspace UUID. Missing provider files leave that source
unconfigured and do not prevent the API from starting. The image does not
contain any token.
Before an ECS start, check available memory and verify that the loopback port is
free. Upload the locally built images and Compose files to a separate deployment
directory; never reuse the d2market Compose project, volume, or database.

## Operator order for backup and restore

Backups are valid only after the API and worker have both been stopped. The
explicit assertion is required so an operator cannot accidentally describe a
live, potentially changing SQLite tree as a recovery point.

```sh
docker compose -f compose.pilot.yaml stop api worker
python3 scripts/pilot_backup.py backup \
  --data-dir /path/to/pilot-data \
  --output /path/to/backups/pilot-$(date -u +%Y%m%dT%H%M%SZ) \
  --stopped
```

The command discovers every `*.sqlite3` below the data directory, including the
control database and per-workspace databases. Each file is copied through the
SQLite backup API and checked with `PRAGMA integrity_check`; the manifest records
its relative path, byte count, SHA-256, schema hash, and integrity result. The
backup directory is published atomically only after all files and the manifest
are complete. A checksum, schema, or integrity mismatch aborts restoration.

Restore only into a new isolated directory. Existing destinations are refused,
including an empty directory, so an operator must choose the destination
explicitly and cannot overwrite a live data tree:

```sh
python3 scripts/pilot_backup.py restore \
  --backup /path/to/backups/pilot-20260920T120000Z \
  --destination /path/to/recovery/pilot-20260920T120000Z
```

Restoration rewrites each control registry `business_db_path` to the restored
`workspaces/<slug>.sqlite3` under the destination and revokes all restored
sessions, requiring users to authenticate again. The original `manifest.json`
is preserved byte-for-byte and `restore-relocation.json` records its SHA-256,
the runtime data root, and every path relocation. When the recovered volume is
mounted at a different runtime root, provide it explicitly:

```sh
python3 scripts/pilot_backup.py restore \
  --backup /path/to/backups/pilot-20260920T120000Z \
  --destination /path/to/recovery-staging \
  --runtime-data-dir /data
```

Every registered workspace must map to a manifest file named after its slug;
otherwise restore stops before publishing the destination. Business snapshots
and job rows are copied unchanged.

After inspection, point a separately named Compose project at the recovered
data volume, run migrations compatible with the image, and start the worker only
after the API is healthy. Unfinished jobs remain in their recorded state and
must follow the worker's lease/recovery rules; a restore never replays a
confirmed external attempt.

## Rollback and compatibility

For an application regression, stop gateway, API, and worker, select the prior
image digest, and start that image with the same Compose project. If a database
schema was upgraded, stop the worker first and restore a backup made for the
matching image/schema before starting the prior image. Do not point older code at
an incompatible schema. Verify `/api/v1/health`, the recovered job states, and
the existing d2market/NewAPI health endpoints before opening an SSH tunnel or an
HTTPS entry point. Public access requires an independent HTTPS proxy and a
correct `PUBLIC_URL`; this document does not authorize changes to shared 80/443
routing.

When backing up a stopped WAL database from a container, mount the data directory writable so SQLite can create its shared-memory sidecar if needed; the backup script opens the source database itself with `mode=ro`. A read-only volume can fail with `unable to open database file` when no WAL sidecar exists. Keep API and worker stopped throughout.

## Repeatable tunnel management (2026-09-22)

Use `python3 scripts/pilot_tunnel.py start|status|restart|stop --ssh-target <assigned-ssh-alias>`
from the checkout. The script binds loopback only, checks the product-res pilot
health response, uses a private per-user SSH control socket and never kills
unrelated processes by port. `status` distinguishes a managed connection from an
already working external tunnel. Network/SSH failure and application health
failure have separate recovery messages. Team accounts must use individually
authorized SSH keys and independent business accounts; operator root access is
not a team access handoff. See [team acceptance guide](acceptance-guide-2026-09-22.md).

## Public HTTPS entry (2026-09-23)

The current team entry is https://product.ezarouter.cc. The dedicated
`product-res-cloudflared` connector uses host networking and forwards to
`http://127.0.0.1:18081`. The gateway port remains loopback-only. Both API and
worker have `PUBLIC_URL=https://product.ezarouter.cc`; use the public domain for
login and mutations. Local SSH forwarding remains useful for health inspection,
but is no longer the team login flow. When recreating API containers, restart
the gateway so its upstream DNS resolves the current API container.

See [HTTPS verification receipt](public-domain-2026-09-23.json). The prior Compose
environment is backed up at `/opt/product-res-pilot/backups/public-url-20260923T093551Z/compose.env.before`.
Rollback requires restoring that environment, recreating API/worker, restarting
gateway, and returning clients to the old origin; do not disable Origin checks.
