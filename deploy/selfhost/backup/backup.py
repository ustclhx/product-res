#!/usr/bin/env python3
"""PG17 同 UID 运维入口；状态只记录恢复元数据，不保存连接串或业务正文。"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from walg import BackupError, invoke
from retention import RetentionError

UTC = dt.timezone.utc
STATE = Path(os.environ.get('BACKUP_STATE_DIR', '/var/lib/selfhost-backup'))
TMP = Path(os.environ.get('BACKUP_TMP_DIR', str(STATE / 'tmp')))
PGDATA = Path(os.environ.get('PGDATA', '/var/lib/postgresql/data'))


def now():
    return dt.datetime.now(UTC)


def stamp(value=None):
    return (value or now()).isoformat().replace('+00:00', 'Z')


def number(name, default, minimum=1):
    value = os.environ.get(name, str(default))
    if not value.isdigit() or int(value) < minimum:
        raise BackupError('BACKUP_INVALID_' + name)
    return int(value)


def replica_max_age():
    interval = number('BACKUP_REPLICA_INTERVAL_SECONDS', 300)
    threshold = number('BACKUP_REPLICA_MAX_AGE_SECONDS', 3600)
    if threshold < 3 * interval:
        raise BackupError('BACKUP_REPLICA_MAX_AGE_TOO_SHORT')
    return threshold


def error_code(error):
    if isinstance(error, BackupError) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,95}', str(error)):
        return str(error)
    return 'BACKUP_RETENTION_FAILED' if isinstance(error, RetentionError) else 'BACKUP_OPERATION_FAILED'


def load(name='state.json'):
    path = STATE / name
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (ValueError, OSError):
        raise BackupError('BACKUP_STATE_INVALID') from None


def save(state):
    # 全部管理操作持有同一文件锁；rename 保证 crash 时只留下完整状态。
    fd, path = tempfile.mkstemp(prefix='.state-', dir=STATE)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(state, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(path, STATE / 'state.json')
        directory = os.open(STATE, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(path).unlink(missing_ok=True)


def command(args, timeout=120):
    # 本地 peer 运维权限只属于 UID999；不继承任何 URL/密码或 psqlrc。
    env = {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
           'PGHOST': '/var/run/postgresql', 'PGUSER': 'postgres',
           'PGDATABASE': os.environ.get('POSTGRES_DB', 'product_res_production'),
           'PGCONNECT_TIMEOUT': '10', 'PGAPPNAME': 'selfhost-backup', 'TZ': 'UTC'}
    try:
        result = subprocess.run(args, env=env, capture_output=True, timeout=timeout, check=False)
        if result.returncode != 0:
            raise BackupError('BACKUP_PG_OPERATION_FAILED')
        return result.stdout.decode()
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise BackupError('BACKUP_PG_OPERATION_FAILED') from None


def query(sql):
    return command(['psql', '-X', '-w', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]).strip()


def pg_info():
    info = json.loads(query("SELECT json_build_object('clusterId', system_identifier::text, "
                            "'version', current_setting('server_version_num')::int) FROM pg_control_system()"))
    if not 170000 <= info['version'] < 180000:
        raise BackupError('BACKUP_REQUIRES_PG17')
    return info


def operation(name, fn):
    if name == 'replica':
        # 内核锁只证明当前刷新仍在执行；SIGKILL/crash 后自动释放，不能留下乐观成功。
        with locked('replica.lock'):
            return _operation(name, fn)
    return _operation(name, fn)


def _operation(name, fn):
    state = load()
    previous = state.get(name, {})
    started = time.monotonic()
    # ok 只表示本次复制已提交并校验完成，进程被强杀也必须保持 false。
    state[name] = {**previous, 'ok': False, 'lastAttempt': stamp(), 'running': True}
    if name == 'replica':
        state[name]['refreshFromSuccess'] = previous.get('ok') is True
    save(state)
    try:
        metadata = fn()
    except Exception as error:
        # 中断也不能留下 ok=true；成功标记只在远程提交及校验完成之后写入。
        state = load()
        state[name] = {**state[name], 'running': False, 'ok': False,
                       'failures': previous.get('failures', 0) + 1,
                       'consecutiveFailures': previous.get('consecutiveFailures', 0) + 1,
                       'lastFailure': stamp(),
                       'lastError': error_code(error)}
        state[name].pop('refreshFromSuccess', None)
        save(state)
        event('operation.failed', False, code=error_code(error), operation=name)
        raise
    state = load()
    state[name] = {**state[name], **metadata, 'ok': True, 'running': False,
                   'lastSuccess': stamp(), 'consecutiveFailures': 0,
                   'lastDurationSeconds': round(time.monotonic() - started, 3),
                   'failures': previous.get('failures', 0)}
    state[name].pop('lastError', None)
    state[name].pop('refreshFromSuccess', None)
    save(state)
    return state[name]


def bases():
    data = json.loads(invoke(['backup-list', '--detail', '--json']))
    if not isinstance(data, list):
        raise BackupError('BACKUP_LIST_INVALID')
    return data


def base(sync_replica=True):
    def perform():
        info = pg_info()
        prior = {item['backup_name'] for item in bases()}
        invoke(['backup-push', str(PGDATA), '--full', '--add-user-data',
                json.dumps({'clusterId': info['clusterId'], 'pgMajor': 17})],
               timeout=number('BACKUP_BASE_TIMEOUT_SECONDS', 1800))
        created = [item for item in bases() if item['backup_name'] not in prior]
        if len(created) != 1:
            raise BackupError('BACKUP_BASE_COMMIT_INVALID')
        return {'backupId': created[0]['backup_name'], 'clusterId': info['clusterId']}
    result = operation('base', perform)
    if sync_replica and replica_enabled():
        verify()
        replica_sync()
    return result


def dump(sync_replica=True):
    def perform():
        info = pg_info()
        TMP.mkdir(mode=0o700, parents=True, exist_ok=True)
        database_bytes = int(query('SELECT pg_database_size(current_database())'))
        reserve = number('BACKUP_MIN_FREE_BYTES', 128 * 1024 * 1024)
        if shutil.disk_usage(TMP).free < database_bytes + reserve:
            raise BackupError('BACKUP_DUMP_NO_SPACE')
        prefix = 'logical/' + now().strftime('%Y%m%dT%H%M%S%fZ')
        # 文件仅 UID999 可读；失败/正常退出清理，crash 遗留由下一次持锁操作清理。
        with tempfile.TemporaryDirectory(prefix='dump-', dir=TMP) as directory:
            path = Path(directory)
            command(['pg_dump', '-w', '--create', '--format=custom', '--file', str(path / 'database.dump')],
                    timeout=number('BACKUP_DUMP_TIMEOUT_SECONDS', 1800))
            command(['pg_restore', '--list', str(path / 'database.dump')])
            roles = command(['pg_dumpall', '-w', '--roles-only'])
            # 空 PG 已有 bootstrap postgres，保留 ALTER/授权但不重复 CREATE。
            roles = re.sub(r'^CREATE ROLE postgres;\n', '', roles, flags=re.M)
            (path / 'roles.sql').write_text(roles)
            records = []
            for name in ['database.dump', 'roles.sql']:
                local = path / name
                with local.open('rb') as stream:
                    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                invoke(['st', 'put', str(local), prefix + '/' + name], timeout=1800)
                records.append({'name': name, 'bytes': local.stat().st_size, 'sha256': digest})
            manifest = {'clusterId': info['clusterId'], 'pgMajor': 17,
                        'database': os.environ.get('POSTGRES_DB', 'product_res_production'),
                        'createdAt': stamp(), 'objects': records}
            (path / 'manifest.json').write_text(json.dumps(manifest))
            # 最后上传完成标记；部分失败对象不可作为成功 dump 消费。
            invoke(['st', 'put', str(path / 'manifest.json'), prefix + '/manifest.json', '--no-compress'])
        return {'prefix': prefix, 'clusterId': info['clusterId'], 'databaseBytes': database_bytes}
    result = operation('dump', perform)
    if sync_replica and replica_enabled():
        verify()
        replica_sync()
    return result


def archive_stats():
    return json.loads(query("SELECT row_to_json(a) FROM pg_stat_archiver a"))


def verify():
    def perform():
        state = load()
        if not state.get('base', {}).get('ok'):
            raise BackupError('BACKUP_NEW_BASE_REQUIRED')
        # 先写一个可界定的上界，再切段；不能用 wall clock 冒充已归档恢复点。
        marker = {'at': query('SELECT clock_timestamp()')}
        # 产生不含业务正文的事务性 WAL 消息并提交；提交时间晚于采样点，
        # 既避免空段不切换，也使 recovery_target_time 确有后继提交可命中。
        marker['wal'] = query("SELECT pg_walfile_name(pg_logical_emit_message(true, "
                              "'selfhost-backup', 'verification'))")
        query('SELECT pg_switch_wal()')
        deadline = time.monotonic() + number('BACKUP_ARCHIVE_WAIT_SECONDS', 180)
        while True:
            stats = archive_stats()
            if stats.get('last_archived_wal') and stats['last_archived_wal'] >= marker['wal']:
                break
            if time.monotonic() >= deadline:
                raise BackupError('BACKUP_ARCHIVE_TIMEOUT')
            time.sleep(1)
        # retention模块解析固定版本 JSON；WARNING 不是通过。
        from retention import integrity_proof
        from retention import plan
        inventory = plan(bases(), now(), number('BACKUP_DAILY_DAYS', 7),
                         number('BACKUP_WEEKLY_WEEKS', 4), number('BACKUP_WEEKLY_DAY', 0, 0))
        integrity_proof(invoke, inventory['oldest'], marker['wal'])
        return {'verifiedAt': stamp(), 'continuousUntil': marker['at'], 'lastWal': marker['wal']}
    return operation('verification', perform)


def replica_enabled():
    from replica import enabled
    return enabled()


def replica_sync():
    from replica import sync
    from retention import plan
    state = load()
    state['replica'] = {**state.get('replica', {}), 'configured': True}
    save(state)
    def perform():
        if not replica_enabled():
            raise BackupError('REPLICA_NOT_CONFIGURED')
        inventory = plan(bases(), now(), number('BACKUP_DAILY_DAYS', 7),
                         number('BACKUP_WEEKLY_WEEKS', 4), number('BACKUP_WEEKLY_DAY', 0, 0))
        verification = load().get('verification', {})
        verified_at = dt.datetime.fromisoformat(verification.get('verifiedAt', '').replace('Z', '+00:00'))
        if not 0 <= (now() - verified_at).total_seconds() <= 900:
            raise BackupError('REPLICA_SOURCE_PROOF_STALE')
        return sync(inventory, verification, TMP)
    return operation('replica', perform)


def retention(dry_run=True):
    from retention import plan, execute
    state = load()
    cfg = {'daily_days': number('BACKUP_DAILY_DAYS', 7),
           'weekly_weeks': number('BACKUP_WEEKLY_WEEKS', 4),
           'weekly_day': number('BACKUP_WEEKLY_DAY', 0, 0)}
    result = plan(bases(), now(), **cfg)
    proof = {'clusterId': pg_info()['clusterId'],
             'timeline': int(query('SELECT timeline_id FROM pg_control_checkpoint()')),
             'base': state.get('base', {}), 'archive': state.get('verification', {}),
             'replica': {**state.get('replica', {}), 'configured': replica_enabled()}}
    outcome = execute(invoke, result, proof, now(), dry_run=dry_run)
    if not dry_run:
        state['retention'] = {**outcome, 'lastSuccess': stamp(), 'ok': True}
        save(state)
    return {**result, 'execution': outcome}


def cycle():
    base(sync_replica=False)
    dump(sync_replica=False)
    verify()
    if replica_enabled():
        replica_sync()
    result = retention(dry_run=False)
    return result


def tree_bytes(directory):
    total = 0
    for root, _, files in os.walk(directory):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except FileNotFoundError:
                continue
    return total


def replica_refresh_active():
    try:
        stream = (STATE / 'replica.lock').open('r')
    except FileNotFoundError:
        return False
    with stream:
        try:
            # 多个健康读取共用共享锁，只有复制持有的排他锁才表示刷新仍活跃。
            fcntl.flock(stream, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
    return False


def status():
    state = load()
    archive = load('archive.json')
    try:
        stats = archive_stats()
        disk = {'freeBytes': shutil.disk_usage(PGDATA).free,
                'walBytes': tree_bytes(PGDATA / 'pg_wal'), 'pgDataBytes': tree_bytes(PGDATA)}
        pg_ok = True
    except BackupError:
        stats, disk, pg_ok = {}, {}, False
    result = {**state, 'archive': archive, 'pgStatArchiver': stats, 'disk': disk,
              'replica': {**state.get('replica', {'ok': False}), 'configured': replica_enabled()},
              'checkedAt': stamp()}
    threshold = number('BACKUP_MAX_AGE_SECONDS', 90000)
    recent = True
    for name in ['base', 'dump', 'verification']:
        entry = state.get(name, {})
        value = entry.get('lastSuccess')
        recent = recent and bool(entry.get('ok') and value and
                                (now() - dt.datetime.fromisoformat(value.replace('Z', '+00:00'))).total_seconds() <= threshold)
    replica = result['replica']
    if replica['configured']:
        max_age = replica_max_age()
        replica['maxAgeSeconds'] = max_age
        value = replica.get('lastSuccess')
        # 健康可使用活跃刷新之前的有效证明，但状态 ok 与删除门禁仍只认本次成功。
        refreshing = (replica.get('running') and replica.get('refreshFromSuccess') and
                      replica_refresh_active())
        recent = recent and bool((replica.get('ok') or refreshing) and value and
            0 <= (now() - dt.datetime.fromisoformat(value.replace('Z', '+00:00'))).total_seconds() <=
            max_age)
        if replica.get('continuousUntil'):
            replica['currentLagSeconds'] = (now() - dt.datetime.fromisoformat(
                replica['continuousUntil'].replace('Z', '+00:00'))).total_seconds()
    result['healthy'] = bool(pg_ok and recent and archive.get('lastSuccess') and
                             archive.get('consecutiveFailures', 0) == 0 and
                             stats.get('last_archived_time') and
                             not (stats.get('last_failed_time') and
                                  dt.datetime.fromisoformat(stats['last_failed_time']) >
                                  dt.datetime.fromisoformat(stats['last_archived_time'])))
    return result


def schedule():
    if replica_enabled():
        replica_max_age()
    clock = os.environ.get('BACKUP_UTC_TIME', '02:00')
    if not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', clock):
        raise BackupError('BACKUP_INVALID_UTC_TIME')
    hours, minutes = map(int, clock.split(':'))
    retry = number('BACKUP_RETRY_SECONDS', 300)
    stopping = False
    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    last_attempt = 0.0
    replica_attempt = 0.0
    while not stopping:
        current = now()
        due = current.replace(hour=hours, minute=minutes, second=0, microsecond=0)
        if current < due:
            due -= dt.timedelta(days=1)
        slot = stamp(due)
        if load().get('schedule', {}).get('slot') != slot and time.monotonic() - last_attempt >= retry:
            last_attempt = time.monotonic()
            try:
                with locked():
                    # 两个调度入口与手动 cycle 共享持久锁和 slot；重启可补跑失败周期。
                    if load().get('schedule', {}).get('slot') != slot:
                        for old in TMP.glob('dump-*'):
                            if old.is_dir() and not old.is_symlink():
                                shutil.rmtree(old)
                        cycle()
                        state = load()
                        state['schedule'] = {'slot': slot, 'lastSuccess': stamp(), 'ok': True}
                        save(state)
                        event('cycle.completed')
            except Exception as error:
                with locked():
                    state = load()
                    prior = state.get('schedule', {})
                    state['schedule'] = {**prior, 'ok': False, 'lastFailure': stamp(),
                                         'failures': prior.get('failures', 0) + 1}
                    save(state)
                event('cycle.failed', False, code=error_code(error))
        if replica_enabled() and time.monotonic() - replica_attempt >= number('BACKUP_REPLICA_INTERVAL_SECONDS', 300):
            replica_attempt = time.monotonic()
            previous_failures = load().get('replica', {}).get('failures', 0)
            try:
                with locked():
                    # verify产生已封口WAL时间边界；复制与每日周期共锁，PG归档仍独立。
                    verify()
                    replica_sync()
                event('replica.completed')
            except Exception as error:
                with locked():
                    state = load()
                    prior = state.get('replica', {})
                    state['replica'] = {**prior, 'configured': True, 'ok': False,
                                        'lastFailure': stamp(),
                                        'lastError': error_code(error),
                                        'failures': max(prior.get('failures', 0), previous_failures + 1)}
                    save(state)
                event('replica.failed', False, code=error_code(error))
        # 小步等待使停止及时；持久 slot 不依赖容器内 cron 内存状态。
        for _ in range(30):
            if stopping:
                break
            time.sleep(1)


class locked:
    def __init__(self, name='operation.lock'):
        self.name = name
    def __enter__(self):
        STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.stream = (STATE / self.name).open('a')
        fcntl.flock(self.stream, fcntl.LOCK_EX)
        return self
    def __exit__(self, *_):
        self.stream.close()


def event(name, ok=True, **metadata):
    print(json.dumps({'event': 'selfhost.backup.' + name, 'ok': ok,
                      'level': 'info' if ok else 'error', **metadata}), flush=True)


def main():
    os.umask(0o077)
    if os.getuid() != 999:
        raise BackupError('BACKUP_REQUIRES_UID999')
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['base', 'dump', 'verify', 'cycle', 'status',
                                           'health', 'schedule', 'replica-sync', 'retention-plan', 'retention-apply'])
    args = parser.parse_args()
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.command == 'schedule':
        # 同卷只允许一个长期调度器；另外所有管理写共享 operation.lock。
        with (STATE / 'scheduler.lock').open('a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            schedule()
    elif args.command in ['status', 'health']:
        report = status()
        if args.command == 'status':
            print(json.dumps(report))
        elif not report['healthy']:
            return 1
    else:
        with locked():
            if args.command.startswith('retention-'):
                print(json.dumps(retention(dry_run=args.command == 'retention-plan')))
            else:
                {'base': base, 'dump': dump, 'verify': verify, 'cycle': cycle,
                 'replica-sync': replica_sync}[args.command]()
                event(args.command + '.completed')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        # 外部程序错误/数据库对象信息一律不穿透运维日志。
        event('operation.failed', False, code=error_code(error))
        sys.exit(1)
