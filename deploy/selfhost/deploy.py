#!/usr/bin/env python3
"""只消费可信 release bundle 的串行部署入口。"""
import argparse
import fcntl
import json
import ipaddress
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid

sys.dont_write_bytecode = True

from health import SHA, public_probe, wait_health
from release.bundle import image_env, verify_bundle


class DeploymentError(Exception):
    pass


def run(args, *, env=None, cwd=None, timeout=180, input=None):
    try:
        result = subprocess.run(args, env=env, cwd=cwd, input=input,
                                capture_output=True, timeout=timeout)
        if result.returncode:
            raise DeploymentError('command failed; raw output withheld')
        return result.stdout.decode()
    except (OSError, subprocess.SubprocessError, UnicodeError) as error:
        raise DeploymentError('command unavailable or timed out; raw output withheld') from error


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


class Compose:
    def __init__(self, directory, bundle, release, files, env_files, runtime=None):
        self.directory = directory
        self.bundle = bundle
        self.release = release
        self.env = {key: value for key, value in os.environ.items() if key in
                    ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
                     'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']}
        if runtime:
            self.env.update(runtime)
        self.env.update(image_env(release))
        self.args = ['docker', 'compose', '--project-directory', str(directory)]
        for name in env_files:
            if not re.fullmatch(r'\.env(?:\.[a-z-]+)?', name) or name.endswith('.example'):
                raise DeploymentError('invalid runtime env filename')
            path = directory / name
            if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o077:
                raise DeploymentError('runtime env must be a regular file with mode 0600')
            self.args += ['--env-file', str(path)]
        for name in files:
            if name not in release['files'] or not re.fullmatch(r'compose(?:\.[a-z0-9-]+)?\.yaml', name):
                raise DeploymentError('Compose file must belong to the verified bundle')
            self.args += ['-f', str(bundle / name)]
        self.config = json.loads(self('config', '--format', 'json'))
        rendered_env = self('config', '--environment')
        public_keys = set(re.findall(r'^([A-Z_][A-Z_0-9]*)=', (bundle / '.env.example').read_text(), re.M))
        public_keys.update(['EXTERNAL_INGRESS_NETWORK', 'BACKUP_CA_FILE', 'BACKUP_S3_REGION',
                            'BACKUP_S3_FORCE_PATH_STYLE', 'BACKUP_UTC_TIME', 'BACKUP_DAILY_DAYS',
                            'BACKUP_WEEKLY_WEEKS', 'BACKUP_WEEKLY_DAY', 'BACKUP_MIN_FREE_BYTES',
                            'BACKUP_RETRY_SECONDS', 'BACKUP_ARCHIVE_TIMEOUT_SECONDS',
                            'BACKUP_DISK_RATE_LIMIT', 'BACKUP_NETWORK_RATE_LIMIT', 'S3_REGION'])
        public_keys.difference_update(image_env(release))
        self.runtime = {key: value for line in rendered_env.splitlines() if '=' in line
                        for key, value in [line.split('=', 1)] if key in public_keys}
        profiles = set(next((line.split('=', 1)[1] for line in rendered_env.splitlines()
                             if line.startswith('COMPOSE_PROFILES=')), '').split(','))
        if '*' in profiles or 'disabled-caddy' in profiles:
            raise DeploymentError('wildcard/disabled proxy profile is not a deployment plan')
        services = {name: service for name, service in self.config['services'].items()
                    if not service.get('profiles') or profiles.intersection(service['profiles'])}
        self.config['services'] = services
        references = set(release['images'].values())
        for name, service in services.items():
            if service.get('build') or service.get('image') not in references:
                raise DeploymentError('Compose requires a matching release image for every service')
            if not service.get('user') or service['user'].split(':')[0] in ['root', '0']:
                raise DeploymentError('Compose requires non-root services')
            if name != 'caddy' and service.get('ports'):
                raise DeploymentError('only the built-in proxy may publish ports')
        if any(name not in services for name in ['postgres', 'valkey', 'migrate', 'web', 'jobs']):
            raise DeploymentError('required Compose services missing')
        if 'compose.proxy.yaml' in files:
            for cidr in services['web']['environment']['TRUSTED_PROXY_CIDRS'].split(','):
                try:
                    network = ipaddress.ip_network(cidr.strip(), strict=True)
                except ValueError as error:
                    raise DeploymentError('external proxy requires exact trusted addresses') from error
                if network.prefixlen != network.max_prefixlen:
                    raise DeploymentError('external proxy requires /32 or /128 trusted addresses')
            if not self.config['networks']['ingress'].get('external'):
                raise DeploymentError('external ingress must remain an external network')
        for name in ['postgres', 'valkey', 'migrate', 'jobs']:
            allowed = {'data', 'ingress'} if name == 'jobs' and 'object-storage-init' in services else {'data'}
            if set(services[name].get('networks', {})) != allowed:
                raise DeploymentError('data services may not join an external proxy network')
        self.project = self.config['name']

    def __call__(self, *args, timeout=180):
        return run(self.args + list(args), env=self.env, cwd=self.directory, timeout=timeout)

    def jobs_probe(self, timeout):
        # 响应只走管道，输出仅允许完整SHA，不打印连接串或任意响应字段。
        script = "fetch('http://127.0.0.1:3001/internal/ready',{signal:AbortSignal.timeout(Number(process.argv[1]))}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()}))).catch(()=>process.exit(1))"
        try:
            return json.loads(self('exec', '-T', 'jobs', 'node', '-e', script,
                                   str(max(1, int(timeout * 800))), timeout=timeout))
        except DeploymentError:
            return {}

    def stop_apps(self):
        ids = self('ps', '-a', '-q', 'web', 'jobs').split()
        self('stop', '--timeout', '45', 'web', 'jobs', timeout=110)
        if ids:
            for container in ids:
                state = json.loads(run(['docker', 'inspect', '--format', '{{json .State}}', container], env=self.env))
                if state.get('Running') or state.get('ExitCode') == 137:
                    raise DeploymentError('old app did not drain safely; inspect shutdown before continuing')


def import_bundle(directory, source, sha, fixture):
    release = verify_bundle(source, sha, allow_fixture=fixture)
    destination = directory / 'releases' / sha
    if destination.exists():
        if verify_bundle(destination, sha, allow_fixture=fixture) != release:
            raise DeploymentError('immutable release directory differs from supplied bundle')
    else:
        if shutil.disk_usage(directory).free < 512 * 1024 * 1024:
            raise DeploymentError('insufficient disk headroom for release material')
        temporary = Path(tempfile.mkdtemp(prefix='.incoming-', dir=directory / 'releases'))
        try:
            shutil.copytree(source, temporary, dirs_exist_ok=True)
            verify_bundle(temporary, sha, allow_fixture=fixture)
            temporary.rename(destination)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    return destination, release


def local(args):
    raw_directory = Path(args.dir)
    directory = raw_directory.resolve()
    if (not raw_directory.is_absolute() or not directory.is_dir() or directory == Path('/')
            or any(path.is_symlink() for path in [raw_directory, *raw_directory.parents])
            or directory.stat().st_mode & 0o077):
        raise DeploymentError('explicit existing deployment directory required')
    os.umask(0o077)
    for name in ['release-state', 'releases']:
        (directory / name).mkdir(exist_ok=True, mode=0o700)
        if (directory / name).is_symlink():
            raise DeploymentError('release paths cannot be symlinks')
    state_file = directory / 'release-state/state.json'
    with (directory / 'release-state/deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(state_file.read_text()) if state_file.exists() else {}
        target = args.rollback or args.sha
        if not SHA.fullmatch(target or ''):
            raise DeploymentError('full lowercase 40-character SHA required')
        if args.rollback:
            if args.bundle or target not in [state.get('successful', {}).get('sha'), state.get('previous', {}).get('sha')]:
                raise DeploymentError('rollback requires a recorded successful bundle')
            bundle = directory / 'releases' / target
            release = verify_bundle(bundle, target, allow_fixture=args.fixture)
            source_sha = state.get('schemaSha') or state.get('attempted', state.get('successful', {})).get('sha')
            if source_sha != target:
                source = verify_bundle(directory / 'releases' / source_sha, source_sha, allow_fixture=args.fixture)
                if target not in source['rollbackCompatibleWith']:
                    raise DeploymentError('rollback incompatible or unreviewed: restore a matching PG17 backup into a NEW empty volume; validate schema/DBOS handlers and task version before cutover; never run down migration')
            plan = next(value for value in [state.get('successful'), state.get('previous')] if value and value['sha'] == target)
        else:
            if not args.bundle:
                raise DeploymentError('--bundle required for deployment')
            bundle, release = import_bundle(directory, Path(args.bundle), target, args.fixture)
            plan = {'sha': target, 'files': ['compose.yaml', *args.compose_file], 'envFiles': ['.env', *args.env_file]}
        compose = Compose(directory, bundle, release, plan['files'], plan['envFiles'],
                          runtime=plan.get('runtime') if args.rollback else None)
        if not args.rollback:
            plan['runtime'] = compose.runtime
        if state.get('project') and state['project'] != compose.project:
            raise DeploymentError('Compose project changed; refusing to switch persistent volumes')
        if not state:
            ids = compose('ps', '-a', '-q').strip()
            if ids:
                raise DeploymentError('unmanaged existing stack; review and import state before deployment')
        # 拉取失败不改变运行服务/成功记录。迁移前记attempted，失败也不能假定DB未变化。
        if shutil.disk_usage(directory).free < 2 * 1024 * 1024 * 1024:
            raise DeploymentError('deployment filesystem requires at least 2 GiB free headroom')
        print(json.dumps({'event': 'selfhost.deploy.pull', 'target': target}), flush=True)
        compose('pull', timeout=900)
        for name, service in compose.config['services'].items():
            image = json.loads(run(['docker', 'image', 'inspect', service['image']], env=compose.env))[0]
            if image['Config'].get('Labels', {}).get('org.opencontainers.image.revision') != target:
                raise DeploymentError('pulled image revision does not match release SHA')
        prior = state.get('attempted', state.get('successful'))
        if prior:
            prior_bundle = directory / 'releases' / prior['sha']
            prior_release = verify_bundle(prior_bundle, prior['sha'], allow_fixture=args.fixture)
            Compose(directory, prior_bundle, prior_release, prior['files'], prior['envFiles'],
                    runtime=prior.get('runtime')).stop_apps()
        else:
            compose.stop_apps()
        state.update({'project': compose.project, 'attempted': plan})
        atomic_json(state_file, state)
        compose('up', '-d', '--wait', '--wait-timeout', '120', 'postgres', 'valkey', timeout=150)
        if not args.rollback:
            # 迁移即使失败也可能改变schema；应用回滚不会把这个记录倒退。
            state['schemaSha'] = target
            atomic_json(state_file, state)
            # 强制新容器运行目标迁移，不复用上次 exited(0)；失败不会启动目标 app。
            compose('rm', '-f', 'migrate')
            compose('up', '--force-recreate', '--no-deps', '--abort-on-container-exit',
                    '--exit-code-from', 'migrate', 'migrate', timeout=300)
        if 'object-storage-init' in compose.config['services']:
            compose('up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'object-storage', timeout=150)
            compose('rm', '-f', 'object-storage-init')
            compose('up', '--force-recreate', '--no-deps', '--abort-on-container-exit',
                    '--exit-code-from', 'object-storage-init', 'object-storage-init', timeout=180)
        # 所有一次性gate成功才启动app；回滚不执行旧迁移、不down、不删除卷。
        compose('up', '-d', '--no-deps', 'web', 'jobs', timeout=120)
        extras = [name for name in compose.config['services'] if name not in
                  ['postgres', 'valkey', 'migrate', 'web', 'jobs', 'object-storage', 'object-storage-init']]
        if extras:
            compose('up', '-d', '--no-deps', *extras)
        url = compose.config['services']['web']['environment']['APP_URL'].rstrip('/') + '/api/health'
        # SSH 的登录环境可能携带代理；探活与 Compose 共用经过筛选的环境，避免观察错误入口。
        if not wait_health(target, lambda timeout: public_probe(url, timeout, env=compose.env), compose.jobs_probe, timeout=args.health_timeout):
            raise DeploymentError('web/jobs readiness or full SHA check failed')
        previous = state.get('successful')
        if previous and previous['sha'] != target:
            state['previous'] = previous
        state['successful'] = plan
        atomic_json(state_file, state)
        print(json.dumps({'event': 'selfhost.deploy.completed', 'target': target}), flush=True)


def remote(args):
    if args.fixture:
        raise DeploymentError('fixture bundles are restricted to --local')
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@-]*', args.host or ''):
        raise DeploymentError('explicit SSH host or user@host required')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', args.dir) or '..' in Path(args.dir).parts:
        raise DeploymentError('SSH deployment directory requires a safe absolute path')
    ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', args.host]
    command = [args.dir + '/releases/' + (args.rollback or args.sha or '') + '/deploy.sh',
               '--local', '--dir', args.dir, '--health-timeout', str(args.health_timeout)]
    if args.rollback:
        command += ['--rollback', args.rollback]
    else:
        if not args.bundle:
            raise DeploymentError('--bundle required for deployment')
        verify_bundle(Path(args.bundle), args.sha)
        incoming = args.dir + '/.incoming-' + uuid.uuid4().hex
        run(ssh + [shlex.join(['mkdir', '-m', '700', incoming])])
        try:
            run(['scp', '-q', '-r', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                 str(Path(args.bundle).resolve()) + '/.', args.host + ':' + incoming], timeout=300)
            command[0] = incoming + '/deploy.sh'
            command += ['--sha', args.sha, '--bundle', incoming]
            for name in args.compose_file:
                command += ['--compose-file', name]
            for name in args.env_file:
                command += ['--env-file', name]
            # 遥端只输出脱敏入口事件；认证沿用操作者配置，不忽略host key。
            result = subprocess.run(ssh + [shlex.join(command)], timeout=1800)
            if result.returncode:
                raise DeploymentError('remote deployment failed')
        finally:
            run(ssh + [shlex.join(['rm', '-rf', '--', incoming])])
        return
    result = subprocess.run(ssh + [shlex.join(command)], timeout=1800)
    if result.returncode:
        raise DeploymentError('remote rollback failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--local', action='store_true')
    mode.add_argument('--host')
    parser.add_argument('--dir', required=True)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--sha')
    target.add_argument('--rollback')
    parser.add_argument('--bundle')
    parser.add_argument('--compose-file', action='append', default=[])
    parser.add_argument('--env-file', action='append', default=[])
    parser.add_argument('--health-timeout', type=int, default=360)
    parser.add_argument('--fixture', action='store_true', help='explicit local-only release fixture')
    args = parser.parse_args()
    try:
        if not SHA.fullmatch(args.rollback or args.sha) or not 1 <= args.health_timeout <= 900:
            raise DeploymentError('invalid full SHA or health window')
        local(args) if args.local else remote(args)
    except (DeploymentError, ValueError, TypeError, KeyError, OSError, StopIteration, subprocess.SubprocessError) as error:
        reason = str(error) if isinstance(error, DeploymentError) else 'invalid release, runtime config or state; details withheld'
        print(json.dumps({'event': 'selfhost.deploy.failed', 'target': args.rollback or args.sha, 'reason': reason}), file=sys.stderr)
        try:
            state = json.loads((Path(args.dir) / 'release-state/state.json').read_text()) if args.local else {}
            previous = state.get('successful', {}).get('sha')
            if previous:
                command = ['deploy.sh', '--local', '--dir', args.dir, '--rollback', previous]
                print('Rollback after compatibility review: ' + shlex.join(command), file=sys.stderr)
        except (OSError, ValueError, TypeError):
            pass
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
