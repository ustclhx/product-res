#!/usr/bin/env python3
"""宿主 Docker 编排；恢复永远写新卷，诊断仅含固定码和恢复元数据。"""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import traceback
import uuid


class RestoreError(Exception):
    pass


LABEL = 'selfhost.restore.owner'
ENV_KEYS = {'BACKUP_S3_ENDPOINT', 'BACKUP_S3_REGION', 'BACKUP_S3_PREFIX',
            'BACKUP_S3_FORCE_PATH_STYLE', 'BACKUP_ALLOW_HTTP',
            'BACKUP_DISK_RATE_LIMIT', 'BACKUP_NETWORK_RATE_LIMIT'}


def iso_time(value):
    # WAL-G的Go时间可能有九位小数；宿主Python3.9只支持固定微秒，统一精度后再解析。
    value = re.sub(r'\.(\d{1,9})(?=Z|[+-])',
                   lambda match: '.' + match.group(1)[:6].ljust(6, '0'), value)
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))


def utc(value):
    try:
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)', value):
            raise ValueError
        parsed = iso_time(value)
        if parsed.year < 2000:
            raise ValueError
        return parsed.isoformat().replace('+00:00', 'Z')
    except (ValueError, TypeError):
        raise RestoreError('RESTORE_INVALID_UTC') from None


def run(args, input=None, timeout=120, optional=False):
    try:
        result = subprocess.run(args, input=input, capture_output=True, text=True,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise RestoreError('RESTORE_DOCKER_FAILED') from None
    if result.returncode and not optional:
        raise RestoreError('RESTORE_DOCKER_FAILED')
    return result


def file_path(value):
    path = Path(value).absolute()
    if (path.is_symlink() or not path.is_file()
            or any(c in str(path) for c in ',\n\r$')):
        raise RestoreError('RESTORE_INVALID_FILE')
    return path.resolve()


def env_file(path):
    values = {}
    for line in file_path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or key not in ENV_KEYS or key in values or any(c in value for c in '\0\r\n$'):
            raise RestoreError('RESTORE_INVALID_S3_ENV')
        values[key] = value
    if not {'BACKUP_S3_ENDPOINT', 'BACKUP_S3_REGION', 'BACKUP_S3_PREFIX'} <= values.keys():
        raise RestoreError('RESTORE_INVALID_S3_ENV')
    # 复用现有 TLS/endpoint 校验；只构造环境，不读取密钥内容到宿主日志。
    from urllib.parse import urlsplit
    try:
        endpoint = urlsplit(values['BACKUP_S3_ENDPOINT'])
        if (endpoint.scheme not in ('https', 'http') or not endpoint.hostname or endpoint.username
                or endpoint.password or endpoint.query or endpoint.fragment or endpoint.path not in ('', '/')
                or any(ord(c) < 32 for c in values['BACKUP_S3_ENDPOINT'])):
            raise ValueError
        if endpoint.scheme == 'http' and values.get('BACKUP_ALLOW_HTTP') != 'true':
            raise ValueError
        if not re.fullmatch(r's3://[a-z0-9][a-z0-9.-]+/[A-Za-z0-9_./-]+', values['BACKUP_S3_PREFIX']):
            raise ValueError
        if any(p in ('.', '..') for p in values['BACKUP_S3_PREFIX'][5:].split('/')):
            raise ValueError
        if not re.fullmatch(r'[A-Za-z0-9-]+', values['BACKUP_S3_REGION']):
            raise ValueError
        if values.get('BACKUP_S3_FORCE_PATH_STYLE', 'true') not in ('true', 'false'):
            raise ValueError
    except ValueError:
        raise RestoreError('RESTORE_INVALID_S3_ENV') from None
    return values


def checks_file(path):
    if not path:
        return {'creditsEnabled': True, 'checks': []}
    try:
        data = json.loads(file_path(path).read_text())
        if type(data.get('creditsEnabled')) is not bool or not isinstance(data.get('checks'), list):
            raise ValueError
        for check in data['checks']:
            if (not re.fullmatch(r'[a-z][a-z0-9_.-]{0,63}', check['name'])
                    or not isinstance(check['sql'], str) or len(check['sql']) > 65536
                    or not re.match(r'^\s*(SELECT|WITH)\b', check['sql'], re.I)
                    or ';' in check['sql'] or '\\' in check['sql']):
                raise ValueError
        return data
    except (ValueError, TypeError, KeyError):
        raise RestoreError('RESTORE_INVALID_CHECKS') from None


def compose(state, *args, input=None, timeout=120, optional=False):
    return run(['docker', 'compose', '--project-name', state['project'], '-f',
                str(Path(state['directory']) / 'compose.json'), *args],
               input=input, timeout=timeout, optional=optional)


def sql(state, query, readonly=True):
    # SQL 经 stdin，不出现在命令行和日志；仅接受 t/f 或固定恢复位置元数据。
    statement = ('BEGIN READ ONLY;\n' + query + ';\nCOMMIT;\n') if readonly else query + ';\n'
    return compose(state, 'exec', '-T', 'postgres', 'psql', '-X', '-w', '-qAt',
                   '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', state['database'],
                   input=statement, timeout=20).stdout.strip()


def save(state):
    path = Path(state['directory']) / 'state.json'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, indent=2) + '\n')
    os.replace(temporary, path)


def report(state):
    data = {key: state.get(key) for key in ['project', 'backupId', 'targetTime', 'clusterId',
            'pgMajor', 'actualReplayTime', 'replayLsn', 'elapsedSeconds', 'checks',
            'status', 'phase', 'error', 'errorType', 'errorLine', 'cleaned']}
    (Path(state['directory']) / 'report.json').write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps(data))


def validate(state):
    if sql(state, 'SELECT pg_is_in_recovery() AND pg_is_wal_replay_paused()') != 't':
        raise RestoreError('RESTORE_NOT_PAUSED')
    builtins = [
        {'name': 'pg17', 'sql': "SELECT current_setting('server_version_num')::int BETWEEN 170000 AND 179999"},
        {'name': 'schemas', 'sql': "SELECT count(*)=3 FROM pg_namespace WHERE nspname IN ('public','job_engine','dbos')"},
        {'name': 'business_tables', 'sql': "SELECT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public')"},
        {'name': 'engine_tables', 'sql': "SELECT count(DISTINCT schemaname)=2 FROM pg_tables WHERE schemaname IN ('job_engine','dbos')"},
        {'name': 'constraints', 'sql': 'SELECT NOT EXISTS(SELECT 1 FROM pg_constraint WHERE NOT convalidated)'},
        {'name': 'roles', 'sql': "SELECT count(*)=3 AND bool_and(rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) FROM pg_roles WHERE rolname IN ('app','migrator','readonly')"},
        {'name': 'role_permissions', 'sql': "SELECT has_schema_privilege('migrator','public','CREATE') AND NOT has_schema_privilege('app','public','CREATE') AND NOT has_schema_privilege('readonly','public','CREATE') AND has_database_privilege('app',current_database(),'CONNECT') AND NOT has_database_privilege('app',current_database(),'CREATE') AND NOT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND (NOT has_table_privilege('readonly',schemaname||'.'||quote_ident(tablename),'SELECT') OR has_table_privilege('readonly',schemaname||'.'||quote_ident(tablename),'INSERT,UPDATE,DELETE,TRUNCATE')))"},
    ]
    config = state['validation']
    if config['creditsEnabled']:
        # 与 reconcileWorkspaceCredits 相同不变量：包括尚未过期处理的全部 active remaining。
        builtins.append({'name': 'credits_balance', 'sql': """SELECT NOT EXISTS (
          SELECT 1 FROM (SELECT workspace_id FROM credit_ledger UNION SELECT workspace_id FROM credit_grant
            UNION SELECT workspace_id FROM credit_hold UNION SELECT workspace_id FROM credit_debt) w
          WHERE (SELECT coalesce(sum(delta),0) FROM credit_ledger WHERE workspace_id=w.workspace_id)
            <> (SELECT coalesce(sum(remaining),0) FROM credit_grant WHERE workspace_id=w.workspace_id AND status='active')
             + (SELECT coalesce(sum(amount),0) FROM credit_hold WHERE workspace_id=w.workspace_id AND status='held')
             - (SELECT coalesce(sum(amount),0) FROM credit_debt WHERE workspace_id=w.workspace_id))"""})
    state['checks'] = []
    for check in builtins + config['checks']:
        ok = sql(state, check['sql']) == 't'
        state['checks'].append({'name': check['name'], 'ok': ok})
        save(state)
        if not ok:
            raise RestoreError('RESTORE_CHECK_FAILED')
    point = json.loads(sql(state, "SELECT json_build_object('at',pg_last_xact_replay_timestamp(),'lsn',pg_last_wal_replay_lsn()::text,'cluster',system_identifier::text) FROM pg_control_system()"))
    if point['cluster'] != state['clusterId']:
        raise RestoreError('RESTORE_CLUSTER_MISMATCH')
    if (point['at'] and iso_time(point['at']) > iso_time(state['targetTime'])):
        raise RestoreError('RESTORE_POINT_AFTER_TARGET')
    state.update(actualReplayTime=point['at'], replayLsn=point['lsn'], status='validated_paused')
    save(state)


def restore(args):
    target = utc(args.target_time)
    # PG恢复参数使用其配置时间解析器支持的空格与显式UTC偏移，报告仍保留ISO UTC。
    recovery_target = dt.datetime.fromisoformat(target.replace('Z', '+00:00')).isoformat(sep=' ')
    if (not re.fullmatch(r'base_[0-9A-F]{24}', args.backup_id)
            or int(args.backup_id[5:13], 16) == 0):
        raise RestoreError('RESTORE_INVALID_BACKUP_ID')
    if not re.fullmatch(r'selfhost-restore-[a-z0-9][a-z0-9-]{1,70}', args.project):
        raise RestoreError('RESTORE_INVALID_PROJECT')
    if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./:@-]*', args.image)
            or '@' in args.image and not re.search(r'@sha256:[0-9a-f]{64}$', args.image)):
        raise RestoreError('RESTORE_INVALID_IMAGE')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', args.database) or not 1 <= args.timeout <= 86400:
        raise RestoreError('RESTORE_INVALID_ARGUMENT')
    directory = Path(args.state_dir).absolute()
    if (directory.is_symlink() or directory.exists() or not directory.parent.is_dir()
            or directory.parent.resolve() != directory.parent or any(c in str(directory) for c in '\r\n$')):
        raise RestoreError('RESTORE_STATE_PATH_NOT_NEW')
    env = env_file(args.s3_env)
    mounts = []
    for source, name in [(args.access_key_file, 'access-key'), (args.secret_key_file, 'secret-key'), (args.ca_file, 'ca')]:
        mounts.append({'type': 'bind', 'source': str(file_path(source)), 'target': '/run/restore/' + name, 'read_only': True})
    validation = checks_file(args.checks_file)
    if args.command == 'drill' and not validation['checks']:
        raise RestoreError('RESTORE_DRILL_MARKER_CHECK_REQUIRED')
    volume = args.project + '-pgdata'
    if run(['docker', 'volume', 'inspect', volume], optional=True).returncode == 0:
        raise RestoreError('RESTORE_VOLUME_EXISTS')
    if run(['docker', 'container', 'inspect', args.project + '-postgres'], optional=True).returncode == 0:
        raise RestoreError('RESTORE_PROJECT_EXISTS')
    if args.network:
        try:
            networks = json.loads(run(['docker', 'network', 'inspect', args.network]).stdout)
            if len(networks) != 1 or networks[0].get('Internal') is not True:
                raise ValueError
        except ValueError:
            raise RestoreError('RESTORE_NETWORK_NOT_INTERNAL') from None
    owner = uuid.uuid4().hex
    directory.mkdir(mode=0o700)
    # 创建之后立即持锁，check/promote/cleanup均不能干预正在执行的恢复。
    operation_lock = (directory / 'operation.lock').open('a')
    fcntl.flock(operation_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    state = {'directory': str(directory), 'project': args.project, 'volume': volume, 'owner': owner,
             'database': args.database, 'backupId': args.backup_id, 'targetTime': target,
             'validation': validation, 'status': 'preparing', 'pgMajor': 17,
             'ownNetwork': not bool(args.network)}
    save(state)
    env.update(BACKUP_S3_ACCESS_KEY_ID_FILE='/run/restore/access-key',
               BACKUP_S3_SECRET_ACCESS_KEY_FILE='/run/restore/secret-key',
               BACKUP_S3_CA_FILE='/run/restore/ca', POSTGRES_DB=args.database)
    service = {'image': args.image, 'pull_policy': 'never', 'user': '999:999',
               'container_name': args.project + '-postgres', 'environment': env,
               'labels': {LABEL: owner}, 'volumes': [*mounts,
                   {'type': 'volume', 'source': 'pgdata', 'target': '/var/lib/postgresql/data'},
                   {'type': 'bind', 'source': str(directory / 'postgresql.conf'), 'target': '/run/restore/postgresql.conf', 'read_only': True}],
               'entrypoint': ['postgres'], 'command': ['-D', '/var/lib/postgresql/data', '-c', 'config_file=/run/restore/postgresql.conf'],
               'networks': ['recovery'], 'mem_limit': '512m', 'cpus': 0.5, 'restart': 'no',
               'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '2'}}}
    document = {'services': {'postgres': service}, 'volumes': {'pgdata': {'name': volume, 'labels': {LABEL: owner}}},
                'networks': {'recovery': {'external': True, 'name': args.network} if args.network else {'labels': {LABEL: owner}}}}
    (directory / 'compose.json').write_text(json.dumps(document))
    # 容器只需读取无敏感值配置；state和SQL仍保存在0700父目录，不挂载整个目录。
    conf = directory / 'postgresql.conf'
    conf.write_text("listen_addresses = ''\nport = 5432\nhba_file = '/etc/postgresql/pg_hba.conf'\n"
                    "unix_socket_directories = '/var/run/postgresql'\nssl = off\narchive_mode = off\narchive_command = ''\n"
                    "hot_standby = on\nshared_buffers = '128MB'\nmax_connections = 20\ntimezone = 'UTC'\n"
                    "log_statement = 'none'\nlog_min_error_statement = 'panic'\n"
                    "restore_command = 'selfhost-walg wal-fetch %f %p'\n"
                    f"recovery_target_time = '{recovery_target}'\nrecovery_target_action = 'pause'\n"
                    f"recovery_target_timeline = '{int(args.backup_id[5:13], 16)}'\nrecovery_target_inclusive = true\n")
    conf.chmod(0o444)
    started = time.monotonic()
    try:
        state['phase'] = 'volume'
        # Docker原子创建返回既有卷时不改label；并发同名恢复必须在任何写入前拒绝。
        run(['docker', 'volume', 'create', '--label', f'{LABEL}={owner}', volume])
        if not owned(state, 'volume', volume):
            raise RestoreError('RESTORE_RESOURCE_NOT_OWNED')
        version = compose(state, 'run', '--rm', '--no-deps', '--entrypoint', 'postgres', 'postgres', '--version').stdout
        if not re.search(r'PostgreSQL\) 17\.', version):
            raise RestoreError('RESTORE_REQUIRES_PG17')
        if not owned(state, 'volume', volume):
            raise RestoreError('RESTORE_RESOURCE_NOT_OWNED')
        state['phase'] = 'inventory'
        inventory = json.loads(compose(state, 'run', '--rm', '--no-deps', '--entrypoint', 'selfhost-walg',
                                      'postgres', 'backup-list', '--detail', '--json').stdout)
        bases = [item for item in inventory if item.get('backup_name') == args.backup_id]
        if len(bases) != 1:
            raise RestoreError('RESTORE_BACKUP_NOT_FOUND')
        base = bases[0]
        state['phase'] = 'base-metadata'
        if (base.get('wal_file_name') != args.backup_id[5:]
                or type(base.get('system_identifier')) is not int or base['system_identifier'] <= 0
                or base.get('storage_name', 'default') != 'default'):
            raise RestoreError('RESTORE_INVALID_BASE_METADATA')
        finish = iso_time(base['finish_time'])
        start = iso_time(base['start_time'])
        if not finish.tzinfo or not start.tzinfo or start > finish:
            raise RestoreError('RESTORE_INVALID_BASE_METADATA')
        if finish > dt.datetime.fromisoformat(target.replace('Z', '+00:00')):
            raise RestoreError('RESTORE_BASE_AFTER_TARGET')
        state['clusterId'] = str(bases[0]['system_identifier'])
        state['phase'] = 'base-fetch'
        save(state)
        compose(state, 'run', '--rm', '--no-deps', '--entrypoint', 'python3', 'postgres', '-c',
                "from pathlib import Path; assert not any(Path('/var/lib/postgresql/data').iterdir())")
        compose(state, 'run', '--rm', '--no-deps', '--entrypoint', 'selfhost-walg', 'postgres',
                'backup-fetch', '/var/lib/postgresql/data', args.backup_id, timeout=args.timeout)
        # hot standby必须不低于源集群的共享内存相关参数，不能按演练预算减连接数。
        control = compose(state, 'run', '--rm', '--no-deps', '--entrypoint', 'pg_controldata',
                          'postgres', '/var/lib/postgresql/data').stdout
        settings = {'max_connections setting': 'max_connections',
                    'max_worker_processes setting': 'max_worker_processes',
                    'max_wal_senders setting': 'max_wal_senders',
                    'max_prepared_xacts setting': 'max_prepared_transactions',
                    'max_locks_per_xact setting': 'max_locks_per_transaction'}
        source_settings = []
        state['phase'] = 'source-settings'
        for label, setting in settings.items():
            match = re.search(r'^' + re.escape(label) + r':\s+(\d+)\s*$', control, re.M)
            if not match:
                raise RestoreError('RESTORE_SOURCE_SETTINGS_INVALID')
            source_settings.append(f'{setting} = {int(match.group(1))}\n')
        conf.chmod(0o600)
        with conf.open('a') as stream:
            stream.writelines(source_settings)
        conf.chmod(0o444)
        prepare = "from pathlib import Path; p=Path('/var/lib/postgresql/data'); assert (p/'PG_VERSION').read_text().strip()=='17'; (p/'postgresql.auto.conf').write_text(''); (p/'standby.signal').unlink(missing_ok=True); (p/'recovery.signal').touch()"
        state['phase'] = 'prepare-recovery'
        compose(state, 'run', '--rm', '--no-deps', '--entrypoint', 'python3', 'postgres', '-c', prepare)
        compose(state, 'up', '-d', '--no-deps', 'postgres')
        state['phase'] = 'replay'
        deadline = time.monotonic() + args.timeout
        while True:
            running = run(['docker', 'inspect', '--format', '{{.State.Running}}', args.project + '-postgres']).stdout.strip()
            if running != 'true':
                diagnostic = run(['docker', 'logs', '--tail', '40', args.project + '-postgres'], optional=True)
                text = diagnostic.stdout + diagnostic.stderr
                # 固定分类使文件权限/启动配置错误可诊断，不输出路径或原始PG日志。
                if 'Permission denied' in text:
                    raise RestoreError('RESTORE_FILE_PERMISSION_DENIED')
                if 'syntax error' in text or 'unrecognized configuration parameter' in text:
                    raise RestoreError('RESTORE_CONFIG_INVALID')
                if 'could not create lock file' in text:
                    raise RestoreError('RESTORE_SOCKET_NOT_WRITABLE')
                if 'data directory' in text and 'invalid permissions' in text:
                    raise RestoreError('RESTORE_DATA_PERMISSIONS_INVALID')
                if 'recovery ended before configured recovery target was reached' in text:
                    raise RestoreError('RESTORE_CHAIN_OR_TARGET_INSUFFICIENT')
                if 'hot standby is not possible' in text:
                    raise RestoreError('RESTORE_SOURCE_SETTINGS_MISMATCH')
                raise RestoreError('RESTORE_RECOVERY_FAILED')
            try:
                if sql(state, 'SELECT pg_is_in_recovery() AND pg_is_wal_replay_paused()') == 't':
                    break
            except RestoreError:
                pass
            if time.monotonic() >= deadline:
                raise RestoreError('RESTORE_TARGET_NOT_REACHED')
            time.sleep(1)
        validate(state)
        state['phase'] = 'validated'
        state['elapsedSeconds'] = round(time.monotonic() - started, 3)
        if args.command == 'drill':
            cleanup(state)
        save(state)
        report(state)
        operation_lock.close()
    except Exception as error:
        state['errorType'] = type(error).__name__
        state['errorLine'] = traceback.extract_tb(error.__traceback__)[-1].lineno
        state.update(status='failed', error=str(error) if isinstance(error, RestoreError) else 'RESTORE_RECOVERY_FAILED',
                     elapsedSeconds=round(time.monotonic() - started, 3))
        save(state)
        report(state)
        operation_lock.close()
        raise RestoreError(state['error']) from None


def owned(state, kind, name):
    result = run(['docker', kind, 'inspect', name], optional=True)
    if result.returncode:
        return False
    data = json.loads(result.stdout)[0]
    labels = data.get('Config', {}).get('Labels', {}) if kind == 'container' else data.get('Labels', {})
    if (labels or {}).get(LABEL) != state['owner']:
        raise RestoreError('RESTORE_RESOURCE_NOT_OWNED')
    return True


def cleanup(state):
    name = state['project'] + '-postgres'
    if owned(state, 'container', name):
        run(['docker', 'rm', '-f', name])
    if owned(state, 'volume', state['volume']):
        run(['docker', 'volume', 'rm', state['volume']])
    network = state['project'] + '_recovery'
    if state['ownNetwork'] and owned(state, 'network', network):
        run(['docker', 'network', 'rm', network])
    state['cleaned'] = True


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['restore', 'drill', 'check', 'promote', 'cleanup'])
    parser.add_argument('--state-dir', required=True)
    for name in ['s3-env', 'access-key-file', 'secret-key-file', 'ca-file', 'image', 'backup-id', 'target-time', 'project', 'network', 'checks-file']:
        parser.add_argument('--' + name)
    parser.add_argument('--database', default='product_res_production')
    parser.add_argument('--timeout', type=int, default=300)
    args = parser.parse_args()
    if args.command in ('restore', 'drill'):
        if any(not getattr(args, key) for key in ['s3_env', 'access_key_file', 'secret_key_file', 'ca_file', 'image', 'backup_id', 'target_time', 'project']):
            raise RestoreError('RESTORE_MISSING_ARGUMENT')
        restore(args)
    else:
        directory = Path(args.state_dir).absolute()
        if directory.is_symlink() or directory.resolve() != directory or not (directory / 'state.json').is_file():
            raise RestoreError('RESTORE_INVALID_STATE')
        with (directory / 'operation.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            state = json.loads((directory / 'state.json').read_text())
            if state['directory'] != str(directory) or not re.fullmatch(r'selfhost-restore-[a-z0-9][a-z0-9-]{1,70}', state['project']):
                raise RestoreError('RESTORE_INVALID_STATE')
            if args.command == 'cleanup':
                cleanup(state)
            else:
                if not owned(state, 'container', state['project'] + '-postgres'):
                    raise RestoreError('RESTORE_INSTANCE_MISSING')
                validate(state)
                if args.command == 'promote':
                    # 不先resume，避免在promote到达前越过指定恢复点。
                    if sql(state, 'SELECT pg_promote(true, 30)', readonly=False) != 't' or sql(state, 'SELECT NOT pg_is_in_recovery()') != 't':
                        raise RestoreError('RESTORE_PROMOTE_FAILED')
                    state['status'] = 'promoted_isolated'
            save(state)
            report(state)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except RestoreError as error:
        print(json.dumps({'ok': False, 'error': str(error)}), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print(json.dumps({'ok': False, 'error': 'RESTORE_OPERATION_FAILED'}), file=sys.stderr)
        sys.exit(1)
