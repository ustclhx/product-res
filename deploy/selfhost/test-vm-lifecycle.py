#!/usr/bin/env python3
"""隔离 VM 中的未完成任务和退出证明验收；不修改正式 bundle 或 owner JSON。"""
import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('vm_acceptance', Path(__file__).with_name('test-vm.py'))
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', required=True, choices=['prepare', 'after-reboot', 'recreate', 'exit', 'namespace', 'cleanup'])
    parser.add_argument('--directory', type=Path, default=Path('/opt/selfhost-d-vm-harness'))
    parser.add_argument('--bundle', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--patched', action='store_true', help='bind local ownership source patches into the official image')
    mode.add_argument('--official-flock', action='store_true', help='accept the official flock image with private PID namespaces and no source patches')
    parser.add_argument('--expected-sha', help='required full release SHA for --official-flock')
    parser.add_argument('--patch-directory', type=Path, default=Path('/opt/d-vm-input/patch'))
    parser.add_argument('--runtime-evidence', type=Path, default=Path('/opt/d-vm-results/runtime.json'))
    args = parser.parse_args()
    if args.official_flock and (not args.expected_sha or len(args.expected_sha) != 40 or
                              any(c not in '0123456789abcdef' for c in args.expected_sha)):
        parser.error('--official-flock requires --expected-sha with the full lowercase release SHA')
    a = vm.VMAcceptance.resume(args.directory, args.bundle, args.runtime_evidence)
    engine_mode = 'official-flock' if args.official_flock else 'patched' if args.patched else 'original'
    name = a.project + '-' + engine_mode + '-probe'
    identity = 'd-vm-' + engine_mode
    state_path = args.directory / (identity + '.json')
    report_path = args.runtime_evidence.parent / (identity + '-report.json')
    report = json.loads(report_path.read_text()) if report_path.exists() else {
        'scope': 'local source fixture against official migration image' if args.patched else 'official migration image engine; controlled handler fixture',
        'officialSha': a.a, 'engineMode': engine_mode, 'officialCode': not args.patched,
        'patched': args.patched, 'sourcePatchUsed': args.patched,
        'hostPidUsed': not (args.patched or args.official_flock), 'controlledHandlerFixture': True,
        'checks': []}
    volume = name + '-owners'

    def mark(check, **fields):
        report['checks'].append({'check': check, 'passed': True, **fields})
        report_path.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'event': 'vm.lifecycle.check', 'check': check, 'passed': True}), flush=True)

    def rpc(path, container=name):
        script = "fetch('http://127.0.0.1:3101'+process.argv[1],{signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))"
        return json.loads(a.docker('exec', container, 'node', '-e', script, path))

    # 旧正式漏洞复现保留 host PID；正式 flock 验收与补修夹具均不共享宿主 PID。
    def launch(container=name, host_pid=None):
        host_pid = not (args.patched or args.official_flock) if host_pid is None else host_pid
        vm.require(not args.official_flock or not host_pid, 'official flock mode forbids host PID namespace')
        command = ['run', '-d', '--name', container, '--hostname', identity,
            '--user', '1000:1000', '--restart', 'unless-stopped' if container == name else 'no', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges:true', '--network', a.project + '_data',
            '--label', 'com.docker.compose.project=' + a.project + '-probe',
            '--memory', '256m', '--cpus', '0.2', '-e', 'NODE_EXTRA_CA_CERTS=/run/certs/ca.crt',
            '-e', 'JOB_HOST_ID_FILE=/run/job-host/machine-id', '-e', 'PROBE_EXECUTOR_ID=' + identity,
            '-v', str(a.deploy_dir / 'secrets/app_database_url') + ':/run/secrets/app_database_url:ro',
            '-v', str(a.deploy_dir / 'certs/ca.crt') + ':/run/certs/ca.crt:ro',
            '-v', '/etc/machine-id:/run/job-host/machine-id:ro', '-v', volume + ':/owners',
            '-v', str(Path(__file__).with_name('vm-lifecycle.mts')) + ':/src/deploy/selfhost/vm-lifecycle.mts:ro']
        if host_pid:
            command += ['--pid', 'host']
        if args.patched:
            for file in ['job-owner.ts', 'job-engine.ts', 'job-guard.ts']:
                command += ['-v', str(args.patch_directory / file) + ':/src/packages/platform/src/node/' + file + ':ro']
        command += ['--entrypoint', 'node', a.release['images']['migrate'], '--experimental-strip-types', '/src/deploy/selfhost/vm-lifecycle.mts']
        a.docker(*command)
        if args.official_flock:
            verify_official(container)

    def verify_official(container=name):
        item = json.loads(a.docker('inspect', container))[0]
        vm.require(item['HostConfig']['PidMode'] in ['', 'private'], 'official probe does not use a private PID namespace')
        source_mounts = [m['Destination'] for m in item['Mounts'] if m['Destination'].startswith('/src')]
        vm.require(source_mounts == ['/src/deploy/selfhost/vm-lifecycle.mts'], 'official probe has unexpected source mounts')
        vm.require(item['Config']['Image'] == a.release['images']['migrate'], 'official probe image differs from release bundle')

    def wait_ready(container=name):
        return a.wait(lambda: rpc('/ready', container), 'probe did not become ready', timeout=90)

    def waiting(key):
        state = rpc('/status/' + key)
        return state if state['state']['status'] == 'waiting' else None

    def deadline(key):
        encode = lambda text: base64.urlsafe_b64encode(text.encode()).decode().rstrip('=')
        native_id = 'workflow:' + encode(identity + '-v1') + ':' + encode(key)
        return a.sql(a.a, "SELECT json_build_object('deadline',deadline,'state',state) FROM job_engine.workflow_wait WHERE workflow_id='" + native_id + "'")

    def finish(key):
        rpc('/resume/' + key)
        done = a.wait(lambda: (s if (s := rpc('/status/' + key))['state']['status'] == 'completed' else None),
                      'same task did not complete after resume', timeout=60)
        vm.require(done['rows'] == [{'prepared': 1, 'completed': 1}], 'successful callback repeated or output missing')
        return done

    try:
        if args.official_flock:
            vm.require(a.a == args.expected_sha, 'official release SHA differs from expected SHA')
            vm.require(report.get('officialSha') == a.a and report.get('engineMode') == engine_mode,
                       'lifecycle report belongs to a different release or engine mode')
            image = json.loads(a.docker('image', 'inspect', a.release['images']['migrate']))[0]
            vm.require(image['Config']['Labels'].get('org.opencontainers.image.revision') == a.a,
                       'official engine image revision differs from release SHA')
            if args.phase not in ['prepare', 'cleanup']:
                verify_official()
        if args.phase == 'prepare':
            a.run(['docker', 'exec', '-i', a.compose(a.a, 'ps', '-q', 'postgres'), 'psql', '-X', '-U', 'postgres',
                '-d', 'acceptance', '-v', 'ON_ERROR_STOP=1'], input=b'CREATE TABLE IF NOT EXISTS public.d_vm_effect(key text PRIMARY KEY,prepared int NOT NULL,completed int NOT NULL); GRANT SELECT,INSERT,UPDATE ON public.d_vm_effect TO app;\n')
            a.docker('volume', 'create', '--label', 'com.docker.compose.project=' + a.project + '-probe', volume)
            a.docker('run', '--rm', '--user', '0:0', '--entrypoint', 'sh', '-v', volume + ':/owners',
                a.release['images']['jobs'], '-c', 'chown 1000:1000 /owners; chmod 700 /owners')
            launch()
            wait_ready()
            rpc('/start/' + identity)
            a.wait(lambda: waiting(identity), 'probe did not persist its event wait', timeout=60)
            state_path.write_text(json.dumps({'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                'task': identity, 'deadline': deadline(identity), 'before': rpc('/status/' + identity)}) + '\n')
            mark('unfinished task persisted before host reboot', callbackCount=1, originalDeadline=deadline(identity)['deadline'])
        elif args.phase == 'after-reboot':
            before = json.loads(state_path.read_text())
            vm.require(Path('/proc/sys/kernel/random/boot_id').read_text().strip() != before['bootId'], 'real boot did not change')
            wait_ready()
            a.wait(lambda: waiting(identity), 'original wait did not recover', timeout=60)
            vm.require(deadline(identity) == before['deadline'], 'original deadline changed across reboot')
            finish(identity)
            mark('host reboot resumes original task without repeating successful step', taskIdentityPreserved=True,
                originalDeadlinePreserved=True, preparedCallbacks=1, completedCallbacks=1)
        elif args.phase == 'recreate':
            key = identity + '-recreate'
            rpc('/start/' + key)
            a.wait(lambda: waiting(key), 'recreate task did not enter wait', timeout=60)
            before = deadline(key)
            a.docker('stop', '--time', '15', name)
            a.docker('rm', name)
            launch()
            wait_ready()
            a.wait(lambda: waiting(key), 'wait did not recover after container recreate', timeout=60)
            vm.require(deadline(key) == before, 'deadline changed after container recreate')
            finish(key)
            mark('container recreate recovers task with owner history retained', originalDeadlinePreserved=True,
                 successfulCallbacksNotRepeated=True, ownershipVolumePreserved=True)
        elif args.phase in ['exit', 'namespace']:
            closed = rpc('/close')
            vm.require(closed.get('closed') and closed.get('processStillAlive'), 'old executor did not close its engine')
            vm.require(json.loads(a.docker('inspect', name))[0]['State']['Running'], 'old process not live')
            # 单次 SQL 会话退出后释放探测锁；明确证明 DB 锁已释放，不能把它当进程退出证据。
            key = hashlib.sha256(('product-res-job-engine:' + identity).encode()).digest()
            keys = [int.from_bytes(key[offset:offset + 4], 'big', signed=True) for offset in [0, 4]]
            acquired = a.sql(a.a, "SELECT json_build_object('acquired',pg_try_advisory_lock(" +
                             ','.join(str(k) for k in keys) + '))')
            vm.require(acquired['acquired'], 'old executor database advisory lock is still held')
            duplicate = name + '-duplicate'
            launch(duplicate, host_pid=not (args.patched or args.official_flock) and args.phase != 'namespace')
            deadline_at = time.monotonic() + 30
            while time.monotonic() < deadline_at:
                state = json.loads(a.docker('inspect', duplicate))[0]['State']
                if not state['Running']:
                    break
                time.sleep(1)
            vm.require(json.loads(a.docker('inspect', name))[0]['State']['Running'], 'old process exited during duplicate startup')
            if args.phase == 'namespace' and engine_mode == 'original':
                vm.require(state['Running'] and rpc('/ready', duplicate)['ready'],
                           'official unsafe namespace behavior did not reproduce')
                mark('official release unsafe namespace reuse reproduced', oldProcessAlive=True,
                     unsafeReuseObserved=True, acceptanceFailure=True)
            else:
                vm.require(not state['Running'] and state['ExitCode'] != 0, 'live old executor reused after its DB lock closed')
                logs = a.run(['docker', 'logs', duplicate])
                vm.require(b'JOB_ENGINE_EXECUTOR_IN_USE' in logs.stdout + logs.stderr,
                           'duplicate exited without the expected ownership rejection')
                mark('still-live executor rejected after releasing database lock', oldProcessAlive=True,
                     databaseLockReleased=True, differentNamespace=args.phase == 'namespace' or args.official_flock,
                     hostPidUsed=not (args.patched or args.official_flock) and args.phase != 'namespace')
            a.docker('rm', '-f', duplicate)
            a.docker('kill', '--signal', 'KILL', name)
            vm.require(not json.loads(a.docker('inspect', name))[0]['State']['Running'], 'old process has not really exited')
            a.docker('rm', name)
            launch()
            wait_ready()
            mark('same executor starts after verified real exit', ownershipVolumePreserved=True)
        elif args.phase == 'cleanup':
            ids = a.docker('ps', '-aq', '--filter', 'label=com.docker.compose.project=' + a.project + '-probe').split()
            if ids:
                a.docker('rm', '-f', *ids)
            volumes = a.docker('volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + a.project + '-probe').split()
            if volumes:
                a.docker('volume', 'rm', *volumes)
            mark('probe resources cleaned')
        report['passed'] = True
        # passed仅表示测试脚本按预期完成；成功复现正式漏洞不代表生命周期签收通过。
        report['acceptancePassed'] = not any(check.get('acceptanceFailure') for check in report['checks'])
        report_path.write_text(json.dumps(report, indent=2) + '\n')
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, vm.Failure) else type(error).__name__ + '; raw details withheld'
        report.update({'passed': False, 'acceptancePassed': False, 'phase': args.phase, 'reason': reason})
        report_path.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'event': 'vm.lifecycle.failed', 'phase': args.phase, 'reason': reason}), flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
