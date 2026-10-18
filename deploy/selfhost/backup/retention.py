"""Conservative full-backup retention for the pinned WAL-G v3.0.8 runtime."""

import json
import re
from datetime import datetime, timedelta, timezone


class RetentionError(RuntimeError):
    """A retention precondition failed; messages never include external output."""


WAL_BYTES = 16 * 1024 * 1024
WAL_RE = re.compile(r'[0-9A-F]{24}\Z')
BASE_RE = re.compile(r'base_([0-9A-F]{24})\Z')


def timestamp(value):
    try:
        result = value if isinstance(value, datetime) else datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.tzinfo is None or result.year < 2000:
            raise ValueError()
        return result.astimezone(timezone.utc)
    except (AttributeError, TypeError, ValueError):
        raise RetentionError('invalid UTC timestamp') from None


def _iso(value):
    return value.isoformat().replace('+00:00', 'Z')


def _wal(value):
    if not isinstance(value, str) or not WAL_RE.fullmatch(value):
        raise RetentionError('invalid WAL identity')
    timeline = int(value[:8], 16)
    low = int(value[16:], 16)
    if timeline < 1 or low >= 256:
        raise RetentionError('unsupported WAL identity or segment size')
    return timeline, int(value[8:16], 16) * 256 + low


def _integer(value):
    if type(value) is not int or value < 1:
        raise RetentionError('missing or invalid backup metadata')
    return value


def read_backups(client):
    """Do not log the raw list: it may contain user-supplied metadata."""
    try:
        result = json.loads(client(['backup-list', '--detail', '--json']))
    except (TypeError, ValueError):
        raise RetentionError('invalid backup inventory') from None
    if not isinstance(result, list):
        raise RetentionError('invalid backup inventory')
    return result


def plan(backups, now, daily_days=7, weekly_weeks=4, weekly_day=0):
    """Use complete raw `backup-list --detail --json` entries, not object ages.

    weekly_day follows Python weekday: Monday=0, Sunday=6, UTC midnight.
    The first successful full in each fixed week is its anchor. All intermediate
    bases remain, so deletion cannot punch holes in the promised WAL interval.
    """
    now = timestamp(now)
    if (type(daily_days) is not int or not 1 <= daily_days <= 365
            or type(weekly_weeks) is not int or not 1 <= weekly_weeks <= 104
            or type(weekly_day) is not int or not 0 <= weekly_day <= 6):
        raise RetentionError('invalid retention policy')
    if not isinstance(backups, list) or not backups:
        raise RetentionError('no complete backups available')
    entries = []
    for item in backups:
        if not isinstance(item, dict):
            raise RetentionError('invalid backup metadata')
        name = item.get('backup_name')
        match = BASE_RE.fullmatch(name) if isinstance(name, str) else None
        if not match or item.get('storage_name', 'default') != 'default':
            raise RetentionError('only full backups in the primary storage are supported')
        wal = match.group(1)
        timeline, segment = _wal(wal)
        if item.get('wal_file_name') != wal:
            raise RetentionError('backup WAL identity mismatch')
        start, finish = timestamp(item.get('start_time')), timestamp(item.get('finish_time'))
        start_lsn, finish_lsn = _integer(item.get('start_lsn')), _integer(item.get('finish_lsn'))
        cluster = str(_integer(item.get('system_identifier')))
        if (start > finish or finish > now or finish_lsn < start_lsn
                or (start_lsn - 1) // WAL_BYTES != segment
                or type(item.get('is_permanent')) is not bool):
            raise RetentionError('incomplete or inconsistent backup metadata')
        entries.append({'name': name, 'start': start, 'finish': finish,
                        'wal': wal, 'segment': segment, 'finish_lsn': finish_lsn,
                        'cluster': cluster, 'timeline': timeline,
                        'permanent': item['is_permanent']})
    entries.sort(key=lambda item: item['segment'])
    if len({item['name'] for item in entries}) != len(entries):
        raise RetentionError('duplicate backup identity')
    if len({item['cluster'] for item in entries}) != 1 or len({item['timeline'] for item in entries}) != 1:
        raise RetentionError('mixed cluster or timeline; retention paused')
    if any(a['start'] > b['start'] for a, b in zip(entries, entries[1:])):
        raise RetentionError('backup time and WAL ordering disagree')
    cutoff = now - timedelta(days=daily_days)
    daily = [item for item in entries if item['start'] >= cutoff]
    before = [item for item in entries if item['finish'] <= cutoff]
    # 在线备份只能恢复到完成之后；保留截止点前已完成的最近 base。
    if before:
        daily.insert(0, before[-1])
    anchor = now.replace(hour=0, minute=0, second=0, microsecond=0)
    anchor -= timedelta(days=(anchor.weekday() - weekly_day) % 7)
    weekly = []
    missing_weeks = []
    for index in range(weekly_weeks):
        lower = anchor - timedelta(weeks=index)
        upper = lower + timedelta(weeks=1)
        choices = [item for item in entries if lower <= item['start'] < upper]
        if choices:
            weekly.append(choices[0])
        else:
            missing_weeks.append(_iso(lower))
    chosen = {item['name'] for item in daily + weekly}
    chosen.update(item['name'] for item in entries if item['permanent'])
    # 即使窗口还没有新备份，也保留最后一个已成功 base。
    chosen.add(entries[-1]['name'])
    oldest = next(item for item in entries if item['name'] in chosen)
    retained = [item['name'] for item in entries if item['segment'] >= oldest['segment']]
    return {'plannedAt': _iso(now), 'policy': {'dailyDays': daily_days, 'weeklyWeeks': weekly_weeks,
            'weeklyDay': weekly_day}, 'daily': [item['name'] for item in daily],
            'weekly': [item['name'] for item in weekly], 'missingWeeklyAnchors': missing_weeks,
            'retained': retained, 'oldest': oldest['name'], 'latest': entries[-1]['name'],
            'candidates': [item['name'] for item in entries if item['segment'] < oldest['segment']],
            'preserveFromWal': oldest['wal'], 'clusterId': oldest['cluster'],
            'timeline': oldest['timeline'], 'latestFinish': _iso(entries[-1]['finish']),
            'latestFinishLsn': entries[-1]['finish_lsn']}


def _fresh(value, now, max_age):
    when = timestamp(value)
    if not timedelta(0) <= now - when <= timedelta(seconds=max_age):
        raise RetentionError('retention proof is stale or from the future')
    return when


def _verify_result(result, retention_plan, last_wal):
    """v3.0.8 exits zero for WARNING/FAILURE: inspect status and exact range."""
    try:
        parsed = json.loads(result)
        integrity, timeline = parsed['integrity'], parsed['timeline']
        details = timeline['details']
        if (integrity['status'] != 'OK' or timeline['status'] != 'OK'
                or details['current_timeline_id'] != retention_plan['timeline']
                or details['highest_storage_timeline_id'] != retention_plan['timeline']):
            raise ValueError()
        lower = _wal(retention_plan['preserveFromWal'])[1]
        upper = _wal(last_wal)[1]
        ranges = []
        for row in integrity['details']:
            start_tli, start = _wal(row['start_segment'])
            end_tli, end = _wal(row['end_segment'])
            if (row['status'] != 'FOUND' or start_tli != retention_plan['timeline']
                    or end_tli != start_tli or row['timeline_id'] != start_tli
                    or end < start or row['segments_count'] != end - start + 1):
                raise ValueError()
            ranges.append((start, end))
        cursor = lower
        for start, end in sorted(ranges):
            if start != cursor:
                raise ValueError()
            cursor = end + 1
        if cursor != upper + 1:
            raise ValueError()
    except (KeyError, TypeError, ValueError, RetentionError):
        raise RetentionError('WAL integrity or timeline proof failed') from None


def integrity_proof(client, backup_id, last_wal=None):
    """Return actual verified WAL bounds; the caller supplies the time bound.

    Without last_wal, the peer-connected cluster's current segment is excluded.
    A missing/delayed/uploading segment is a failed proof even on exit code zero.
    """
    if not isinstance(backup_id, str) or not BASE_RE.fullmatch(backup_id):
        raise RetentionError('invalid full backup identity')
    args = ['wal-verify', 'integrity', 'timeline', '--json', '--backup-name', backup_id]
    if last_wal is not None:
        tli, segment = _wal(last_wal)
        lsn = (segment + 1) * WAL_BYTES + 1
        args += ['--timeline', str(tli), '--lsn', f'{lsn >> 32:X}/{lsn & 0xFFFFFFFF:X}']
    raw = client(args)
    try:
        parsed = json.loads(raw)
        rows = parsed['integrity']['details']
        tli = parsed['timeline']['details']['current_timeline_id']
        first = min(row['start_segment'] for row in rows)
        last = max(row['end_segment'] for row in rows)
    except (KeyError, TypeError, ValueError):
        raise RetentionError('WAL integrity or timeline proof failed') from None
    _verify_result(raw, {'timeline': tli, 'preserveFromWal': first}, last_wal or last)
    if first != backup_id[5:]:
        raise RetentionError('WAL verification does not start at the selected base')
    return {'ok': True, 'lastWal': last, 'timeline': tli,
            'preserveFromWal': first, 'verification': parsed}


def execute(client, retention_plan, proof, now, dry_run=True, max_proof_age=900):
    """Run inside the caller's cycle lock using proof from trusted local state.

    The caller must establish clusterId/timeline via the local peer connection,
    and archive.continuousUntil via an archived switch boundary. Replica proof
    must come from a verified manifest, never a caller-provided optimistic flag.
    """
    now = timestamp(now)
    base, archive, replica = proof.get('base', {}), proof.get('archive', {}), proof.get('replica', {})
    if proof.get('clusterId') != retention_plan['clusterId'] or proof.get('timeline') != retention_plan['timeline']:
        raise RetentionError('live cluster identity differs from backup inventory')
    if (base.get('ok') is not True or base.get('backupId') != retention_plan['latest']
            or archive.get('ok') is not True):
        raise RetentionError('new base or archive cycle failed; deletion refused')
    base_time = _fresh(base.get('lastSuccess'), now, max_proof_age)
    archive_time = _fresh(archive.get('verifiedAt'), now, max_proof_age)
    continuous_until = timestamp(archive.get('continuousUntil'))
    if (base_time < timestamp(retention_plan['latestFinish']) or archive_time < base_time
            or not timestamp(retention_plan['latestFinish']) <= continuous_until <= archive_time):
        raise RetentionError('archive proof does not cover the new base')
    last_wal = archive.get('lastWal')
    tli, last_segment = _wal(last_wal)
    if tli != retention_plan['timeline'] or (last_segment + 1) * WAL_BYTES < retention_plan['latestFinishLsn']:
        raise RetentionError('archive upper bound is insufficient')
    if replica.get('configured') is True:
        if (replica.get('ok') is not True or replica.get('backupId') != retention_plan['latest']
                or replica.get('oldestBackupId') != retention_plan['oldest']
                or replica.get('clusterId') != retention_plan['clusterId']
                or replica.get('timeline') != retention_plan['timeline']):
            raise RetentionError('replica manifest is missing or unsuccessful')
        replica_time = _fresh(replica.get('lastSuccess'), now, max_proof_age)
        if (replica_time < base_time or not continuous_until <= timestamp(replica.get('continuousUntil')) <= replica_time):
            raise RetentionError('replica does not cover the retained recovery interval')
        replica_status = 'verified'
    elif replica.get('configured') is False:
        replica_status = 'not_configured'
    else:
        raise RetentionError('replica configuration is unknown')
    # 执行前重新读取清单，防止旧计划或其他清理者改动后继续删除。
    policy = retention_plan['policy']
    current = plan(read_backups(client), retention_plan['plannedAt'], policy['dailyDays'],
                   policy['weeklyWeeks'], policy['weeklyDay'])
    if current != retention_plan:
        raise RetentionError('backup inventory changed; replan required')
    # wal-verify 排除传入的 current segment，故选择 lastWal 的下一段起点+1。
    lsn = (last_segment + 1) * WAL_BYTES + 1
    verify_args = ['wal-verify', 'integrity', 'timeline', '--json', '--backup-name',
                   retention_plan['oldest'], '--timeline', str(tli), '--lsn', f'{lsn >> 32:X}/{lsn & 0xFFFFFFFF:X}']
    _verify_result(client(verify_args), retention_plan, last_wal)
    delete_args = ['delete', 'before', 'FIND_FULL', retention_plan['oldest']]
    client(delete_args)
    if not dry_run and retention_plan['candidates']:
        client(delete_args + ['--confirm'])
    return {'dryRun': dry_run, 'oldest': retention_plan['oldest'],
            'candidates': retention_plan['candidates'], 'replica': replica_status,
            'continuousUntil': _iso(continuous_until), 'lastWal': last_wal}
