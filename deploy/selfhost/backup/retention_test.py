import copy
import json
import unittest
from datetime import datetime, timedelta, timezone

import retention


NOW = datetime(2026, 10, 14, 12, tzinfo=timezone.utc)


def backup(age, segment, timeline=1):
    wal = f'{timeline:08X}{segment // 256:08X}{segment % 256:08X}'
    start = NOW - timedelta(days=age)
    return {'backup_name': 'base_' + wal, 'wal_file_name': wal, 'storage_name': 'default',
            'start_time': start.isoformat(), 'finish_time': (start + timedelta(seconds=1)).isoformat(),
            'start_lsn': segment * retention.WAL_BYTES + 1,
            'finish_lsn': segment * retention.WAL_BYTES + 100,
            'system_identifier': 12345, 'is_permanent': False}


def inventory():
    return [backup(age, 100 + 40 - age) for age in range(40, 0, -1)] + [backup(0, 141)]


def success(plan):
    finished = retention.timestamp(plan['latestFinish'])
    return {'clusterId': '12345', 'timeline': 1,
            'base': {'ok': True, 'backupId': plan['latest'], 'lastSuccess': finished.isoformat()},
            'archive': {'ok': True, 'verifiedAt': NOW.isoformat(),
                        'continuousUntil': NOW.isoformat(), 'lastWal': '00000001000000000000008D'},
            'replica': {'configured': False}}


class Client:
    def __init__(self, backups, plan):
        self.backups, self.plan, self.calls, self.status = backups, plan, [], 'OK'

    def __call__(self, args):
        self.calls.append(args)
        if args[0] == 'backup-list':
            return json.dumps(self.backups)
        if args[0] == 'wal-verify':
            start = self.plan['preserveFromWal']
            end = '00000001000000000000008D'
            return json.dumps({'integrity': {'status': self.status, 'details': [
                {'timeline_id': 1, 'start_segment': start, 'end_segment': end,
                 'segments_count': retention._wal(end)[1] - retention._wal(start)[1] + 1,
                 'status': 'FOUND'}]}, 'timeline': {'status': 'OK', 'details': {
                     'current_timeline_id': 1, 'highest_storage_timeline_id': 1}}})
        return ''


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.backups = inventory()
        # 最新 base 的完成时刻必须早于验证时刻。
        self.backups[-1]['start_time'] = (NOW - timedelta(seconds=2)).isoformat()
        self.backups[-1]['finish_time'] = (NOW - timedelta(seconds=1)).isoformat()
        self.plan = retention.plan(self.backups, NOW)
        self.client = Client(self.backups, self.plan)

    def test_fixed_weekly_anchor_keeps_old_base_and_every_intermediate(self):
        weekly_ages = [(NOW - retention.timestamp(next(b['start_time'] for b in self.backups
                       if b['backup_name'] == name))).days for name in self.plan['weekly']]
        self.assertEqual(weekly_ages, [2, 9, 16, 23])
        self.assertEqual(self.plan['oldest'], backup(23, 117)['backup_name'])
        self.assertEqual(len(self.plan['retained']), 24)
        custom = retention.plan(self.backups, NOW, daily_days=2, weekly_weeks=2, weekly_day=6)
        self.assertEqual(custom['oldest'], backup(10, 130)['backup_name'])

    def test_daily_predecessor_finished_before_window_start(self):
        cutoff = NOW - timedelta(days=7)
        ready = backup(8, 100)
        spanning = backup(7, 101)
        spanning['start_time'] = (cutoff - timedelta(minutes=1)).isoformat()
        spanning['finish_time'] = (cutoff + timedelta(minutes=1)).isoformat()
        latest = copy.deepcopy(self.backups[-1])
        plan = retention.plan([ready, spanning, latest], NOW, weekly_weeks=1)
        self.assertEqual(plan['oldest'], ready['backup_name'])
        self.assertNotIn(ready['backup_name'], plan['candidates'])

    def test_permanent_backup_moves_wal_boundary_back(self):
        self.backups[0]['is_permanent'] = True
        plan = retention.plan(self.backups, NOW)
        self.assertEqual(plan['oldest'], self.backups[0]['backup_name'])
        self.assertEqual(plan['candidates'], [])

    def test_unknown_metadata_and_mixed_cluster_or_timeline_refuse_plan(self):
        changes = [{'system_identifier': None}, {'system_identifier': 67890},
                   {'finish_lsn': 0}, {'is_permanent': None}, backup(40, 100, timeline=2)]
        for change in changes:
            with self.subTest(change=change):
                backups = copy.deepcopy(self.backups)
                backups[0].update(change)
                with self.assertRaises(retention.RetentionError):
                    retention.plan(backups, NOW)

    def test_dry_run_never_confirms_delete_and_apply_verifies_whole_chain(self):
        result = retention.execute(self.client, self.plan, success(self.plan), NOW)
        self.assertEqual(result['replica'], 'not_configured')
        self.assertFalse(any('--confirm' in args for args in self.client.calls))
        retention.execute(self.client, self.plan, success(self.plan), NOW, dry_run=False)
        self.assertEqual(self.client.calls[-1], ['delete', 'before', 'FIND_FULL', self.plan['oldest'], '--confirm'])
        self.assertIn('0/8E000001', self.client.calls[-3])

    def test_failed_new_base_archive_or_replica_cannot_delete(self):
        changes = [('base', {'ok': False}), ('archive', {'ok': False}),
                   ('archive', {'verifiedAt': (NOW - timedelta(hours=1)).isoformat()}),
                   ('replica', {'configured': True, 'ok': False})]
        for section, change in changes:
            with self.subTest(section=section, change=change):
                proof = success(self.plan)
                proof[section].update(change)
                client = Client(self.backups, self.plan)
                with self.assertRaises(retention.RetentionError):
                    retention.execute(client, self.plan, proof, NOW, dry_run=False)
                self.assertFalse(any(args[0] == 'delete' for args in client.calls))

    def test_warning_or_lost_wal_refuses_delete_even_with_success_exit(self):
        for status in ['WARNING', 'FAILURE']:
            with self.subTest(status=status):
                self.client.status = status
                with self.assertRaises(retention.RetentionError):
                    retention.execute(self.client, self.plan, success(self.plan), NOW, dry_run=False)
        self.assertFalse(any(args[0] == 'delete' for args in self.client.calls))

    def test_replica_proof_requires_fresh_manifest_covering_same_oldest_and_upper_bound(self):
        proof = success(self.plan)
        proof['replica'] = {'configured': True, 'ok': True, 'clusterId': '12345', 'timeline': 1,
                            'backupId': self.plan['latest'], 'oldestBackupId': self.plan['oldest'],
                            'lastSuccess': NOW.isoformat(), 'continuousUntil': NOW.isoformat()}
        for change in [{'lastSuccess': (NOW - timedelta(hours=1)).isoformat()},
                       {'oldestBackupId': self.plan['latest']},
                       {'continuousUntil': (NOW - timedelta(minutes=1)).isoformat()}]:
            candidate = copy.deepcopy(proof)
            candidate['replica'].update(change)
            with self.assertRaises(retention.RetentionError):
                retention.execute(self.client, self.plan, candidate, NOW, dry_run=False)
        self.assertFalse(any(args[0] == 'delete' for args in self.client.calls))
        self.assertEqual(retention.execute(self.client, self.plan, proof, NOW)['replica'], 'verified')

    def test_changed_inventory_refuses_stale_plan(self):
        self.client.backups = self.backups[1:]
        with self.assertRaises(retention.RetentionError):
            retention.execute(self.client, self.plan, success(self.plan), NOW, dry_run=False)
        self.assertFalse(any(args[0] == 'delete' for args in self.client.calls))

    def test_integrity_helper_reports_real_verified_bounds(self):
        proof = retention.integrity_proof(self.client, self.plan['oldest'])
        self.assertEqual(proof['lastWal'], '00000001000000000000008D')
        self.assertEqual(proof['preserveFromWal'], self.plan['preserveFromWal'])


if __name__ == '__main__':
    unittest.main()
