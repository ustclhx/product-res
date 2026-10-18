#!/usr/bin/env python3
"""隔离真实 registry/Compose 的发布机制验收；不验证业务 PG、DBOS、TLS 或心跳。

运行 python3 deploy/selfhost/test-deploy-compose.py。需要 Docker/Compose v2、Git、curl。
夹具只构建本机平台，八服务使用相同 Node 夹具程序，镜像按服务标记完整源码 SHA。
fixture readiness 的依赖和心跳字段为合成响应，持久任务仅为 marker，不是 DBOS 状态。
"""
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
sys.path.insert(0, str(Path(__file__).parent))
from release.bundle import RUNTIME_FILES, SERVICE_ENV, build_bundle

ROOT = Path(__file__).parent
NODE = 'node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'
SERVICES = tuple(SERVICE_ENV)
PROGRAM = r'''
import fs from 'node:fs'
import http from 'node:http'
const role = process.env.FIXTURE_ROLE
const version = process.env.APP_VERSION
const record = stage => fs.appendFileSync('/state/migrations', JSON.stringify({stage, version}) + '\n')
if (role === 'migrate') {
  record('start')
  await new Promise(resolve => setTimeout(resolve, Number(process.env.FIXTURE_DELAY || 0) * 1000))
  record(process.env.FIXTURE_FAIL === '1' ? 'failed' : 'complete')
  process.exit(process.env.FIXTURE_FAIL === '1' ? 19 : 0)
}
if (role === 'postgres' && !fs.existsSync('/state/task')) fs.writeFileSync('/state/task', 'fixture-pending-task\n')
let server
if (role === 'web' || role === 'jobs') {
  server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({status: 'ok', version: role === 'web' && process.env.FIXTURE_OLD_SHA || version,
      db: {status: 'up'}, cache: {status: 'up'}, queue: {status: 'up'}, scheduler: {status: 'up'},
      jobs: {lastCronAt: new Date().toISOString()}, fixture: true}))
  }).listen(role === 'web' ? 3000 : 3001, '0.0.0.0')
} else if (role === 'caddy') {
  server = http.createServer((request, response) => {
    const upstream = http.request({hostname: 'web', port: 3000, path: request.url}, result => {
      response.writeHead(result.statusCode, result.headers)
      result.pipe(response)
    })
    upstream.on('error', () => {response.writeHead(503); response.end()})
    upstream.end()
  }).listen(8080, '0.0.0.0')
} else setInterval(() => {}, 1000)
process.on('SIGTERM', () => server ? server.close(() => process.exit(0)) : process.exit(0))
'''


class Failure(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Failure(message)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Acceptance:
    def __init__(self, directory):
        self.directory = directory
        self.registry = 'selfhost-deploy-registry-' + uuid.uuid4().hex[:12]
        self.projects = []
        self.images = []
        self.processes = []
        self.deadline = time.monotonic() + 900
        self.env = {key: value for key, value in os.environ.items() if key in (
            'PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
        # 使用匿名 registry 配置；保留实际 Docker endpoint/plugin，但不复制 registry 认证。
        original = Path(os.environ.get('DOCKER_CONFIG', str(Path.home() / '.docker')))
        config = directory / 'docker-config'
        config.mkdir()
        context = json.loads((original / 'config.json').read_text()).get('currentContext') if (original / 'config.json').exists() else None
        (config / 'config.json').write_text(json.dumps({'currentContext': context} if context else {}))
        for name in ['contexts', 'cli-plugins']:
            if (original / name).exists():
                (config / name).symlink_to(original / name, target_is_directory=True)
        self.env['DOCKER_CONFIG'] = str(config)

    def run(self, args, *, timeout=120, check=True, env=None):
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, 'Docker acceptance exceeded 15 minutes; retry in CI')
        result = subprocess.run(args, env=env or self.env, capture_output=True,
                                timeout=min(timeout, remaining))
        if check:
            require(result.returncode == 0, 'command failed: ' + ' '.join(args[:2]) + '; raw output withheld')
        return result

    def docker(self, *args, **kwargs):
        return self.run(['docker', *args], **kwargs).stdout.decode().strip()

    def source(self):
        source = self.directory / 'source'
        target = source / 'deploy/selfhost'
        for name in RUNTIME_FILES:
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, path)
        (target / 'images').mkdir()
        shutil.copy2(ROOT / 'images/catalog.json', target / 'images/catalog.json')
        (source / 'fixture.mjs').write_text(PROGRAM)
        lines = ['name: ${COMPOSE_PROJECT_NAME}', 'services:']
        for name in SERVICES:
            lines += [f'  {name}:', f'    image: ${{{SERVICE_ENV[name]}}}', '    user: "1000:1000"',
                      '    command: ["node", "/fixture.mjs"]', '    environment:',
                      f'      FIXTURE_ROLE: {name}', '      FIXTURE_FAIL: ${FIXTURE_FAIL:-0}',
                      '      FIXTURE_DELAY: ${FIXTURE_DELAY:-0}', '      FIXTURE_OLD_SHA: ${FIXTURE_OLD_SHA:-}',
                      '      APP_URL: http://127.0.0.1:${FIXTURE_PORT}',
                      '    volumes: ["state:/state"]', '    networks: [data]',
                      '    labels:', f'      selfhost.fixture.service: {name}']
            if name == 'caddy':
                lines += ['    ports: ["127.0.0.1:${FIXTURE_PORT}:8080"]']
            if name in ['postgres', 'valkey']:
                # PG夹具先写持久marker才就绪，避免空成功探针领先于主进程初始化。
                health = "if(!require('fs').existsSync('/state/task'))process.exit(1)" if name == 'postgres' else 'process.exit(0)'
                lines += ['    healthcheck:', '      test: ["CMD", "node", "-e", ' + json.dumps(health) + ']',
                          '      interval: 1s', '      timeout: 2s', '      retries: 5']
        lines += ['volumes:', '  state:', 'networks:', '  data:']
        (target / 'compose.yaml').write_text('\n'.join(lines) + '\n')
        self.run(['git', 'init', '-q', str(source)])
        self.run(['git', '-C', str(source), 'add', '.'])
        self.run(['git', '-C', str(source), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                  'commit', '-qm', 'fixture A'])
        a = self.run(['git', '-C', str(source), 'rev-parse', 'HEAD']).stdout.decode().strip()
        (source / 'fixture-revision').write_text('B\n')
        self.run(['git', '-C', str(source), 'add', '.'])
        self.run(['git', '-C', str(source), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                  'commit', '-qm', 'fixture B'])
        b = self.run(['git', '-C', str(source), 'rev-parse', 'HEAD']).stdout.decode().strip()
        return source, a, b

    def publish(self, source, sha, namespace, platform):
        context = self.directory / ('image-' + sha)
        context.mkdir()
        (context / 'fixture.mjs').write_bytes(self.run(['git', '-C', str(source), 'show', sha + ':fixture.mjs']).stdout)
        (context / 'Dockerfile').write_text(f'FROM {NODE}\nRUN mkdir /state && chown 1000:1000 /state\n'
            f'COPY --chown=1000:1000 fixture.mjs /fixture.mjs\nENV APP_VERSION={sha}\nUSER 1000:1000\n'
            f'LABEL org.opencontainers.image.revision="{sha}"\n')
        base = namespace + '/fixture:' + sha
        self.images.append(base)
        self.docker('build', '--platform', platform, '--provenance=false', '-t', base, str(context), timeout=300)
        images = []
        for name in SERVICES:
            tag = f'{namespace}/{name}:{sha}'
            self.images.append(tag)
            self.docker('tag', base, tag)
            self.docker('push', tag, timeout=120)
            # 收 registry 实际 manifest digest，不把本机 image ID 冒充 registry digest。
            request = urllib.request.Request('http://' + namespace.split('/')[0] + f'/v2/fixture/{name}/manifests/{sha}',
                headers={'Accept': 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'})
            with urllib.request.urlopen(request, timeout=10) as response:
                digest = response.headers['Docker-Content-Digest']
            reference = f'{namespace}/{name}@{digest}'
            self.images.append(reference)
            images.append({'name': name, 'digest': digest, 'reference': reference, 'tag': tag})
        image_set = self.directory / ('images-' + sha + '.json')
        image_set.write_text(json.dumps({'schemaVersion': 1, 'sha': sha, 'namespace': namespace,
                                        'platforms': [platform], 'images': images}))
        return image_set

    def project(self, name, port):
        directory = self.directory / name
        directory.mkdir(mode=0o700)
        self.projects.append(directory)
        self.configure(directory, port)
        return directory

    def configure(self, directory, port, **flags):
        values = {'COMPOSE_PROJECT_NAME': self.registry + '-' + directory.name, 'FIXTURE_PORT': str(port), **flags}
        path = directory / '.env'
        path.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
        path.chmod(0o600)

    def deployment(self, directory, sha, bundle=None, rollback=False):
        args = [sys.executable, str(ROOT / 'deploy.py'), '--local', '--dir', str(directory),
                '--rollback' if rollback else '--sha', sha, '--fixture', '--health-timeout', '15']
        if bundle:
            args += ['--bundle', str(bundle)]
        return args

    def deploy(self, directory, sha, bundle=None, *, rollback=False, success=True):
        result = self.run(self.deployment(directory, sha, bundle, rollback), timeout=300, check=False)
        if (result.returncode == 0) != success:
            # 发布入口只输出结构化脱敏事件；仍拒绝转发任意子进程原文。
            for line in (result.stdout + result.stderr).decode().splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict) and str(event.get('event', '')).startswith('selfhost.'):
                    print(json.dumps(event), flush=True)
            ids = self.docker('ps', '-aq', '--filter', 'label=com.docker.compose.project=' + self.registry + '-' + directory.name).split()
            if ids:
                for container in json.loads(self.docker('inspect', *ids)):
                    print(json.dumps({'event': 'fixture.container.state',
                                      'service': container['Config']['Labels']['com.docker.compose.service'],
                                      'status': container['State']['Status'], 'exitCode': container['State']['ExitCode']}), flush=True)
                    log_result = self.run(['docker', 'logs', container['Id']], check=False)
                    logs = (log_result.stdout + log_result.stderr).decode()
                    for error in ['EACCES', 'SyntaxError', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']:
                        if error in logs:
                            print(json.dumps({'event': 'fixture.container.error', 'code': error}), flush=True)
            raise Failure('unexpected deployment outcome; raw output withheld')
        return result.stdout.decode() + result.stderr.decode()

    def compose(self, directory, *args):
        state = self.state(directory)
        sha = state.get('attempted', state['successful'])['sha']
        release = directory / 'releases' / sha
        return self.run(['docker', 'compose', '--project-directory', str(directory), '--env-file', str(directory / '.env'),
                         '--env-file', str(release / 'images.env'), '-f', str(release / 'compose.yaml'), *args]).stdout.decode().strip()

    def state(self, directory):
        return json.loads((directory / 'release-state/state.json').read_text())

    def snapshot(self, directory):
        project = self.registry + '-' + directory.name
        # 发布可能正在recreate postgres夹具；读取卷避免把exec的瞬时失败当发布失败。
        return json.loads(self.docker('run', '--rm', '--network', 'none', '--user', '1000:1000',
            '--label', 'com.docker.compose.project=' + project,
            '--mount', 'type=volume,src=' + project + '_state,dst=/state,readonly', NODE, 'node', '-e',
            "const fs=require('fs'); console.log(JSON.stringify({task:fs.readFileSync('/state/task','utf8'),migrations:fs.readFileSync('/state/migrations','utf8')}))"))

    def apps(self, directory):
        ids = self.compose(directory, 'ps', '-q', 'web', 'jobs').split()
        return {item['Id']: item for item in json.loads(self.docker('inspect', *ids))} if ids else {}

    def checkpoint(self, name):
        print(json.dumps({'event': 'fixture.acceptance.passed', 'case': name}), flush=True)

    def execute(self):
        architecture = self.docker('info', '--format', '{{.Architecture}}')
        platform = {'aarch64': 'linux/arm64', 'arm64': 'linux/arm64', 'x86_64': 'linux/amd64', 'amd64': 'linux/amd64'}.get(architecture)
        require(platform is not None, 'fixture requires arm64 or amd64 Docker')
        self.docker('compose', 'version')
        registry_port, app_port = free_port(), free_port()
        self.docker('run', '-d', '--name', self.registry, '-p', f'127.0.0.1:{registry_port}:5000', 'registry:2', timeout=180)
        source, a, b = self.source()
        namespace = f'127.0.0.1:{registry_port}/fixture'
        bundles = {}
        image_sets = {}
        for sha in [a, b]:
            print(json.dumps({'event': 'fixture.acceptance.publish', 'sha': sha, 'platform': platform}), flush=True)
            image_sets[sha] = self.publish(source, sha, namespace, platform)
            bundles[sha] = self.directory / ('bundle-' + sha)
            build_bundle(source, sha, image_sets[sha], bundles[sha], [a] if sha == b else [], fixture=True)
        project = self.project('compatible', app_port)
        self.deploy(project, a, bundles[a])
        initial = self.snapshot(project)
        require(self.state(project)['successful']['sha'] == a, 'initial success SHA mismatch')
        require(len(self.apps(project)) == 2, 'initial apps unavailable')
        self.checkpoint('initial deployment')
        ids = set(self.apps(project))
        before = self.state(project)
        self.docker('stop', self.registry)
        try:
            self.deploy(project, b, bundles[b], success=False)
            require(self.state(project) == before and set(self.apps(project)) == ids, 'pull failure changed running apps or success state')
        finally:
            self.docker('start', self.registry)
        self.checkpoint('pull failure retains old apps')
        self.configure(project, app_port, FIXTURE_FAIL='1')
        self.deploy(project, b, bundles[b], success=False)
        require(not self.apps(project), 'failed migration started target apps')
        require(self.state(project)['successful']['sha'] == a, 'failed migration changed successful SHA')
        require(self.snapshot(project)['task'] == initial['task'], 'failed migration lost task marker')
        self.checkpoint('migration failure blocks target apps')
        self.configure(project, app_port)
        self.deploy(project, b, bundles[b])
        require(self.state(project)['successful']['sha'] == b and self.state(project)['previous']['sha'] == a, 'upgrade lost previous success')
        self.checkpoint('existing version upgrade')
        self.configure(project, app_port, FIXTURE_OLD_SHA=a)
        output = self.deploy(project, b, bundles[b], success=False)
        require(a in output and b in output and '--rollback' in output, 'health failure omitted observed SHA/rollback instruction')
        require(self.state(project)['successful']['sha'] == b, 'old SHA readiness changed success record')
        self.checkpoint('old SHA health preserves successful release')
        self.configure(project, app_port)
        before = self.snapshot(project)
        volume = json.loads(self.docker('volume', 'inspect', self.registry + '-compatible_state'))
        network = self.docker('network', 'inspect', '--format', '{{.Id}}', self.registry + '-compatible_data')
        self.deploy(project, a, rollback=True)
        require(self.state(project)['successful']['sha'] == a and self.snapshot(project) == before, 'rollback ran migration or lost markers')
        require(json.loads(self.docker('volume', 'inspect', self.registry + '-compatible_state')) == volume, 'rollback replaced persistent volume')
        require(self.docker('network', 'inspect', '--format', '{{.Id}}', self.registry + '-compatible_data') == network,
                'rollback tore down Compose network')
        self.checkpoint('compatible rollback preserves volume and markers')
        # 相同源码与镜像，独立project验证缺少显式兼容声明的拒绝，不篡改已导入bundle。
        incompatible_bundle = self.directory / 'bundle-incompatible'
        build_bundle(source, b, image_sets[b], incompatible_bundle, fixture=True)
        other_port = free_port()
        other = self.project('incompatible', other_port)
        self.deploy(other, a, bundles[a])
        self.configure(other, other_port, FIXTURE_OLD_SHA=a)
        self.deploy(other, b, incompatible_bundle, success=False)
        before_state, before_markers, before_ids = self.state(other), self.snapshot(other), set(self.apps(other))
        output = self.deploy(other, a, rollback=True, success=False)
        require('NEW empty volume' in output and 'never run down migration' in output, 'incompatibility omitted recovery instruction')
        require(self.state(other) == before_state and self.snapshot(other) == before_markers and set(self.apps(other)) == before_ids,
                'incompatible rollback mutated stack')
        self.checkpoint('incompatible rollback rejected before mutation')
        self.configure(project, app_port, FIXTURE_DELAY='4')
        previous_events = len(self.snapshot(project)['migrations'].splitlines())
        logs = [tempfile.TemporaryFile() for _ in range(2)]
        try:
            first = subprocess.Popen(self.deployment(project, a, bundles[a]), env=self.env, stdout=logs[0], stderr=subprocess.STDOUT)
            self.processes.append(first)
            deadline = time.monotonic() + 40
            while len(self.snapshot(project)['migrations'].splitlines()) == previous_events and first.poll() is None and time.monotonic() < deadline:
                time.sleep(0.2)
            require(first.poll() is None and len(self.snapshot(project)['migrations'].splitlines()) == previous_events + 1,
                    'first concurrent deploy did not reach migration')
            second = subprocess.Popen(self.deployment(project, b, bundles[b]), env=self.env, stdout=logs[1], stderr=subprocess.STDOUT)
            self.processes.append(second)
            time.sleep(0.5)
            require(second.poll() is None and logs[1].seek(0, 2) == 0, 'second deploy entered pull while first held lock')
            require(first.wait(timeout=180) == 0 and second.wait(timeout=180) == 0, 'concurrent deployment failed')
            events = [json.loads(line) for line in self.snapshot(project)['migrations'].splitlines()[previous_events:]]
            require([(event['stage'], event['version']) for event in events] == [('start', a), ('complete', a), ('start', b), ('complete', b)],
                    'concurrent migrations overlapped or ran out of order')
            require(self.state(project)['successful']['sha'] == b, 'serialized deployment final SHA mismatch')
        finally:
            for log in logs:
                log.close()
        self.checkpoint('concurrent publications serialized')
        print(json.dumps({'event': 'fixture.acceptance.completed', 'platforms': [platform],
                          'businessPgDbosHeartbeat': 'not verified', 'tlsRebootSsh': 'not verified'}), flush=True)

    def cleanup(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
        # 只按自己创建的project标签清理；从未运行生产栈down或全局prune。
        for directory in self.projects:
            project = self.registry + '-' + directory.name
            ids = subprocess.run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project],
                                 env=self.env, capture_output=True, timeout=20).stdout.decode().split()
            if ids:
                subprocess.run(['docker', 'rm', '-f', *ids], env=self.env, capture_output=True, timeout=30)
            for kind in ['volume', 'network']:
                ids = subprocess.run(['docker', kind, 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + project],
                                     env=self.env, capture_output=True, timeout=20).stdout.decode().split()
                if ids:
                    subprocess.run(['docker', kind, 'rm', *ids], env=self.env, capture_output=True, timeout=30)
        subprocess.run(['docker', 'rm', '-fv', self.registry], env=self.env, capture_output=True, timeout=30)
        if self.images:
            subprocess.run(['docker', 'image', 'rm', '-f', *set(self.images)], env=self.env, capture_output=True, timeout=60)


def main():
    with tempfile.TemporaryDirectory(prefix='selfhost-deploy-acceptance-') as directory:
        acceptance = Acceptance(Path(directory).resolve())
        try:
            acceptance.execute()
        except (Failure, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            reason = str(error) if isinstance(error, Failure) else type(error).__name__ + '; details withheld'
            print(json.dumps({'event': 'fixture.acceptance.failed', 'reason': reason}), file=sys.stderr)
            return 1
        finally:
            acceptance.cleanup()
    return 0


if __name__ == '__main__':
    sys.exit(main())
