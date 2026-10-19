#!/usr/bin/env python3
"""用正式 GHCR bundle 在独立空卷验收部署；本地第二版仅修改固化版本元数据。

python3 deploy/selfhost/test-release-compose.py --bundle /absolute/bundle --evidence /absolute/report.json
需要 Docker Compose v2、Git、OpenSSL、curl 与空闲 80/443；不读取业务源码或真实凭据。
不验异机、宿主 reboot、未完成任务重执行或完整备份成功（B/D 1.5 尚未签收）。
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

sys.dont_write_bytecode = True
# 只用于第二版本的隔离registry，沿用既有部署机制验收的夹具镜像。
REGISTRY = 'registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373'


class Failure(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Failure(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def available(port):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', port))
        return sock.getsockname()[1]


class Acceptance:
    def __init__(self, directory, bundle, evidence):
        self.directory = directory
        self.bundle = bundle
        self.evidence = evidence
        self.project = 'selfhost-release-' + uuid.uuid4().hex[:12]
        self.registry = self.project + '-registry'
        self.registry_created = False
        self.images = []
        self.containers = []
        self.records = []
        self.stage = 'preflight'
        self.env = {key: value for key, value in os.environ.items() if key in (
            'PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
        # 匿名 GHCR；只保留本机 Docker endpoint，不复制任何 registry auth。
        original = Path(os.environ.get('DOCKER_CONFIG', str(Path.home() / '.docker')))
        config = directory / 'docker-config'
        config.mkdir(mode=0o700)
        previous = json.loads((original / 'config.json').read_text()) if (original / 'config.json').exists() else {}
        (config / 'config.json').write_text(json.dumps({key: previous[key] for key in
            ['currentContext', 'cliPluginsExtraDirs'] if key in previous}))
        for name in ['contexts', 'cli-plugins']:
            if (original / name).exists():
                (config / name).symlink_to(original / name, target_is_directory=True)
        self.env['DOCKER_CONFIG'] = str(config)
        self.real_curl = shutil.which('curl')
        self.deploy_dir = directory / 'deployment'
        self.deploy_dir.mkdir(mode=0o700)
        self.domain = self.project + '.test'
        self.report = {'schemaVersion': 1, 'project': self.project, 'checks': self.records,
                       'scope': 'isolated local/CI plain Compose; GHCR initial release',
                       'notVerified': ['B/D 1.5 lifecycle signoff', 'host reboot', 'cross-host recovery',
                                       'unfinished task replay', 'complete backup success', 'SSH/real server']}
        spec = importlib.util.spec_from_file_location('acceptance_bundle', bundle / 'release/bundle.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.module = module
        self.a = json.loads((bundle / 'release.json').read_text())['sha']
        self.release = module.verify_bundle(bundle, self.a)
        self.report['ghcrSha'] = self.a

    def run(self, args, *, timeout=120, check=True, input=None):
        # 任意子进程原文只在内存中处理，不能写日志/evidence（含驱动与应用正文）。
        try:
            result = subprocess.run(args, env=self.env, capture_output=True, input=input, timeout=timeout)
        except (OSError, subprocess.SubprocessError) as error:
            raise Failure(self.stage + ': command unavailable/timed out; raw output withheld') from error
        if check:
            require(result.returncode == 0, self.stage + ': command failed; raw output withheld')
        return result

    def docker(self, *args, **kwargs):
        return self.run(['docker', *args], **kwargs).stdout.decode().strip()

    def mark(self, name, **metadata):
        self.stage = name
        self.records.append({'check': name, 'passed': True, **metadata})
        self.write_report()
        print(json.dumps({'event': 'release.acceptance.check', 'check': name, 'passed': True}), flush=True)

    def write_report(self):
        self.evidence.parent.mkdir(parents=True, exist_ok=True)
        self.evidence.write_text(json.dumps(self.report, indent=2) + '\n')
        self.evidence.chmod(0o600)

    def permission(self, path, uid, private=True):
        if self.desktop:
            path.chmod(0o755 if path.is_dir() else 0o644)
        elif os.geteuid() == 0:
            os.chown(path, uid, uid)
            path.chmod(0o700 if path.is_dir() else (0o600 if private else 0o644))
        else:
            # helper 是本任务独占的一次性 root 容器；不改变任何生产镜像或服务 UID。
            self.docker('run', '--rm', '--user', '0:0', '--entrypoint', 'sh',
                        '-v', str(path.parent) + ':/fixture', self.release['images']['postgres'],
                        '-c', 'chown "$1:$1" "/fixture/$2" && chmod "$3" "/fixture/$2"',
                        'permission-helper', str(uid), path.name,
                        '700' if path.is_dir() else ('600' if private else '644'))

    def secret(self, name, value=None):
        value = value or uuid.uuid4().hex + uuid.uuid4().hex
        target = self.deploy_dir / 'secrets' / name
        uid = 999 if name in ['postgres_password', 'app_db_password', 'migrator_db_password',
                              'readonly_db_password', 'valkey_password'] else 1000
        if target.exists() and not self.desktop and os.geteuid() != 0:
            self.run(['docker', 'run', '--rm', '-i', '--user', '0:0', '--entrypoint', 'sh',
                      '-v', str(target.parent) + ':/fixture', self.release['images']['postgres'],
                      '-c', 'cat > "/fixture/$1"; chown "$2:$2" "/fixture/$1"; chmod 600 "/fixture/$1"',
                      'secret-helper', name, str(uid)], input=value.encode())
        else:
            target.write_text(value)
            self.permission(target, uid)
        return value

    def configure(self):
        secrets = self.deploy_dir / 'secrets'
        secrets.mkdir(mode=0o700)
        certs = self.deploy_dir / 'certs'
        certs.mkdir(mode=0o700)
        self.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout',
                  str(certs / 'ca.key'), '-out', str(certs / 'ca.crt'), '-days', '2', '-subj', '/CN=release-fixture-CA'])
        (certs / 'ca.key').chmod(0o600)
        (certs / 'ca.crt').chmod(0o644)
        for service, domain, uid in [('postgres', 'postgres', 999), ('caddy', self.domain, 10001)]:
            target = certs / service
            target.mkdir(mode=0o700)
            extension = target / 'extensions'
            extension.write_text('subjectAltName=DNS:' + domain + '\nextendedKeyUsage=serverAuth\n')
            self.run(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout',
                      str(target / 'server.key'), '-out', str(target / 'server.csr'), '-subj', '/CN=' + domain])
            self.run(['openssl', 'x509', '-req', '-in', str(target / 'server.csr'), '-CA', str(certs / 'ca.crt'),
                      '-CAkey', str(certs / 'ca.key'), '-CAcreateserial', '-out', str(target / 'server.crt'),
                      '-days', '2', '-extfile', str(extension)])
            self.permission(target / 'server.key', uid)
            self.permission(target / 'server.crt', uid, private=False)
            self.permission(target, uid)
        app = self.secret('app_db_password')
        migrator = self.secret('migrator_db_password')
        cache = self.secret('valkey_password')
        for name in ['postgres_password', 'readonly_db_password', 'auth_secret',
                     'google_client_secret', 'github_client_secret', 'turnstile_secret']:
            self.secret(name)
        self.app_url = f'postgres://app:{app}@postgres:5432/acceptance?sslmode=verify-full'
        self.migration_url = f'postgres://migrator:{migrator}@postgres:5432/acceptance?sslmode=verify-full'
        self.secret('app_database_url', self.app_url)
        self.secret('migrator_database_url', self.migration_url)
        self.secret('valkey_url', f'redis://default:{cache}@valkey:6379/0')
        values = {'COMPOSE_PROJECT_NAME': self.project, 'COMPOSE_PROFILES': 'caddy',
                  'APP_DOMAIN': self.domain, 'APP_URL': 'https://' + self.domain,
                  'CADDY_TLS_MODE': 'supplied', 'POSTGRES_DB': 'acceptance',
                  'SECRETS_DIR': str(secrets), 'CA_FILE': str(certs / 'ca.crt'),
                  'PG_TLS_DIR': str(certs / 'postgres'), 'CADDY_CERT_DIR': str(certs / 'caddy'),
                  'GOOGLE_CLIENT_ID': 'unused-fixture', 'GITHUB_CLIENT_ID': 'unused-fixture',
                  'TURNSTILE_SITE_KEY': 'unused-fixture', 'EMAIL_TRANSPORT': 'log',
                  'JOB_EXECUTOR_ID': self.project, 'CACHE_NAMESPACE': self.project}
        env_file = self.deploy_dir / '.env'
        env_file.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
        env_file.chmod(0o600)
        wrapper = self.directory / 'test-bin'
        wrapper.mkdir()
        # 仅测试 PATH 注入 CA/loopback 解析；不修改 bundle 或生产 public_probe。
        (wrapper / 'curl').write_text('#!' + sys.executable + '\nimport os,sys\nos.execv(' + repr(self.real_curl) +
            ', [' + repr(self.real_curl) + ', "--noproxy", "*", "--cacert", ' + repr(str(certs / 'ca.crt')) +
            ', "--resolve", ' + repr(self.domain + ':443:127.0.0.1') + '] + sys.argv[1:])\n')
        (wrapper / 'curl').chmod(0o700)
        self.env['PATH'] = str(wrapper) + os.pathsep + self.env['PATH']

    def compose(self, sha, *args, **kwargs):
        bundle = self.deploy_dir / 'releases' / sha
        release = self.module.verify_bundle(bundle, sha, allow_fixture=True)
        clean = self.env.copy()
        self.env.update(self.module.image_env(release))
        try:
            return self.docker('compose', '--project-directory', str(self.deploy_dir), '--env-file',
                               str(self.deploy_dir / '.env'), '-f', str(bundle / 'compose.yaml'), *args, **kwargs)
        finally:
            self.env = clean

    def deploy(self, sha, bundle=None, *, rollback=False, success=True, fault=False):
        command = [str((bundle or self.bundle) / 'deploy.sh'), '--local', '--dir', str(self.deploy_dir),
                   '--rollback' if rollback else '--sha', sha, '--health-timeout', '20' if fault else '360']
        if bundle:
            command += ['--bundle', str(bundle)]
        if sha != self.a or rollback:
            command += ['--fixture']
        result = self.run(command, timeout=1200, check=False)
        require((result.returncode == 0) == success, 'deployment outcome differs; raw output withheld')
        if not success:
            require(b'--rollback' in result.stderr, 'failed deployment omitted rollback instruction')
        return result

    def state(self):
        return json.loads((self.deploy_dir / 'release-state/state.json').read_text())

    def sql(self, sha, query):
        return json.loads(self.run(['docker', 'exec', '-i', self.compose(sha, 'ps', '-q', 'postgres'),
            'psql', '--no-psqlrc', '-U', 'postgres', '-d', 'acceptance', '-tA', '-v', 'ON_ERROR_STOP=1'],
            input=(query + '\n').encode()).stdout)

    def snapshot(self, sha):
        tables = self.sql(sha, "SELECT coalesce(json_agg(json_build_object('schema',schemaname,'table',tablename)), '[]') FROM pg_tables WHERE schemaname IN ('public','job_engine','dbos');")
        result = {}
        for item in tables:
            schema, table = item['schema'], item['table']
            if schema == 'job_engine' and table not in ['schedule', 'schedule_run', 'message']:
                continue
            if schema == 'dbos' and table not in ['workflow_status', 'operation_outputs']:
                continue
            require(schema.replace('_', '').isalnum() and table.replace('_', '').isalnum(), 'unexpected SQL identifier')
            where = ''
            select = 'to_jsonb(t)'
            if schema == 'public' and table == 'setting':
                where = " WHERE key <> 'jobs.lastCronAt'"
            if schema == 'job_engine' and table == 'schedule':
                select = "to_jsonb(t) - 'next_scheduled_at'"
            if schema == 'job_engine' and table in ['schedule_run', 'batch', 'message']:
                where = " WHERE state IN ('completed','failed','acked','dead')"
            if schema == 'dbos' and table == 'workflow_status':
                where = " WHERE status IN ('SUCCESS','ERROR','CANCELLED')"
            if schema == 'dbos' and table == 'operation_outputs':
                where = " WHERE workflow_uuid IN (SELECT workflow_uuid FROM dbos.workflow_status WHERE status IN ('SUCCESS','ERROR','CANCELLED'))"
            rows = self.sql(sha, f'''SELECT coalesce(json_agg(md5(({select})::text) ORDER BY md5(({select})::text)), '[]') FROM "{schema}"."{table}" t{where};''')
            result[schema + '.' + table] = rows
        for name, query in {
            'metadata.schema': "SELECT coalesce(json_agg(md5(row_to_json(c)::text) ORDER BY table_schema,table_name,ordinal_position), '[]') FROM information_schema.columns c WHERE table_schema IN ('public','job_engine','dbos')",
            'metadata.roles': "SELECT json_agg(md5(json_build_array(rolname,rolsuper,rolcreaterole,rolcreatedb,rolcanlogin,rolbypassrls)::text) ORDER BY rolname) FROM pg_roles WHERE rolname IN ('app','migrator','readonly')",
        }.items():
            result[name] = self.sql(sha, query + ';')
        return result

    def preserved(self, before, sha):
        after = self.snapshot(sha)
        require(all(set(rows).issubset(after.get(table, [])) for table, rows in before.items()),
                'previous persistent business/terminal engine rows changed or disappeared')
        return after

    def volumes(self, sha):
        result = {}
        for service in ['postgres', 'valkey', 'jobs', 'caddy']:
            container = self.compose(sha, 'ps', '-a', '-q', service)
            mounts = json.loads(self.docker('inspect', '--format', '{{json .Mounts}}', container))
            result[service] = {m['Destination']: m['Name'] for m in mounts if m['Type'] == 'volume'}
        return result

    def runtime_checks(self, sha):
        config = json.loads(self.compose(sha, 'config', '--format', 'json'))
        observed = []
        for name, service in config['services'].items():
            require(not service.get('build'), 'server build configured')
            require(name == 'caddy' or not service.get('ports'), 'data port published')
            if name in ['web', 'jobs']:
                require(not any(any(term in secret['source'] for term in ['migrator', 'postgres_password', 'readonly', 'backup'])
                                for secret in service.get('secrets', [])), 'privileged secret mounted into app')
            if name not in ['web', 'caddy']:
                require(set(service.get('networks', {})) == {'data'}, 'data service exposed to ingress')
            container = self.compose(sha, 'ps', '-a', '-q', name)
            inspected = json.loads(self.docker('inspect', container))[0]
            require(inspected['Config']['User'].split(':')[0] not in ['', '0', 'root'], 'root container')
            if name != 'migrate':
                uid = self.compose(sha, 'exec', '-T', name, 'id', '-u')
                require(uid.isdigit() and int(uid) > 0, 'runtime root UID')
            else:
                uid = inspected['Config']['User'].split(':')[0]
            observed.append({'service': name, 'uid': int(uid),
                             'state': inspected['State']['Status'],
                             'exitCode': inspected['State']['ExitCode'],
                             'health': inspected['State'].get('Health', {}).get('Status'),
                             'image': inspected['Config']['Image'],
                             'networks': sorted(inspected['NetworkSettings']['Networks']),
                             'publishedPorts': sorted(inspected['HostConfig'].get('PortBindings') or {}),
                             'secretNames': sorted(secret['source'] for secret in service.get('secrets', []))})
            require(not inspected['HostConfig'].get('Privileged'), 'privileged container')
            if name != 'caddy':
                require(not inspected['HostConfig'].get('PortBindings'), 'runtime data port published')
            if name in ['web', 'jobs']:
                destinations = {m['Destination'] for m in inspected['Mounts']}
                require(not any('/run/secrets/' + secret in destinations for secret in
                                ['migrator_database_url', 'postgres_password', 'readonly_db_password', 'backup_s3_secret_access_key']),
                        'runtime privileged secret leaked')
                probe = "const fs=require('fs'),{Client}=require('module').createRequire(require.resolve('@product-res/platform'))('pg'); const u=fs.readFileSync('/run/secrets/app_database_url','utf8').trim();if(new URL(u).searchParams.get('sslmode')!=='verify-full')process.exit(1);const c=new Client({connectionString:u});c.connect().then(()=>c.query('select current_user as role, ssl from pg_stat_ssl where pid=pg_backend_pid()')).then(r=>{console.log(JSON.stringify({role:r.rows[0].role,tls:r.rows[0].ssl,uid:process.getuid()}));return c.end()}).catch(()=>process.exit(1));"
                result = json.loads(self.compose(sha, 'exec', '-T', name, 'node', '-e', probe))
                require(result == {'role': 'app', 'tls': True, 'uid': 1000}, 'app role/PG TLS/UID mismatch')
                negative = probe.replace("const c=new Client({connectionString:u});", "const bad=new URL(u);bad.searchParams.delete('sslmode');const c=new Client({connectionString:bad.toString(),ssl:{rejectUnauthorized:true,ca:'invalid fixture CA'}});")
                require(self.run(['docker', 'exec', container, 'node', '-e', negative], check=False).returncode != 0,
                        'PG accepted invalid CA')
                hostname = "const fs=require('fs'),{Client}=require('module').createRequire(require.resolve('@product-res/platform'))('pg');require('dns').promises.lookup('postgres').then(({address})=>{const u=new URL(fs.readFileSync('/run/secrets/app_database_url','utf8').trim());u.hostname=address;const c=new Client({connectionString:u.toString()});c.connect().then(()=>c.end().then(()=>process.exit(0))).catch(()=>process.exit(1))}).catch(()=>process.exit(2));"
                require(self.run(['docker', 'exec', container, 'node', '-e', hostname], check=False).returncode == 1,
                        'PG accepted certificate hostname mismatch')
        ports = sorted(str(p['published']) for p in config['services']['caddy']['ports'])
        require(ports == ['443', '80'], 'plain Compose ports differ')
        positive = self.run([self.real_curl, '--silent', '--fail', '--noproxy', '*', '--cacert',
            str(self.deploy_dir / 'certs/ca.crt'), '--resolve', self.domain + ':443:127.0.0.1',
            '--max-time', '10', 'https://' + self.domain + '/api/health'])
        require(json.loads(positive.stdout)['version'] == sha, 'HTTPS full SHA differs')
        require(self.run([self.real_curl, '--silent', '--noproxy', '*', '--resolve',
            self.domain + ':443:127.0.0.1', '--max-time', '10', 'https://' + self.domain + '/api/health'],
            check=False).returncode == 60, 'unknown HTTPS CA was not rejected')
        self.mark('runtime TLS ports secrets UID', sha=sha, pgVerifyFull=True, invalidPgCaRejected=True,
                  unknownHttpsCaRejected=True, pgHostnameMismatchRejected=True, secretsDirectoryMode='0700',
                  secretFiles='0644 under restricted parent (Docker Desktop)' if self.desktop else '0600 service UID',
                  services=observed)

    def fixture(self):
        source = self.directory / 'fixture-source'
        runtime = source / 'deploy/selfhost'
        for name in self.module.RUNTIME_FILES:
            target = runtime / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.bundle / name, target)
        (runtime / 'images').mkdir()
        shutil.copy2(self.bundle / 'image-catalog.json', runtime / 'images/catalog.json')
        (source / 'version-fixture').write_text('metadata-only second version ' + self.project + '\n')
        self.run(['git', 'init', '-q', str(source)])
        self.run(['git', '-C', str(source), 'add', '.'])
        self.run(['git', '-C', str(source), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'version metadata fixture'])
        self.b = self.run(['git', '-C', str(source), 'rev-parse', 'HEAD']).stdout.decode().strip()
        port = available(0)
        self.docker('run', '-d', '--name', self.registry, '-p', f'127.0.0.1:{port}:5000', REGISTRY, timeout=900)
        self.registry_created = True
        namespace = f'localhost:{port}/fixture'
        deadline = time.monotonic() + 30
        while True:
            try:
                with urllib.request.urlopen(f'http://localhost:{port}/v2/', timeout=2):
                    break
            except OSError:
                require(time.monotonic() < deadline, 'local registry did not become ready')
                time.sleep(1)
        images = []
        replacements = []
        for name, reference in self.release['images'].items():
            context = self.directory / ('metadata-' + name)
            context.mkdir()
            lines = [f'FROM {reference}', f'ENV APP_VERSION={self.b}',
                     f'LABEL org.opencontainers.image.revision="{self.b}"']
            if name in ['web', 'jobs']:
                container = self.docker('create', reference)
                self.containers.append(container)
                self.docker('cp', container + ':/app/server', str(context / 'server'))
                self.docker('rm', container)
                self.containers.remove(container)
                changed = 0
                for path in (context / 'server').rglob('*'):
                    if not path.is_file():
                        continue
                    data = path.read_bytes()
                    count = data.count(self.a.encode())
                    if count:
                        updated = data.replace(self.a.encode(), self.b.encode())
                        require(updated.replace(self.b.encode(), self.a.encode()) == data, 'non-metadata byte change')
                        path.write_bytes(updated)
                        replacements.append({'service': name, 'file': path.relative_to(context).as_posix(),
                                             'beforeSha256': sha256(data), 'afterSha256': sha256(updated),
                                             'fullShaReplacementCount': count, 'onlyShaBytesChanged': True})
                        changed += count
                require(changed > 0, 'compiled application SHA metadata missing')
                lines += ['COPY --chown=1000:1000 server/ /app/server/']
            elif name == 'migrate':
                (context / 'version').write_text(self.b)
                lines += ['COPY version /version']
            (context / 'Dockerfile').write_text('\n'.join(lines) + '\n')
            tag = f'{namespace}/{name}:{self.b}'
            self.images.append(tag)
            self.docker('build', '--pull=false', '--provenance=false', '-t', tag, str(context), timeout=300)
            self.docker('push', tag, timeout=120)
            request = urllib.request.Request(f'http://localhost:{port}/v2/fixture/{name}/manifests/{self.b}',
                headers={'Accept': 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'})
            with urllib.request.urlopen(request, timeout=10) as response:
                digest = response.headers['Docker-Content-Digest']
            images.append({'name': name, 'tag': tag, 'digest': digest, 'reference': f'{namespace}/{name}@{digest}'})
        self.report['fixtureSha'] = self.b
        self.report['fixtureMetadataDiff'] = replacements
        self.report['fixtureDefinition'] = 'same GHCR business/schema/handlers; ENV, OCI revision, /version and compiled full SHA literal only'
        image_set = self.directory / 'fixture-image-set.json'
        image_set.write_text(json.dumps({'schemaVersion': 1, 'sha': self.b, 'namespace': namespace,
            'platforms': ['linux/arm64' if self.arch == 'arm64' else 'linux/amd64'], 'images': images}))
        bundle = self.directory / 'bundle-fixture'
        self.module.build_bundle(source, self.b, image_set, bundle, compatible=[self.a], fixture=True)
        self.mark('metadata-only local registry second version', sha=self.b)
        return bundle

    def execute(self):
        for port in [80, 443]:
            try:
                available(port)
            except OSError as error:
                raise Failure('host port 80/443 occupied or unavailable; refusing existing service changes; run isolated CI') from error
        require(self.real_curl, 'curl required')
        self.docker('compose', 'version')
        info = json.loads(self.docker('info', '--format', '{{json .}}'))
        self.desktop = 'docker desktop' in str(info.get('OperatingSystem', '')).lower()
        self.arch = info['Architecture']
        require(self.arch in ['aarch64', 'arm64', 'x86_64', 'amd64'], 'unsupported daemon architecture')
        self.arch = 'arm64' if self.arch in ['aarch64', 'arm64'] else 'amd64'
        require(not self.docker('volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + self.project), 'project not empty')
        self.stage = 'GHCR pull (15 minute maximum)'
        pull_deadline = time.monotonic() + 900
        for reference in self.release['images'].values():
            require(pull_deadline > time.monotonic(), 'GHCR pull exceeded 15 minutes; rerun in CI')
            self.docker('pull', reference, timeout=max(1, pull_deadline - time.monotonic()))
            image = json.loads(self.docker('image', 'inspect', reference))[0]
            require(image['Config']['Labels'].get('org.opencontainers.image.revision') == self.a, 'GHCR image revision differs')
        self.mark('GHCR image set verified', sha=self.a, imageCount=len(self.release['images']), platform='linux/' + self.arch)
        self.configure()
        self.deploy(self.a, self.bundle)
        require(self.state()['successful']['sha'] == self.a, 'initial success SHA differs')
        completed = self.sql(self.a, "SELECT json_build_object('heartbeat', (SELECT count(*) FROM job_engine.schedule_run WHERE schedule_id='jobs-heartbeat-v1' AND state='completed'),'inboxRows',(SELECT count(*) FROM job_engine.message),'heartbeatValue',(SELECT value FROM setting WHERE key='jobs.lastCronAt'));")
        require(completed['heartbeat'] > 0 and completed['heartbeatValue'], 'no genuine completed five-minute heartbeat')
        self.mark('initial GHCR deployment and real heartbeat', sha=self.a, completedHeartbeatCount=completed['heartbeat'],
                  inboxRows=completed['inboxRows'], nonemptyInboxVerified=completed['inboxRows'] > 0)
        self.runtime_checks(self.a)
        baseline = self.snapshot(self.a)
        volumes = self.volumes(self.a)
        fixture = self.fixture()
        self.deploy(self.b, fixture)
        require(self.state()['successful']['sha'] == self.b and self.state()['previous']['sha'] == self.a, 'upgrade success/previous SHA differs')
        self.preserved(baseline, self.b)
        require(self.volumes(self.b) == volumes, 'upgrade replaced volumes')
        self.mark('existing version upgrade preserves persisted rows', sha=self.b,
                  snapshotSha256=sha256(json.dumps(baseline, sort_keys=True).encode()), volumesPreserved=True)
        self.runtime_checks(self.b)
        self.secret('migrator_database_url', self.app_url)
        success_before = self.state()['successful']
        self.deploy(self.b, fixture, success=False)
        require(self.state()['successful'] == success_before, 'migration failure changed successful record')
        ids = self.compose(self.b, 'ps', '-a', '-q', 'web', 'jobs').split()
        for container in ids:
            inspected = json.loads(self.docker('inspect', container))[0]
            require(not inspected['State']['Running'], 'target apps running after migration failure')
        self.mark('real migrator role failure blocks target apps', successfulSha=self.b, targetAppsStopped=True)
        self.secret('migrator_database_url', self.migration_url)
        cert = self.deploy_dir / 'certs/ca.crt'
        trusted = cert.read_bytes()
        # 注入测试客户端不信任CA；真实app/handlers保持正常，不制造DBOS内部状态。
        wrong = self.directory / 'wrong-ca.crt'
        self.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(self.directory / 'wrong-ca.key'),
                  '-out', str(wrong), '-days', '1', '-subj', '/CN=untrusted-fixture-CA'])
        wrapper = self.directory / 'test-bin/curl'
        wrapper.write_text(wrapper.read_text().replace(str(cert), str(wrong)))
        self.deploy(self.b, fixture, success=False, fault=True)
        require(self.state()['successful'] == success_before, 'health failure changed successful record')
        wrapper.write_text(wrapper.read_text().replace(str(wrong), str(cert)))
        require(cert.read_bytes() == trusted, 'application trust material mutated')
        self.mark('real HTTPS health failure preserves successful record', sha=self.b)
        before_rollback = self.snapshot(self.b)
        migration_id = self.compose(self.b, 'ps', '-a', '-q', 'migrate')
        self.deploy(self.a, rollback=True)
        require(self.state()['successful']['sha'] == self.a, 'rollback full SHA differs')
        require(self.compose(self.a, 'ps', '-a', '-q', 'migrate') == migration_id, 'rollback recreated/ran old migration')
        self.preserved(before_rollback, self.a)
        self.preserved(baseline, self.a)
        require(self.volumes(self.a) == volumes, 'rollback replaced persistent volumes')
        self.runtime_checks(self.a)
        self.mark('compatible rollback preserves real PG engine rows and volumes', sha=self.a,
                  noOldMigration=True, snapshotSha256=sha256(json.dumps(before_rollback, sort_keys=True).encode()),
                  rowCounts={table: len(rows) for table, rows in before_rollback.items()})
        self.report['passed'] = True
        self.write_report()

    def cleanup(self):
        # 只操作随机project标签及脚本记录的metadata容器；不用down/prune全局资源。
        clean_env = self.env
        self.report['cleanupComplete'] = True
        def quiet(args):
            result = subprocess.run(['docker', *args], env=clean_env, capture_output=True, timeout=60)
            if result.returncode:
                self.report['cleanupComplete'] = False
            return result
        try:
            ids = quiet(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + self.project]).stdout.decode().split()
            if ids:
                quiet(['rm', '-f', *ids])
            for kind in ['volume', 'network']:
                ids = quiet([kind, 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + self.project]).stdout.decode().split()
                if ids:
                    quiet([kind, 'rm', *ids])
            if self.registry_created:
                quiet(['rm', '-fv', self.registry])
            if self.containers:
                quiet(['rm', '-f', *self.containers])
            if self.images:
                quiet(['image', 'rm', *self.images])
        except (OSError, subprocess.SubprocessError):
            self.report['cleanupComplete'] = False
            self.write_report()
        finally:
            # Linux helper归还本任务临时目录属主，确保非root操作者也能清除受限证书目录。
            if not getattr(self, 'desktop', True) and os.geteuid() != 0:
                try:
                    quiet(['run', '--rm', '--user', '0:0', '--entrypoint', 'sh',
                           '-v', str(self.directory) + ':/fixture', self.release['images']['postgres'],
                           '-c', 'chown -R "$1:$2" /fixture', 'cleanup-helper',
                           str(os.getuid()), str(os.getgid())])
                except (OSError, subprocess.SubprocessError):
                    self.report['cleanupComplete'] = False
                    self.write_report()
            self.write_report()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--evidence', required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    acceptance = None
    with tempfile.TemporaryDirectory(prefix='selfhost-release-acceptance-') as temporary:
        try:
            acceptance = Acceptance(Path(temporary).resolve(), args.bundle.resolve(), args.evidence.resolve())
            acceptance.execute()
        except (Failure, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            reason = str(error) if isinstance(error, Failure) else type(error).__name__ + '; raw details withheld'
            print(json.dumps({'event': 'release.acceptance.failed', 'reason': reason}), file=sys.stderr)
            if acceptance:
                acceptance.report.update({'passed': False, 'failedStage': acceptance.stage, 'reason': reason})
                acceptance.write_report()
            return 1
        finally:
            if acceptance:
                acceptance.cleanup()
        if acceptance and not acceptance.report['cleanupComplete']:
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
