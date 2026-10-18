#!/usr/bin/env python3
"""正式 bundle 的分阶段 VM 验收；prepare 后由操作者从宿主重启 VM。

所有 Docker 命令只能在独立 VM 内以 root 执行。目录保存受限 secrets 与可恢复的
非秘密控制元数据；after-reboot 不执行 up/restart。cleanup 只清理本 harness 项目。
"""
import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('release_acceptance', Path(__file__).with_name('test-release-compose.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
Failure, require, sha256 = base.Failure, base.require, base.sha256


class VMAcceptance(base.Acceptance):
    def run(self, args, **kwargs):
        if str(args[0]).endswith('/deploy.sh') and '--local' in args and '--rollback' not in args:
            args = [*args, '--compose-file', 'compose.backup.yaml', '--env-file', '.env.backup']
        return super().run(args, **kwargs)

    def compose(self, sha, *args, **kwargs):
        bundle = self.deploy_dir / 'releases' / sha
        release = self.module.verify_bundle(bundle, sha, allow_fixture=True)
        clean = self.env.copy()
        self.env.update(self.module.image_env(release))
        try:
            return self.docker('compose', '--project-directory', str(self.deploy_dir),
                '--env-file', str(self.deploy_dir / '.env'), '--env-file', str(self.deploy_dir / '.env.backup'),
                '-f', str(bundle / 'compose.yaml'), '-f', str(bundle / 'compose.backup.yaml'), *args, **kwargs)
        finally:
            self.env = clean

    def mark(self, name, **metadata):
        super().mark(name, **metadata)
        self.save_control()

    def save_control(self):
        value = {key: getattr(self, key) for key in ['project', 'registry', 'registry_created', 'images',
                 'containers', 'domain', 'real_curl', 'desktop', 'arch', 'a'] if hasattr(self, key)}
        value['bundle'] = str(self.bundle)
        value['environment'] = self.env
        # env 只包含白名单 Docker endpoint、PATH 和匿名配置路径，不保存连接串。
        value['fixtureProject'] = self.project + '-s3'
        value['fixtureSha'] = getattr(self, 'b', None)
        (self.directory / 'control.json').write_text(json.dumps(value, indent=2) + '\n')
        (self.directory / 'control.json').chmod(0o600)

    @classmethod
    def resume(cls, directory, bundle, evidence):
        control = json.loads((directory / 'control.json').read_text())
        self = cls.__new__(cls)
        self.directory, self.bundle, self.evidence = directory, bundle, evidence
        require(str(bundle) == control['bundle'], 'bundle path differs from prepared harness')
        for key in ['project', 'registry', 'registry_created', 'images', 'containers', 'domain',
                    'real_curl', 'desktop', 'arch', 'a']:
            setattr(self, key, control.get(key, {'desktop': False, 'arch': 'amd64'}.get(key)))
        require(self.project.startswith('selfhost-release-') and len(self.project) == 29,
                'invalid harness project identity')
        self.env = control['environment']
        require(set(self.env).issubset({'PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT',
                'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_CONFIG'}), 'unsafe persisted environment')
        require(self.env['DOCKER_CONFIG'] == str(directory / 'docker-config'), 'anonymous Docker config differs')
        self.deploy_dir = directory / 'deployment'
        self.report = json.loads(evidence.read_text())
        self.records = self.report['checks']
        self.stage = 'resume'
        spec = importlib.util.spec_from_file_location('vm_bundle', bundle / 'release/bundle.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.module = module
        self.release = module.verify_bundle(bundle, self.a)
        self.app_url = (self.deploy_dir / 'secrets/app_database_url').read_text() if (self.deploy_dir / 'secrets/app_database_url').exists() else ''
        self.migration_url = (self.deploy_dir / 'secrets/migrator_database_url').read_text() if (self.deploy_dir / 'secrets/migrator_database_url').exists() else ''
        if control.get('fixtureSha'):
            self.b = control['fixtureSha']
        return self

    def fixture_compose(self, *args, **kwargs):
        return self.docker('compose', '--project-name', self.project + '-s3', '--env-file', '/dev/null',
                           '-f', str(self.directory / 's3-compose.yaml'), *args, **kwargs)

    def configure_backup(self):
        self.stage = 'isolated S3 TLS fixture configuration'
        fixture = self.directory / 's3-tls'
        fixture.mkdir(mode=0o700)
        self.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout',
            str(fixture / 'ca.key'), '-out', str(fixture / 'ca.crt'), '-days', '2', '-subj', '/CN=VM-backup-CA',
            '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
            '-addext', 'subjectKeyIdentifier=hash'])
        extension = fixture / 'extensions'
        extension.write_text('subjectAltName=DNS:tls\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n')
        self.run(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout',
            str(fixture / 'server.key'), '-out', str(fixture / 'server.csr'), '-subj', '/CN=tls'])
        self.run(['openssl', 'x509', '-req', '-in', str(fixture / 'server.csr'), '-CA', str(fixture / 'ca.crt'),
            '-CAkey', str(fixture / 'ca.key'), '-CAcreateserial', '-out', str(fixture / 'server.crt'),
            '-days', '2', '-extfile', str(extension)])
        # 根私钥留在root受限目录；proxy只挂leaf，backup只挂公共CA。
        for name in ['server.key', 'server.crt']:
            self.permission(fixture / name, 1000, private=name.endswith('.key'))
        (fixture / 'ca.crt').chmod(0o644)
        for fixture_name, backup_name in [('s3_admin_access_key_id', 'backup_s3_access_key_id'),
                                         ('s3_admin_secret_access_key', 'backup_s3_secret_access_key')]:
            value = self.secret(fixture_name)
            target = self.deploy_dir / 'secrets' / backup_name
            target.write_text(value)
            self.permission(target, 999)
        for name in ['s3_access_key_id', 's3_secret_access_key']:
            self.secret(name)
        secrets = self.deploy_dir / 'secrets'
        image = self.release['images']
        q = lambda value: json.dumps(str(value))
        script = '/src/deploy/selfhost/backup/acceptance-s3.mjs'
        text = f'''name: {self.project}-s3
x-safe: &safe
  user: '1000:1000'
  cap_drop: [ALL]
  security_opt: [no-new-privileges:true]
  networks: [data]
  logging: {{driver: json-file, options: {{max-size: 2m, max-file: '2'}}}}
services:
  object-storage:
    <<: *safe
    image: {q(image['object-storage'])}
    restart: unless-stopped
    mem_limit: 512m
    cpus: 0.3
    environment:
      S3_PUBLIC_DOMAIN: tls
      S3_BUCKET: backup-fixture
      S3_ADMIN_ACCESS_KEY_ID_FILE: /run/secrets/s3_admin_access_key_id
      S3_ADMIN_SECRET_ACCESS_KEY_FILE: /run/secrets/s3_admin_secret_access_key
      S3_ACCESS_KEY_ID_FILE: /run/secrets/s3_access_key_id
      S3_SECRET_ACCESS_KEY_FILE: /run/secrets/s3_secret_access_key
      GOMEMLIMIT: 384MiB
      GOMAXPROCS: '1'
    secrets: [s3_admin_access_key_id, s3_admin_secret_access_key, s3_access_key_id, s3_secret_access_key]
    volumes: [objects:/data, metadata:/metadata]
    tmpfs: ['/tmp:uid=1000,gid=1000,mode=0700']
    healthcheck: {{test: [CMD, /usr/local/bin/object-storage-health], interval: 2s, timeout: 3s, retries: 60}}
  tls:
    <<: *safe
    image: {q(image['migrate'])}
    restart: unless-stopped
    mem_limit: 128m
    cpus: 0.1
    entrypoint: [node, {script}]
    command: [proxy]
    volumes:
      - {q(str(fixture / 'server.key') + ':/fixture/server.key:ro')}
      - {q(str(fixture / 'server.crt') + ':/fixture/server.crt:ro')}
      - {q(str(Path(__file__).parent / 'backup/acceptance-s3.mjs') + ':' + script + ':ro')}
  s3tool:
    <<: *safe
    image: {q(image['migrate'])}
    mem_limit: 256m
    cpus: 0.2
    entrypoint: [node, {script}]
    secrets: [s3_admin_access_key_id, s3_admin_secret_access_key]
    volumes: [{q(str(Path(__file__).parent / 'backup/acceptance-s3.mjs') + ':' + script + ':ro')}]
networks:
  data: {{external: true, name: {self.project}_data}}
volumes:
  objects: {{}}
  metadata: {{}}
secrets:
'''
        for name in ['s3_admin_access_key_id', 's3_admin_secret_access_key', 's3_access_key_id', 's3_secret_access_key']:
            text += f'  {name}: {{file: {q(secrets / name)}}}\n'
        (self.directory / 's3-compose.yaml').write_text(text)
        utc = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1)).strftime('%H:%M')
        values = {'BACKUP_S3_ENDPOINT': 'https://tls:8443', 'BACKUP_S3_REGION': 'us-east-1',
                  'BACKUP_S3_PREFIX': 's3://backup-fixture/cluster', 'BACKUP_S3_FORCE_PATH_STYLE': 'true',
                  'BACKUP_CA_FILE': str(fixture / 'ca.crt'), 'BACKUP_UTC_TIME': utc,
                  'BACKUP_RETRY_SECONDS': '30', 'BACKUP_ARCHIVE_TIMEOUT_SECONDS': '60'}
        path = self.deploy_dir / '.env.backup'
        path.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
        path.chmod(0o600)
        self.save_control()
        self.docker('network', 'create', '--label', 'com.docker.compose.project=' + self.project,
                    '--label', 'com.docker.compose.network=data', self.project + '_data')
        self.fixture_compose('up', '-d', '--wait', '--wait-timeout', '120', 'object-storage', 'tls', timeout=180)
        self.fixture_compose('run', '--rm', '--no-deps', 's3tool', 'init')
        config = json.loads(self.fixture_compose('config', '--format', 'json'))
        require(all(not s.get('ports') and not s.get('build') for s in config['services'].values()),
                'fixture publishes ports or builds image')
        self.mark('isolated backup S3 TLS fixture', noPublishedDataPorts=True,
                  testOnlyHelperMounted=True, businessSourceMounted=False)

    def heartbeat(self, sha):
        return self.sql(sha, "SELECT json_build_object('count',(SELECT count(*) FROM job_engine.schedule_run WHERE schedule_id='jobs-heartbeat-v1' AND state='completed'),'at',(SELECT value FROM setting WHERE key='jobs.lastCronAt')); ")

    def health(self, sha):
        public = json.loads(self.run([self.real_curl, '--silent', '--fail', '--noproxy', '*', '--cacert',
            str(self.deploy_dir / 'certs/ca.crt'), '--resolve', self.domain + ':443:127.0.0.1',
            '--max-time', '10', 'https://' + self.domain + '/api/health']).stdout)
        probe = "fetch('http://127.0.0.1:3001/internal/ready',{signal:AbortSignal.timeout(10000)}).then(async r=>{if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()))}).catch(()=>process.exit(1))"
        jobs = json.loads(self.compose(sha, 'exec', '-T', 'jobs', 'node', '-e', probe))
        for body in [public, jobs]:
            require(body['status'] == 'ok' and body['version'] == sha and all(
                body[name]['status'] == 'up' for name in ['db', 'cache', 'queue', 'scheduler']),
                'web/jobs health components or full SHA differ')
        return {'web': {'version': sha, 'componentsUp': True}, 'jobs': {'version': sha, 'componentsUp': True}}

    def backup_status(self, sha):
        return json.loads(self.compose(sha, 'exec', '-T', 'backup', 'python3',
                          '/usr/local/lib/selfhost-backup/backup.py', 'status'))

    def wait(self, check, reason, timeout=360):
        deadline = time.monotonic() + timeout
        while True:
            try:
                value = check()
                if value:
                    return value
            except (Failure, ValueError, KeyError, TypeError):
                pass
            require(time.monotonic() < deadline, reason)
            time.sleep(3)

    def containers_state(self, sha):
        result = {}
        for name in ['postgres', 'valkey', 'web', 'jobs', 'caddy', 'backup', 'migrate']:
            cid = self.compose(sha, 'ps', '-a', '-q', name)
            item = json.loads(self.docker('inspect', cid))[0]
            result[name] = {'id': cid, 'state': item['State']['Status'], 'running': item['State']['Running'],
                'exitCode': item['State']['ExitCode'], 'finishedAt': item['State']['FinishedAt'],
                'startedAt': item['State']['StartedAt'], 'restartCount': item['RestartCount'],
                'health': item['State'].get('Health', {}).get('Status')}
        for name in ['object-storage', 'tls']:
            cid = self.fixture_compose('ps', '-a', '-q', name)
            item = json.loads(self.docker('inspect', cid))[0]
            result['fixture.' + name] = {'id': cid, 'running': item['State']['Running'],
                                       'startedAt': item['State']['StartedAt']}
        return result

    def owners(self, sha):
        # 只输出文件名与内容的摘要；owner token、PID资料不穿透证据。
        script = "const fs=require('fs'),c=require('crypto'),p='/app/.data/job-owners';const r={};for(const n of fs.readdirSync(p).sort()){if(n.endsWith('.json'))r[c.createHash('sha256').update(n).digest('hex')]=c.createHash('sha256').update(fs.readFileSync(p+'/'+n)).digest('hex')}console.log(JSON.stringify(r))"
        result = json.loads(self.compose(sha, 'exec', '-T', 'jobs', 'node', '-e', script))
        require(len(result) >= 2, 'persistent owner metadata absent')
        return result

    def scheduler_running(self, sha):
        script = "import fcntl;f=open('/var/lib/selfhost-backup/scheduler.lock','a');\ntry:\n fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError:\n print('held')"
        require(self.compose(sha, 'exec', '-T', 'backup', 'python3', '-c', script).strip() == 'held',
                'backup scheduler has not resumed its persistent lock')

    def prepare(self):
        self.report.update({'scope': 'Debian 12 independent VM; official GHCR bundle and real host reboot',
            'notVerified': ['cross-host recovery', 'unfinished task replay'], 'phases': {}})
        self.stage = 'VM preflight'
        require(os.geteuid() == 0, 'VM harness requires root for service UID file permissions')
        require(self.real_curl, 'curl required')
        for port in [80, 443]:
            base.available(port)
        require(not self.env.get('DOCKER_HOST') or self.env['DOCKER_HOST'].startswith('unix://'),
                'VM harness requires a local Docker Unix endpoint')
        require(self.env.get('DOCKER_CONTEXT', 'default') == 'default', 'VM harness requires default local Docker context')
        self.docker('compose', 'version')
        info = json.loads(self.docker('info', '--format', '{{json .}}'))
        self.desktop = 'docker desktop' in str(info.get('OperatingSystem', '')).lower()
        require(not self.desktop, 'VM harness refuses Docker Desktop')
        self.arch = 'arm64' if info['Architecture'] in ['aarch64', 'arm64'] else 'amd64'
        require(info['Architecture'] in ['aarch64', 'arm64', 'x86_64', 'amd64'], 'unsupported VM architecture')
        self.save_control()
        self.stage = 'anonymous GHCR eight-image pull'
        deadline = time.monotonic() + 900
        for reference in self.release['images'].values():
            require(time.monotonic() < deadline, 'anonymous pull exceeded 15 minutes')
            self.docker('pull', reference, timeout=max(1, deadline - time.monotonic()))
            image = json.loads(self.docker('image', 'inspect', reference))[0]
            require(image['Config']['Labels'].get('org.opencontainers.image.revision') == self.a,
                    'official image revision differs')
        require(len(self.release['images']) == 8, 'release does not contain eight images')
        self.mark('anonymous GHCR eight-image pull', sha=self.a, imageCount=8, platform='linux/' + self.arch)
        self.configure()
        self.configure_backup()
        self.stage = 'initial official deployment with backup override'
        self.deploy(self.a, self.bundle)
        require(self.state()['successful']['sha'] == self.a, 'initial deployment success record differs')
        heartbeat = self.wait(lambda: (h if (h := self.heartbeat(self.a))['count'] > 0 and h['at'] else None),
                              'natural heartbeat did not complete')
        self.runtime_checks(self.a)
        self.stage = 'complete backup base dump verify schedule cycle'
        backup = self.wait(lambda: (b if (b := self.backup_status(self.a)).get('healthy') and
            b.get('schedule', {}).get('ok') and b.get('schedule', {}).get('slot') and
            all(b.get(key, {}).get('ok') for key in ['base', 'dump', 'verification']) else None),
            'complete base/dump/verify scheduled backup did not succeed', timeout=600)
        self.scheduler_running(self.a)
        snapshot = {'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'sha': self.a, 'containers': self.containers_state(self.a), 'heartbeat': heartbeat,
            'health': self.health(self.a), 'owners': self.owners(self.a),
            'volumes': self.volumes(self.a), 'rows': self.snapshot(self.a),
            'backup': {}}
        # backup状态只留用于重启比对的成功slot和ID，避免对象名、角色或正文进入证据。
        snapshot['backup'] = {'slot': backup['schedule']['slot'], 'lastSuccess': backup['schedule']['lastSuccess'],
                              'backupId': backup['base']['backupId']}
        path = self.directory / 'before-reboot.json'
        path.write_text(json.dumps(snapshot, indent=2) + '\n')
        path.chmod(0o644)
        self.report['phases']['prepare'] = {'passed': True, 'bootId': snapshot['bootId']}
        self.mark('prepare ready for real VM reboot', sha=self.a, naturalHeartbeatCount=heartbeat['count'],
            completeBackup=True, backupSlot=backup['schedule']['slot'],
            ownerMetadataSha256=sha256(json.dumps(snapshot['owners'], sort_keys=True).encode()))

    def after_reboot(self):
        self.stage = 'real VM reboot recovery'
        before = json.loads((self.directory / 'before-reboot.json').read_text())
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        require(boot != before['bootId'], 'VM boot ID unchanged; real host reboot required')
        def recovered():
            services = self.containers_state(self.a)
            return services if all(s['running'] for n, s in services.items() if n != 'migrate') else None
        services = self.wait(recovered, 'resident services did not recover automatically')
        require(all(services[n]['startedAt'] != before['containers'][n]['startedAt']
            for n in services if n != 'migrate'), 'resident service did not restart across VM boot')
        migration = services['migrate']
        for key in ['id', 'finishedAt', 'restartCount']:
            require(migration[key] == before['containers']['migrate'][key], 'reboot recreated or reran migrate')
        require(not migration['running'] and migration['exitCode'] == 0, 'migration completion not preserved')
        heartbeat = self.wait(lambda: (h if (h := self.heartbeat(self.a))['count'] > before['heartbeat']['count']
            and h['at'] != before['heartbeat']['at'] else None), 'no fresh natural heartbeat after reboot')
        health = self.wait(lambda: self.health(self.a), 'web/jobs health did not return all-up/full SHA')
        self.scheduler_running(self.a)
        backup = self.backup_status(self.a)
        require(backup['schedule']['slot'] == before['backup']['slot'] and
            backup['schedule']['lastSuccess'] == before['backup']['lastSuccess'] and
            backup['base']['backupId'] == before['backup']['backupId'], 'reboot lost/duplicated successful backup slot')
        require(backup['healthy'], 'backup not healthy after reboot')
        owners = self.owners(self.a)
        preserved = sum(owners.get(key) == value for key, value in before['owners'].items())
        require(preserved >= len(before['owners']) - 1, 'previous owner incarnation metadata disappeared')
        require(self.volumes(self.a) == before['volumes'], 'reboot replaced data volumes')
        self.preserved(before['rows'], self.a)
        self.report['phases']['after-reboot'] = {'passed': True, 'previousBootId': before['bootId'], 'bootId': boot}
        self.mark('real VM reboot resumes services without migrate replay', sha=self.a, containers=services,
            health=health, freshNaturalHeartbeatCount=heartbeat['count'], migrationUnchanged=True,
            successfulBackupSlotPreserved=True, backupSchedulerResumed=True,
            priorOwnerMetadataRecordsPreserved=preserved,
            ownerMetadataSha256=sha256(json.dumps(owners, sort_keys=True).encode()), volumesPreserved=True)

    def gates(self):
        require(self.report.get('phases', {}).get('after-reboot', {}).get('passed'),
                'gates requires successful after-reboot phase')
        # SSH阶段使用系统信任；本地负向TLS断言须恢复未信任测试CA的状态。
        ca = Path('/usr/local/share/ca-certificates/d-vm-fixture.crt')
        if ca.exists():
            ca.unlink()
            self.run(['update-ca-certificates', '--fresh'])
        baseline, volumes = self.snapshot(self.a), self.volumes(self.a)
        fixture = self.directory / 'bundle-fixture'
        if hasattr(self, 'b') and fixture.exists():
            self.module.verify_bundle(fixture, self.b, allow_fixture=True)
        else:
            fixture = self.fixture()
        self.deploy(self.b, fixture)
        require(self.state()['successful']['sha'] == self.b and self.state()['previous']['sha'] == self.a,
                'upgrade success/previous SHA differs')
        self.preserved(baseline, self.b)
        require(self.volumes(self.b) == volumes, 'upgrade replaced volumes')
        self.runtime_checks(self.b)
        self.mark('existing version upgrade preserves persisted rows', sha=self.b, volumesPreserved=True)
        self.secret('migrator_database_url', self.app_url)
        success_before = self.state()['successful']
        self.stage = 'real migration privilege failure'
        self.deploy(self.b, fixture, success=False)
        require(self.state()['successful'] == success_before, 'migration failure changed successful record')
        for cid in self.compose(self.b, 'ps', '-a', '-q', 'web', 'jobs').split():
            require(not json.loads(self.docker('inspect', cid))[0]['State']['Running'],
                    'target apps running after migration failure')
        self.mark('real migrator role failure blocks target apps', successfulSha=self.b, targetAppsStopped=True)
        self.secret('migrator_database_url', self.migration_url)
        cert = self.deploy_dir / 'certs/ca.crt'
        trusted = cert.read_bytes()
        wrong = self.directory / 'wrong-ca.crt'
        self.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout',
            str(self.directory / 'wrong-ca.key'), '-out', str(wrong), '-days', '1', '-subj', '/CN=untrusted-VM-CA'])
        wrapper = self.directory / 'test-bin/curl'
        wrapper.write_text(wrapper.read_text().replace(str(cert), str(wrong)))
        try:
            self.stage = 'real HTTPS readiness failure'
            self.deploy(self.b, fixture, success=False, fault=True)
            require(self.state()['successful'] == success_before, 'health failure changed successful record')
        finally:
            wrapper.write_text(wrapper.read_text().replace(str(wrong), str(cert)))
        require(cert.read_bytes() == trusted, 'application trust material mutated')
        self.mark('real HTTPS health failure preserves successful record', sha=self.b)
        before = self.snapshot(self.b)
        migration = self.compose(self.b, 'ps', '-a', '-q', 'migrate')
        self.deploy(self.a, rollback=True)
        require(self.state()['successful']['sha'] == self.a, 'rollback full SHA differs')
        require(self.compose(self.a, 'ps', '-a', '-q', 'migrate') == migration, 'rollback reran old migration')
        self.preserved(before, self.a)
        self.preserved(baseline, self.a)
        require(self.volumes(self.a) == volumes, 'rollback replaced persistent volumes')
        self.runtime_checks(self.a)
        self.health(self.a)
        self.report['phases']['gates'] = {'passed': True}
        self.report['passed'] = True
        self.report.pop('failedStage', None)
        self.report.pop('reason', None)
        self.mark('compatible rollback preserves PG engine rows and volumes', sha=self.a,
                  noOldMigration=True, volumesPreserved=True,
                  snapshotSha256=sha256(json.dumps(before, sort_keys=True).encode()))

    def ssh(self):
        require(self.report.get('phases', {}).get('after-reboot', {}).get('passed'),
                'SSH exercise requires completed reboot comparison')
        self.stage = 'explicit SSH deployment inside the temporary VM'
        ssh = self.directory / 'ssh-fixture'
        ssh.mkdir(mode=0o700, exist_ok=True)
        key = ssh / 'identity'
        if not key.exists():
            self.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)])
        authorized = Path('/root/.ssh/authorized_keys')
        authorized.parent.mkdir(mode=0o700, exist_ok=True)
        # 仅添加这台独占临时 VM 的测试公钥，不改真实服务器或忽略主机密钥。
        public_key = key.with_suffix('.pub').read_text()
        if not authorized.exists() or public_key not in authorized.read_text():
            with authorized.open('a') as target:
                target.write(public_key)
        authorized.chmod(0o600)
        host_key = Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().split()
        known = ssh / 'known_hosts'
        known.write_text('127.0.0.1 ' + ' '.join(host_key[:2]) + '\n')
        config = ssh / 'config'
        config.write_text('Host d-vm-self\n  HostName 127.0.0.1\n  User root\n  IdentityFile ' + str(key) +
            '\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ' + str(known) + '\n')
        config.chmod(0o600)
        for tool in ['ssh', 'scp']:
            real = shutil.which(tool)
            require(real, 'SSH client tools unavailable')
            wrapper = self.directory / 'test-bin' / tool
            wrapper.write_text('#!' + sys.executable + '\nimport os,sys\nos.execv(' + repr(real) +
                ', [' + repr(real) + ', "-F", ' + repr(str(config)) + '] + sys.argv[1:])\n')
            wrapper.chmod(0o700)
        ca = Path('/usr/local/share/ca-certificates/d-vm-fixture.crt')
        shutil.copyfile(self.deploy_dir / 'certs/ca.crt', ca)
        self.run(['update-ca-certificates'])
        with Path('/etc/hosts').open('a') as target:
            target.write('\n127.0.0.1 ' + self.domain + '\n')
        # Lima 通过登录环境注入宿主代理；它无法解析这台 VM 私有的测试域名。
        # 原正式 bundle 保持不变，只有本次独占 VM 的 SSH 夹具明确绕过这个域名的代理。
        with Path('/etc/environment').open('a') as target:
            bypass = self.domain + ',127.0.0.1,localhost'
            target.write('\nNO_PROXY=' + bypass + '\nno_proxy=' + bypass + '\n')
        volumes = self.volumes(self.a)
        self.run([str(self.bundle / 'deploy.sh'), '--host', 'd-vm-self', '--dir', str(self.deploy_dir),
            '--sha', self.a, '--bundle', str(self.bundle), '--compose-file', 'compose.backup.yaml',
            '--env-file', '.env.backup'], timeout=1200)
        require(self.state()['successful']['sha'] == self.a, 'SSH target SHA differs')
        require(self.volumes(self.a) == volumes, 'SSH deployment replaced volumes')
        require(not list(self.deploy_dir.glob('.incoming-*')), 'SSH upload temporary directory retained')
        self.health(self.a)
        self.report['phases']['ssh'] = {'passed': True}
        self.mark('explicit SSH bundle transfer and deployment', verifiedHostKey=True,
                  batchMode=True, targetSha=self.a, volumesPreserved=True, incomingDirectoryCleaned=True)

    def cleanup(self):
        self.stage = 'cleanup owned projects'
        # fixture先移除，才移除它共享的app data网络。
        result = self.run(['docker', 'compose', '--project-name', self.project + '-s3', '--env-file', '/dev/null',
            '-f', str(self.directory / 's3-compose.yaml'), 'down', '-v', '--remove-orphans', '--timeout', '10'],
            check=False) if (self.directory / 's3-compose.yaml').exists() else None
        super().cleanup()
        require(result is None or result.returncode == 0, 'fixture cleanup failed')
        require(self.report['cleanupComplete'], 'owned resource cleanup failed')
        self.report.setdefault('phases', {})['cleanup'] = {'passed': True}
        self.write_report()
        shutil.rmtree(self.directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', required=True, choices=['prepare', 'after-reboot', 'ssh', 'gates', 'cleanup'])
    parser.add_argument('--directory', type=Path, default=Path('/opt/selfhost-d-vm-harness'))
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--evidence', type=Path, default=Path('/opt/d-vm-results/runtime.json'))
    args = parser.parse_args()
    os.umask(0o077)
    acceptance = None
    try:
        require(os.geteuid() == 0, 'VM harness must run as root')
        directory, bundle, evidence = args.directory.absolute(), args.bundle.resolve(), args.evidence.absolute()
        require(not any(path == Path('/tmp') for path in [directory, *directory.parents, bundle,
            *bundle.parents, evidence, *evidence.parents, Path(__file__), *Path(__file__).parents]),
            'VM reboot inputs and reports must use persistent paths outside /tmp')
        require(directory != Path('/') and len(directory.parts) > 2 and
            not any(p.is_symlink() for p in [directory, *directory.parents]), 'unsafe harness directory')
        require(not evidence.is_relative_to(directory), 'evidence must survive harness cleanup outside directory')
        if args.phase == 'prepare':
            require(not directory.exists(), 'prepare requires a new harness directory; cleanup previous run explicitly')
            directory.mkdir(mode=0o700, parents=True)
            acceptance = VMAcceptance(directory, bundle, evidence)
            acceptance.prepare()
        else:
            require(directory.is_dir() and not directory.stat().st_mode & 0o077, 'restricted harness directory required')
            acceptance = VMAcceptance.resume(directory, bundle, evidence)
            getattr(acceptance, args.phase.replace('-', '_'))()
        print(json.dumps({'event': 'vm.acceptance.phase', 'phase': args.phase, 'passed': True}), flush=True)
        return 0
    except Exception as error:
        # 原始子进程/异常上下文从不打印，Failure文字只由本脚本固定消息构成。
        reason = str(error) if isinstance(error, Failure) else type(error).__name__ + '; raw details withheld'
        print(json.dumps({'event': 'vm.acceptance.phase', 'phase': args.phase, 'passed': False, 'reason': reason}), flush=True)
        if acceptance:
            acceptance.report.update({'passed': False, 'failedStage': acceptance.stage, 'reason': reason})
            acceptance.report.setdefault('phases', {})[args.phase] = {'passed': False, 'reason': reason}
            acceptance.write_report()
            if args.phase != 'cleanup':
                acceptance.save_control()
        return 1


if __name__ == '__main__':
    sys.exit(main())
