#!/usr/bin/env python3
"""正式镜像资源复测；从仓库根执行，独占 Colima b-budget（2C/4G），约65分钟。

只使用随机本地测试密钥；异常原文仅驻留内存。拒绝复用已有同名 VM，finally
清除自己创建的容器/卷/临时密钥/VM。不连接业务 API、staging 或真实服务器。
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

SHA = '081305013b022f457c561eecf5828b1959e13908'
ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'docs/runbooks/evidence/selfhost'
PROFILE = 'b-budget'


def command(args, env=None, timeout=120, input=None, check=True):
    result = subprocess.run(args, env=env, capture_output=True, timeout=timeout, input=input)
    if check and result.returncode:
        raise RuntimeError('command failed; raw output withheld')
    return result


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if (Path.home() / '.colima' / PROFILE).exists():
        raise RuntimeError('b-budget profile already exists; refusing to reuse or delete it')
    temporary = Path(tempfile.mkdtemp(prefix='b-budget-', dir=ROOT / 'test-results'))
    replay = ROOT / 'test-results' / ('b-budget-replay-' + str(time.time_ns()))
    replay.mkdir(mode=0o700)
    vm_owned = False
    acceptance = None
    stack = temporary / 'stack.json'
    try:
        vm_owned = True
        command(['colima', 'start', PROFILE, '--cpu', '2', '--memory', '4',
                 '--disk', '30', '--activate=false'], timeout=900)
        vm_owned = True
        bundle = temporary / 'bundle'
        command(['python3', str(ROOT / 'deploy/selfhost/release/bundle.py'), 'build',
                 '--source', str(ROOT), '--sha', SHA, '--image-set',
                 str(OUT / 'd-bundle2-2026-10-14/image-set.json'), '--output', str(bundle)])
        helper = load_module('release_acceptance', ROOT / 'deploy/selfhost/test-release-compose.py')
        acceptance = helper.Acceptance(temporary, bundle, temporary / 'setup.json')
        acceptance.project = PROFILE
        acceptance.domain = 'b-budget.test'
        # macOS bind mounts映射为本地测试文件；外层临时目录0700，secret不提交或输出。
        acceptance.desktop = True
        acceptance.env['DOCKER_HOST'] = 'unix://' + str(Path.home() / '.colima' / PROFILE / 'docker.sock')
        acceptance.env.pop('DOCKER_CONTEXT', None)
        pulls = []
        for service in ['postgres', 'valkey', 'migrate', 'web', 'jobs', 'caddy']:
            started = time.monotonic()
            result = acceptance.run(['docker', 'pull', acceptance.release['images'][service]], timeout=900)
            pulls.append({'service': service, 'image': acceptance.release['images'][service],
                          'exitCode': result.returncode, 'seconds': time.monotonic() - started})
            print(json.dumps({'event': 'pull.completed', 'service': service}), flush=True)
        acceptance.configure()
        acceptance.env.update(acceptance.module.image_env(acceptance.release))
        config = json.loads(acceptance.run(['docker', 'compose', '--project-directory',
            str(acceptance.deploy_dir), '--env-file', str(acceptance.deploy_dir / '.env'),
            '-f', str(bundle / 'compose.yaml'), 'config', '--format', 'json']).stdout)
        config['services']['caddy'].pop('profiles', None)
        config['services']['caddy']['ports'] = [
            {'target': 8080, 'published': '28480', 'host_ip': '127.0.0.1', 'protocol': 'tcp'},
            {'target': 8443, 'published': '28443', 'host_ip': '127.0.0.1', 'protocol': 'tcp'},
        ]
        first = config['services']['jobs']
        first['hostname'] = 'b-budget-jobs-1'
        first['environment']['JOB_EXECUTOR_ID'] = first['hostname']
        second = json.loads(json.dumps(first))
        second['hostname'] = 'b-budget-jobs-2'
        second['environment']['JOB_EXECUTOR_ID'] = second['hostname']
        config['services']['jobs2'] = second

        def save():
            stack.write_text(json.dumps(config, indent=2))
            stack.chmod(0o600)

        def compose(*args, **kwargs):
            return acceptance.run(['docker', 'compose', '-f', str(stack), *args], **kwargs)

        def sql(query, database='acceptance'):
            return compose('exec', '-T', 'postgres', 'psql', '-X', '-U', 'postgres', '-d',
                           database, '-At', '-v', 'ON_ERROR_STOP=1', input=query.encode()).stdout.decode().strip()

        save()
        compose('up', '-d', timeout=400)
        sql('CREATE DATABASE b_budget_probe OWNER migrator')
        sql('\\i /usr/local/share/selfhost/02-db-grants.sql', 'b_budget_probe')
        secret_dir = acceptance.deploy_dir / 'secrets'
        for name in ['app_database_url', 'migrator_database_url']:
            value = (secret_dir / name).read_text().replace('/acceptance?', '/b_budget_probe?')
            target = secret_dir / ('probe_' + name)
            target.write_text(value)
            target.chmod(0o644)
            config['secrets']['probe_' + name] = {'file': str(target)}
        probe_migrate = json.loads(json.dumps(config['services']['migrate']))
        probe_migrate['secrets'] = [{'source': 'probe_migrator_database_url', 'target': 'migrator_database_url'}]
        config['services']['probe-migrate'] = probe_migrate
        for name, mode in [('probe-fixture', 'migrator'), ('probe-produce', 'produce'),
                           ('probe-worker-a', 'worker'), ('probe-worker-b', 'worker'),
                           ('probe-retention', 'retention')]:
            service = json.loads(json.dumps(config['services']['migrate']))
            service.update({'hostname': name, 'mem_limit': '512m', 'cpus': '0.3', 'restart': 'no'})
            service.pop('healthcheck', None)
            owner = 'probe-worker-a' if mode == 'produce' else name
            service['hostname'] = owner
            service['environment'].update({'DATABASE_URL_FILE': '/run/secrets/app_database_url',
                'PROBE_EXECUTOR_ID': owner, 'PROBE_OWNERSHIP_DIRECTORY': '/app/.data/job-owners'})
            service['secrets'] = [{'source': 'probe_app_database_url', 'target': 'app_database_url'},
                                 {'source': 'probe_migrator_database_url', 'target': 'migrator_database_url'}]
            service['volumes'].extend([
                {'type': 'bind', 'source': str(OUT / 'b-1.9-probe.mjs'),
                 'target': '/tmp/b-1.9-probe.mjs', 'read_only': True},
                {'type': 'volume', 'source': 'job_owners', 'target': '/app/.data/job-owners'},
            ])
            service['command'] = ['node', '--experimental-strip-types', '/tmp/b-1.9-probe.mjs', mode]
            config['services'][name] = service
        save()
        # 提供无凭据的control API给采样器；state仅包含endpoint/路径和公开env。
        (temporary / 'env-state.json').write_text(json.dumps({'env': acceptance.env, 'directory': str(acceptance.deploy_dir), 'domain': acceptance.domain}))
        control = '''import json,pathlib,subprocess
runtime=pathlib.Path(__file__).resolve().parent
state=json.loads((runtime/'env-state.json').read_text())
def run(args,input=None,timeout=120,check=True):
 r=subprocess.run(args,env=state['env'],capture_output=True,input=input,timeout=timeout)
 if check and r.returncode:raise RuntimeError('command failed; raw output withheld')
 return r
def compose(*args,**kwargs):return run(['docker','compose','-f',str(runtime/'stack.json'),*args],**kwargs)
def sql(query,role='postgres',database='acceptance'):
 return compose('exec','-T','postgres','psql','-X','-U','postgres','-d',database,'-At','-v','ON_ERROR_STOP=1',input=(('SET ROLE '+role+';' if role!='postgres' else '')+query).encode()).stdout.decode().strip()
'''
        (temporary / 'control.py').write_text(control)
        print(json.dumps({'event': 'runtime.ready', 'directory': str(temporary)}), flush=True)
        shutil.copyfile(OUT / 'b-1.9-sampler.py', temporary / 'sample.py')
        sys.path.insert(0, str(temporary))
        sampler = load_module('budget_sampler', temporary / 'sample.py')
        sampler.out = replay / 'resources.jsonl'
        sampler.sample('dual-jobs-idle')
        compose('run', '--rm', '--no-deps', 'probe-migrate', timeout=180)
        compose('run', '--rm', '--no-deps', 'probe-fixture', timeout=60)
        compose('run', '--rm', '--no-deps', 'probe-produce', timeout=60)
        compose('up', '-d', '--no-deps', 'probe-worker-a', 'probe-worker-b')
        started = time.monotonic()
        restarted = False
        while time.monotonic() - started < 3900:
            pause = temporary / 'sampling-paused'
            acknowledgement = temporary / 'sampling-pause-ack'
            if pause.exists():
                acknowledgement.write_text('paused\n')
                deadline = time.monotonic() + 180
                while pause.exists():
                    if time.monotonic() > deadline:
                        raise RuntimeError('optional profile transition exceeded pause deadline')
                    time.sleep(1)
                acknowledgement.unlink(missing_ok=True)
            status = json.loads(sql("SELECT json_build_object('pending',(SELECT count(*) FROM job_engine.message WHERE state<>'acked'),'success',(SELECT count(*) FROM dbos.workflow_status WHERE status='SUCCESS' AND workflow_uuid LIKE 'workflow:%'))", 'b_budget_probe'))
            sampler.sample('dual-jobs-backlog' if status['pending'] else 'dual-jobs-long-run')
            if not restarted and time.monotonic() - started > 600:
                compose('stop', '-t', '2', 'probe-worker-a', 'probe-worker-b')
                sampler.sample('dual-jobs-idle-after-drain')
                compose('stop', '-t', '35', 'jobs2')
                sampler.sample('single-jobs-idle')
                if not (temporary / 'all-profiles.json').exists():
                    config = json.loads(stack.read_text())
                    caps = {'postgres': ('1g', '0.5'), 'valkey': ('256m', '0.1'),
                            'web': ('768m', '0.4'), 'jobs': ('512m', '0.3'),
                            'jobs2': ('512m', '0.3'), 'caddy': ('128m', '0.1')}
                    for service, (mem, cpu) in caps.items():
                        config['services'][service]['mem_limit'] = mem
                        config['services'][service]['cpus'] = cpu
                    save()
                    compose('up', '-d', '--no-deps', 'postgres', 'valkey', 'web',
                            'jobs', 'jobs2', 'caddy', timeout=180)
                compose('up', '-d', '--no-deps', 'jobs2', 'probe-worker-a', 'probe-worker-b')
                restarted = True
            if status['success']:
                additional = (temporary / 'all-profiles.json').exists()
                result = compose('run', '--rm', '--no-deps', '-e', 'PROBE_REQUIRE_COMPLETE=1',
                                 '-e', 'PROBE_EXPECTED_MESSAGES=' + ('180' if additional else '90'),
                                 'probe-retention', timeout=90)
                records = [json.loads(line) for line in result.stdout.decode().splitlines()
                           if line.startswith('{') and '"event":"probe.' in line]
                (replay / 'completion.json').write_text(json.dumps(records, indent=2) + '\n')
                if (temporary / 'all-profiles.json').exists():
                    shutil.copyfile(temporary / 'all-profiles.json', replay / 'all-profiles.json')
                break
            time.sleep(30 if status['pending'] else 60)
        else:
            raise RuntimeError('long workflow timeout')
    finally:
        if acceptance and stack.exists():
            acceptance.run(['docker', 'compose', '-f', str(stack), 'down', '--volumes',
                            '--remove-orphans'], timeout=180, check=False)
        shutil.rmtree(temporary, ignore_errors=True)
        if vm_owned:
            command(['colima', 'delete', PROFILE, '--force'], timeout=180)


if __name__ == '__main__':
    (ROOT / 'test-results').mkdir(exist_ok=True)
    main()
