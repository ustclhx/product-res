import datetime
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import deploy
import health

A = 'a' * 40
B = 'b' * 40
C = 'c' * 40


def response(sha=A, status=200):
    body = {'status': 'ok', 'version': sha, 'jobs': {'lastCronAt': datetime.datetime.now(datetime.timezone.utc).isoformat()},
            **{name: {'status': 'up'} for name in ['db', 'cache', 'queue', 'scheduler']}}
    return {'status': status, 'body': body}


class HealthTest(unittest.TestCase):
    def test_release_probe_uses_explicit_environment_instead_of_ssh_login_proxy(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(response()['body']).encode())
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.dict(os.environ, {'http_proxy': 'http://127.0.0.1:1', 'no_proxy': '', 'NO_PROXY': ''}):
                probe = health.public_probe(f'http://127.0.0.1:{server.server_port}', 1,
                                            env={'PATH': os.environ['PATH']})
                self.assertTrue(health.ready(probe, A))
        finally:
            server.shutdown()
            server.server_close()

    def test_old_sha_503_and_jobs_mismatch_wait_then_success_without_body_leak(self):
        steps = iter([response(B), response(A, 503), response(A), response(A)])
        jobs = iter([response(A), response(A), response(B), response(A)])
        lines = []
        self.assertTrue(health.wait_health(A, lambda _: next(steps), lambda _: next(jobs),
                                          timeout=1, interval=0.01, write=lines.append))
        self.assertEqual(len(lines), 4)
        self.assertEqual(json.loads(lines[-1])['event'], 'selfhost.health.ready')
        self.assertTrue(all(set(json.loads(line)) == {'event', 'target', 'web', 'jobs'} for line in lines))

    def test_real_http_invalid_half_open_and_wrong_sha_stay_bounded(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == '/hang':
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{"private":"sentinel"')
                    self.wfile.flush()
                    time.sleep(0.4)
                else:
                    self.send_response(200)
                    self.end_headers()
                    body = response(B)['body']
                    body['password'] = 'secret-sentinel'
                    self.wfile.write(json.dumps(body).encode())
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for path in ['/hang', '/old']:
                lines = []
                start = time.monotonic()
                self.assertFalse(health.wait_health(A,
                    lambda timeout: health.public_probe(f'http://127.0.0.1:{server.server_port}{path}', timeout),
                    lambda _: response(A), timeout=0.15, interval=0.01, write=lines.append))
                self.assertLess(time.monotonic() - start, 0.6)
                self.assertNotIn('sentinel', ''.join(lines))
                self.assertNotIn('password', ''.join(lines))
        finally:
            server.shutdown()
            server.server_close()

    def test_all_dependencies_and_fresh_success_heartbeat_required(self):
        for name in ['db', 'cache', 'queue', 'scheduler']:
            value = response()
            value['body'][name]['status'] = 'down'
            self.assertFalse(health.ready(value, A))
        for at in [None, 'invalid', '2020-01-01T00:00:00Z']:
            value = response()
            value['body']['jobs']['lastCronAt'] = at
            self.assertFalse(health.ready(value, A))


class ComposeTest(unittest.TestCase):
    def test_verified_external_s3_plan_accepts_digit_filename_but_rejects_unlisted_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / '.env').write_text('APP_URL=https://product.ezarouter.cc\n')
            (directory / '.env').chmod(0o600)
            (directory / '.env.example').write_text('APP_URL=https://product.ezarouter.cc\n')
            files = ['compose.yaml', 'compose.s3.yaml', 'compose.backup.yaml', 'compose.replica.yaml']
            images = {name: f'registry.example/{name}@sha256:{"a" * 64}'
                      for name in ['postgres', 'valkey', 'migrate', 'web', 'jobs']}
            release = {'images': images, 'files': dict.fromkeys(files)}
            config = {'name': 'isolated', 'services': {
                name: {'image': image, 'user': '1000:1000', 'networks': {'data': {}}}
                for name, image in images.items()}}

            # 保留真实 Compose 计划校验，仅替代外部 CLI 的配置输出；不运行 pull/up。
            with patch.object(deploy, 'run', side_effect=[json.dumps(config), '']) as command:
                compose = deploy.Compose(directory, directory, release, files, ['.env'])
                self.assertEqual(compose.project, 'isolated')
                rendered = command.call_args_list[0].args[0]
                self.assertIn(str(directory / 'compose.s3.yaml'), rendered)

            for name in ['compose.private2.yaml', '../compose.s3.yaml']:
                with self.subTest(name=name), patch.object(deploy, 'run') as command:
                    # 即使出现在清单中，目录穿越仍须拒绝；普通文件仍须属于清单。
                    candidate = {**release, 'files': {**release['files'], '../compose.s3.yaml': None}}
                    with self.assertRaisesRegex(deploy.DeploymentError, 'verified bundle'):
                        deploy.Compose(directory, directory, candidate, ['compose.yaml', name], ['.env'])
                    command.assert_not_called()

    def test_tunnel_and_external_proxy_overlays_are_mutually_exclusive_before_any_command(self):
        files = ['compose.yaml', 'compose.proxy.yaml', 'compose.tunnel.yaml']
        release = {'images': {}, 'files': dict.fromkeys(files)}
        with tempfile.TemporaryDirectory() as temporary, patch.object(deploy, 'run') as command:
            directory = Path(temporary)
            with self.assertRaisesRegex(deploy.DeploymentError, 'mutually exclusive'):
                deploy.Compose(directory, directory, release, files, ['.env'])
            command.assert_not_called()
        deploy.check_overlays(['compose.tunnel.yaml', 'compose.s3.yaml'])
        deploy.check_overlays(['compose.proxy.yaml'])


class TunnelComposeTest(unittest.TestCase):
    """用真实 compose.tunnel.yaml 渲染结构的最小等价物驱动部署门；不运行 pull/up。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        for name in ['.env', '.env.example']:
            (self.directory / name).write_text('APP_URL=https://product.ezarouter.cc\n')
            (self.directory / name).chmod(0o600)
        self.secret = self.directory / 'secrets/cloudflared_tunnel_token'
        self.secret.parent.mkdir(mode=0o700)
        self.secret.write_text('fixture-token-sentinel\n')
        self.secret.chmod(0o600)
        self.files = ['compose.yaml', 'compose.tunnel.yaml']
        names = ['postgres', 'valkey', 'migrate', 'web', 'jobs', 'cloudflared']
        self.images = {name: f'registry.example/{name}@sha256:{"a" * 64}' for name in names}
        self.release = {'images': self.images, 'files': dict.fromkeys(self.files)}
        services = {name: {'image': image, 'user': '1000:1000', 'networks': {'data': {}}}
                    for name, image in self.images.items()}
        services['web']['networks'] = {'data': {}, 'ingress': {'ipv4_address': '172.30.77.3'}}
        services['web']['environment'] = {'APP_URL': 'https://product.ezarouter.cc',
                                          'TRUSTED_PROXY_CIDRS': '172.30.77.6/32'}
        services['web']['secrets'] = [{'source': 'auth_secret'}]
        services['cloudflared'] = {
            'image': self.images['cloudflared'], 'user': '65532:65532', 'read_only': True,
            'command': ['tunnel', '--no-autoupdate', 'run', '--token-file',
                        '/run/secrets/cloudflared_tunnel_token'],
            'secrets': [{'source': 'cloudflared_tunnel_token',
                         'target': '/run/secrets/cloudflared_tunnel_token'}],
            'networks': {'ingress': {'ipv4_address': '172.30.77.6'}},
        }
        self.config = {'name': 'isolated', 'services': services,
                       'networks': {'data': {}, 'ingress': {}},
                       'secrets': {'cloudflared_tunnel_token': {'file': str(self.secret)}}}

    def compose(self, config=None):
        with patch.object(deploy, 'run', side_effect=[json.dumps(config or self.config), '']):
            return deploy.Compose(self.directory, self.directory, self.release, self.files, ['.env'])

    def test_valid_tunnel_plan_passes_without_reading_the_token(self):
        compose = self.compose()
        self.assertIn('cloudflared', compose.config['services'])
        self.assertNotIn('fixture-token-sentinel', json.dumps(compose.runtime))

    def test_tunnel_plan_rejects_unsafe_topology_before_service_changes(self):
        def mutate(change):
            value = json.loads(json.dumps(self.config))
            change(value)
            return value
        caddy = {'image': self.images['web'], 'user': '10001:10001', 'networks': {'ingress': {}}}
        cases = {
            'disabled built-in proxy': lambda c: c['services'].update(caddy=caddy),
            'ports': lambda c: c['services']['cloudflared'].update(ports=[{'published': '443'}]),
            'only ingress': lambda c: c['services']['cloudflared']['networks'].update(data={}),
            'trust only the cloudflared': lambda c: c['services']['web']['environment'].update(
                TRUSTED_PROXY_CIDRS='172.30.77.0/28'),
            'read-only file secret': lambda c: c['services']['cloudflared']['command'].append('--token=leak'),
            'mounted into cloudflared': lambda c: c['services']['web']['secrets'].append(
                {'source': 'cloudflared_tunnel_token'}),
            'private ingress': lambda c: c['networks']['ingress'].update(external=True),
        }
        for message, change in cases.items():
            with self.subTest(message=message), self.assertRaisesRegex(deploy.DeploymentError, message):
                self.compose(mutate(change))
        environment = mutate(lambda c: c['services']['cloudflared'].update(environment={'TUNNEL_TOKEN': 'x'}))
        with self.assertRaisesRegex(deploy.DeploymentError, 'file secret'):
            self.compose(environment)

    def test_tunnel_token_file_must_exist_be_private_and_non_empty(self):
        self.secret.chmod(0o640)
        with self.assertRaisesRegex(deploy.DeploymentError, 'mode 0600'):
            self.compose()
        self.secret.chmod(0o600)
        self.secret.write_text('')
        with self.assertRaisesRegex(deploy.DeploymentError, 'non-empty'):
            self.compose()
        self.secret.unlink()
        with self.assertRaisesRegex(deploy.DeploymentError, 'missing'):
            self.compose()

    def test_mode_switch_retires_only_the_inactive_ingress_containers_of_this_project(self):
        compose = self.compose()
        calls = []

        def fake_run(args, **_kwargs):
            calls.append(args)
            return 'old-caddy\n' if args[:2] == ['docker', 'ps'] and 'service=caddy' in args[-1] else ''
        with patch.object(deploy, 'run', side_effect=fake_run):
            compose.retire_inactive_ingress()
        self.assertEqual(len([args for args in calls if args[:2] == ['docker', 'ps']]), 1)
        self.assertIn('label=com.docker.compose.project=isolated', calls[0])
        self.assertEqual(calls[1], ['docker', 'stop', '--time', '30', 'old-caddy'])
        self.assertEqual(calls[2], ['docker', 'rm', 'old-caddy'])


class DeployTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name).resolve()
        (self.directory / 'releases').mkdir()
        (self.directory / 'release-state').mkdir()
        self.statefile = self.directory / 'release-state/state.json'
        self.releases = {A: {'sha': A, 'images': {}, 'rollbackCompatibleWith': []},
                         B: {'sha': B, 'images': {}, 'rollbackCompatibleWith': [A]}}
        self.commands = []
        self.failure = None
        self.config = {'services': {name: {'image': name, 'environment': {'APP_URL': 'https://product.ezarouter.cc'}}
                                   for name in ['postgres', 'valkey', 'migrate', 'web', 'jobs']}}
        owner = self
        class FakeCompose:
            def __init__(self, directory, bundle, release, files, env_files, runtime=None):
                self.config = owner.config
                self.project = 'isolated'
                self.env = {}
                self.runtime = {}
            def __call__(self, *args, **kwargs):
                owner.commands.append(args)
                if args[0] == owner.failure or ('--exit-code-from' in args and owner.failure == 'migration'):
                    raise deploy.DeploymentError('command failed; sentinel withheld')
                return ''
            def stop_apps(self):
                owner.commands.append(('drain',))
            def retire_inactive_ingress(self):
                owner.commands.append(('retire',))
            def jobs_probe(self, timeout):
                return response(B)
        self.patches = [patch.object(deploy, 'Compose', FakeCompose),
                        patch.object(deploy, 'verify_bundle', lambda path, sha, **_: self.releases[sha]),
                        patch.object(deploy, 'import_bundle', lambda directory, path, sha, _: (directory / 'releases' / sha, self.releases[sha])),
                        patch.object(deploy, 'run', lambda *_args, **_: json.dumps([{'Config': {'Labels': {'org.opencontainers.image.revision': B}}}])),
                        patch.object(deploy, 'wait_health', return_value=True)]
        for mock in self.patches:
            mock.start()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lambda: [mock.stop() for mock in reversed(self.patches)])
        self.plan = {'sha': A, 'files': ['compose.yaml'], 'envFiles': ['.env']}
        deploy.atomic_json(self.statefile, {'project': 'isolated', 'successful': self.plan, 'attempted': self.plan})
        self.args = SimpleNamespace(dir=str(self.directory), sha=B, rollback=None, bundle=str(self.directory),
                                    fixture=True, compose_file=[], env_file=[], health_timeout=1)

    def test_upgrade_forces_migration_after_drain_and_keeps_previous_success(self):
        deploy.local(self.args)
        self.assertLess(self.commands.index(('pull',)), self.commands.index(('drain',)))
        migrate = next(i for i, command in enumerate(self.commands) if '--exit-code-from' in command)
        start = next(i for i, command in enumerate(self.commands) if command == ('up', '-d', '--no-deps', 'web', 'jobs'))
        self.assertLess(self.commands.index(('drain',)), migrate)
        self.assertLess(migrate, start)
        # 旧入口在新应用启动后、公网健康门之前退役，健康门只能经当前计划的入口通过。
        self.assertLess(start, self.commands.index(('retire',)))
        state = json.loads(self.statefile.read_text())
        self.assertEqual(state['successful']['sha'], B)
        self.assertEqual(state['previous']['sha'], A)

    def test_conflicting_ingress_overlays_fail_before_bundle_import_or_any_command(self):
        before = self.statefile.read_text()
        argv = ['deploy.py', '--local', '--dir', str(self.directory), '--sha', B, '--bundle', str(self.directory),
                '--compose-file', 'compose.tunnel.yaml', '--compose-file', 'compose.proxy.yaml']
        with patch.object(sys, 'argv', argv), patch.object(deploy, 'import_bundle') as imported, \
                patch('sys.stderr'):
            self.assertEqual(deploy.main(), 1)
            imported.assert_not_called()
        self.assertEqual(self.commands, [])
        self.assertEqual(self.statefile.read_text(), before)

    def test_pull_failure_does_not_stop_apps_or_change_success_record(self):
        before = self.statefile.read_text()
        self.failure = 'pull'
        with self.assertRaises(deploy.DeploymentError):
            deploy.local(self.args)
        self.assertNotIn(('drain',), self.commands)
        self.assertEqual(self.statefile.read_text(), before)

    def test_failed_migration_blocks_apps_but_records_possibly_changed_schema(self):
        self.failure = 'migration'
        with self.assertRaises(deploy.DeploymentError):
            deploy.local(self.args)
        self.assertFalse(any(command[:4] == ('up', '-d', '--no-deps', 'web') for command in self.commands))
        state = json.loads(self.statefile.read_text())
        self.assertEqual(state['successful']['sha'], A)
        self.assertEqual(state['attempted']['sha'], B)

    def test_rollback_checks_failed_target_compatibility_before_any_mutation(self):
        deploy.atomic_json(self.statefile, {'project': 'isolated', 'successful': self.plan,
                           'attempted': {**self.plan, 'sha': B}})
        self.releases[B]['rollbackCompatibleWith'] = []
        self.args.rollback = A
        self.args.sha = None
        self.args.bundle = None
        with self.assertRaisesRegex(deploy.DeploymentError, 'NEW empty volume'):
            deploy.local(self.args)
        self.assertEqual(self.commands, [])

    def test_compatible_rollback_never_runs_old_migration_or_removes_volumes(self):
        deploy.atomic_json(self.statefile, {'project': 'isolated', 'successful': self.plan,
                           'attempted': {**self.plan, 'sha': B}})
        self.args.rollback = A
        self.args.sha = None
        self.args.bundle = None
        with patch.object(deploy, 'run', return_value=json.dumps([{'Config': {'Labels': {'org.opencontainers.image.revision': A}}}])):
            deploy.local(self.args)
        self.assertFalse(any('migrate' in command or 'down' in command for command in self.commands))
        # 真实状态会保留最后迁移版本，应用回滚不把schema记录改为旧代码。
        self.assertEqual(json.loads(self.statefile.read_text())['attempted']['sha'], A)


    def test_schema_identity_survives_application_rollback_for_later_compatibility_checks(self):
        self.releases[C] = {'sha': C, 'images': {}, 'rollbackCompatibleWith': []}
        self.releases[A]['rollbackCompatibleWith'] = [C]
        deploy.atomic_json(self.statefile, {'project': 'isolated', 'successful': self.plan,
                           'previous': {**self.plan, 'sha': C}, 'attempted': self.plan, 'schemaSha': B})
        self.args.rollback, self.args.sha, self.args.bundle = C, None, None
        with self.assertRaisesRegex(deploy.DeploymentError, 'NEW empty volume'):
            deploy.local(self.args)
        self.assertEqual(self.commands, [])


if __name__ == '__main__':
    unittest.main()
