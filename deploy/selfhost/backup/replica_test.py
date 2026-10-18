import contextlib
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch
from urllib.parse import urlsplit

import backup
import replica
from walg import BackupError

WAL = '000000010000000000000001'
BASE = 'base_' + WAL
INVENTORY = {'preserveFromWal': WAL, 'retained': [BASE], 'latest': BASE,
             'oldest': BASE, 'clusterId': '12345', 'timeline': 1}
VERIFICATION = {'ok': True, 'lastWal': WAL, 'continuousUntil': '2026-10-14T00:00:00Z'}


class Store:
    def __init__(self, prefix, data=None):
        self.endpoint = urlsplit('https://fixture.invalid')
        self.bucket = 'fixture'
        self.prefix = prefix
        self.data = data or {}
        self.fail = None
        self.corrupt = False

    def list(self):
        return {key: len(value) for key, value in self.data.items() if key.startswith(replica.LAYOUT)}

    def get(self, key, output=None):
        value = self.data.get(key)
        if value is None:
            return None
        if output:
            output.write(value)
        return {'bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest()}

    def put(self, key, stream, record):
        if self.fail == key:
            raise BackupError('REPLICA_S3_REQUEST_FAILED')
        stream.seek(0)
        self.data[key] = b'corrupt' if self.corrupt else stream.read()


class ReplicaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.source = Store('source/', {
            'basebackups_005/' + BASE + '/tar_partitions/part_001.tar.lz4': b'compressed-tar',
            'basebackups_005/' + BASE + '_backup_stop_sentinel.json': b'sentinel',
            'wal_005/' + WAL + '.lz4': b'compressed-wal',
            'wal_005/00000002.history.lz4': b'compressed-history',
            'logical/id/manifest.json': b'logical-manifest',
            'logical/id/roles.sql.lz4': b'roles-material',
            'logical/id/database.dump.lz4': b'dump-material'})
        self.target = Store('replica/')

    def sync(self):
        return replica.sync(INVENTORY, VERIFICATION, self.temporary.name,
                            self.source, self.target)

    def test_raw_repeat_and_source_delete_keep_independent_complete_inventory(self):
        first = self.sync()
        self.assertEqual(first['copiedObjects'], len(self.source.data))
        self.assertEqual(self.sync()['copiedObjects'], 0)
        removed = 'logical/id/database.dump.lz4'
        original = self.source.data.pop(removed)
        self.sync()
        self.assertEqual(self.target.data[removed], original)
        manifest = json.loads(self.target.data[replica.MANIFEST])
        objects = {item['key']: item for item in manifest['objects']}
        self.assertEqual(objects[removed]['sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(len(objects), len(self.target.data) - 1)
        self.assertEqual(manifest['continuousUntil'], VERIFICATION['continuousUntil'])

    def test_interrupted_sync_never_commits_manifest_and_can_resume(self):
        self.sync()
        previous = self.target.data[replica.MANIFEST]
        key = 'logical/new/roles.sql.lz4'
        self.source.data[key] = b'new-material'
        self.target.fail = key
        with self.assertRaises(BackupError):
            self.sync()
        self.assertEqual(self.target.data[replica.MANIFEST], previous)
        self.target.fail = None
        self.assertEqual(self.sync()['copiedObjects'], 1)

    def test_killed_replica_attempt_must_not_report_previous_success(self):
        directory = Path(self.temporary.name)
        previous = {'configured': True, 'ok': True, 'lastSuccess': backup.stamp(),
                    'manifestSha256': 'previous-verified-manifest'}
        with patch.object(backup, 'STATE', directory), \
                patch.dict(os.environ, {'BACKUP_REPLICA_ENABLED': 'true'}, clear=True), \
                patch.object(backup, 'archive_stats', return_value={'last_archived_time': previous['lastSuccess']}), \
                patch.object(backup, 'tree_bytes', return_value=0), \
                patch.object(backup.shutil, 'disk_usage', return_value=MagicMock(free=100)):
            backup.save({**{name: {'ok': True, 'lastSuccess': previous['lastSuccess']}
                           for name in ('base', 'dump', 'verification')}, 'replica': previous})
            (directory / 'archive.json').write_text(json.dumps({'lastSuccess': previous['lastSuccess']}))
            script = """
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import backup
def copying():
    (backup.STATE / 'copy-started').touch()
    time.sleep(60)
    return {}
with backup.locked():
    backup.operation('replica', copying)
"""
            process = subprocess.Popen([sys.executable, '-c', script, str(Path(backup.__file__).parent)],
                                       env={**os.environ, 'BACKUP_STATE_DIR': str(directory),
                                            'PYTHONDONTWRITEBYTECODE': '1'})
            try:
                deadline = time.monotonic() + 5
                while not (directory / 'copy-started').exists():
                    self.assertIsNone(process.poll(), 'copy exited before interruption')
                    self.assertLess(time.monotonic(), deadline, 'copy never started')
                    time.sleep(0.01)
                self.assertTrue(backup.status()['healthy'])
                process.kill()
                process.wait(timeout=5)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
            self.assertLess(process.returncode, 0)
            state = backup.load()['replica']
            self.assertFalse(state['ok'], 'Interrupted copy reported success')
            self.assertEqual(state['lastSuccess'], previous['lastSuccess'])
            self.assertEqual(state['manifestSha256'], previous['manifestSha256'])
            # 残留 running=true 或其他运维操作持锁，都不能冒充复制仍在执行。
            with backup.locked():
                self.assertFalse(backup.status()['healthy'])

    def test_corrupt_upload_or_missing_segment_refuses_manifest(self):
        self.target.corrupt = True
        with self.assertRaisesRegex(BackupError, 'CHECKSUM_MISMATCH'):
            self.sync()
        self.assertNotIn(replica.MANIFEST, self.target.data)
        self.target.corrupt = False
        self.source.data.pop('wal_005/' + WAL + '.lz4')
        with self.assertRaisesRegex(BackupError, 'WAL_GAP'):
            self.sync()
        self.assertNotIn(replica.MANIFEST, self.target.data)

    def test_download_applies_configured_body_transfer_budget(self):
        client = object.__new__(replica.S3)
        client.rate, client.chunk = 2, 2
        response = io.BytesIO(b'abcd')
        response.getheader = lambda name: '4'
        client.request = lambda *args: (MagicMock(), response)
        with patch.object(replica.time, 'monotonic', return_value=0), patch.object(replica.time, 'sleep') as sleep:
            record = client.get('wal_005/' + WAL + '.lz4')
        self.assertEqual(record['bytes'], 4)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])

    def test_independent_credentials_do_not_fallback_and_failed_operation_is_visible(self):
        with patch.dict(os.environ, {'BACKUP_S3_ACCESS_KEY_ID_FILE': '/source-access'}, clear=True):
            with self.assertRaises(BackupError):
                replica.configuration(True)
        with patch.object(backup, 'STATE', Path(self.temporary.name)):
            backup.save({'replica': {'configured': True, 'ok': True, 'lastSuccess': 'old-success'}})
            def failed():
                raise BackupError('REPLICA_S3_REQUEST_FAILED')
            output = io.StringIO()
            with contextlib.redirect_stdout(output), self.assertRaises(BackupError):
                backup.operation('replica', failed)
            state = backup.load()['replica']
            self.assertFalse(state['ok'])
            self.assertEqual(state['failures'], 1)
            self.assertEqual(state['lastSuccess'], 'old-success')
            event = json.loads(output.getvalue())
            self.assertEqual(event, {'event': 'selfhost.backup.operation.failed', 'ok': False,
                                     'level': 'error', 'code': 'REPLICA_S3_REQUEST_FAILED',
                                     'operation': 'replica'})

    def test_replica_refresh_preserves_verified_health_but_failure_and_staleness_do_not(self):
        current = dt.datetime(2026, 10, 17, 15, tzinfo=dt.timezone.utc)
        success = backup.stamp(current - dt.timedelta(minutes=20))
        state = {name: {'ok': True, 'lastSuccess': success}
                 for name in ('base', 'dump', 'verification', 'replica')}
        with patch.object(backup, 'STATE', Path(self.temporary.name)), \
                patch.object(backup, 'now', return_value=current), \
                patch.dict(os.environ, {'BACKUP_REPLICA_ENABLED': 'true'}, clear=True), \
                patch.object(backup, 'archive_stats', return_value={'last_archived_time': success}), \
                patch.object(backup, 'tree_bytes', return_value=0), \
                patch.object(backup.shutil, 'disk_usage', return_value=MagicMock(free=100)):
            (Path(self.temporary.name) / 'archive.json').write_text(json.dumps({'lastSuccess': success}))
            backup.save(state)
            def refresh():
                self.assertTrue(backup.load()['replica']['running'])
                self.assertFalse(backup.load()['replica']['ok'])
                self.assertTrue(backup.status()['healthy'])
                return {}
            backup.operation('replica', refresh)
            state = backup.load()
            self.assertIn('lastDurationSeconds', state['replica'])
            state['replica']['lastSuccess'] = backup.stamp(current - dt.timedelta(seconds=3601))
            backup.save(state)
            self.assertFalse(backup.status()['healthy'])
            state['replica'].update(lastSuccess=success, ok=True)
            backup.save(state)
            def failed():
                raise BackupError('REPLICA_S3_TIMEOUT')
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(BackupError):
                backup.operation('replica', failed)
            self.assertFalse(backup.status()['healthy'])
            def retry():
                self.assertFalse(backup.status()['healthy'])
                return {}
            with contextlib.redirect_stdout(io.StringIO()):
                backup.operation('replica', retry)
            self.assertNotIn('lastError', backup.load()['replica'])
            # 副本健康预算不能改变主备份或归档故障的判断。
            for name in ('base', 'dump', 'verification'):
                broken = backup.load()
                broken[name]['ok'] = False
                backup.save(broken)
                self.assertFalse(backup.status()['healthy'])
                broken[name]['ok'] = True
                backup.save(broken)
            (Path(self.temporary.name) / 'archive.json').write_text(json.dumps(
                {'lastSuccess': success, 'consecutiveFailures': 1}))
            self.assertFalse(backup.status()['healthy'])

    def test_replica_freshness_budget_leaves_two_intervals_of_margin(self):
        with patch.dict(os.environ, {'BACKUP_REPLICA_INTERVAL_SECONDS': '1200'}, clear=True):
            self.assertEqual(backup.replica_max_age(), 3600)
            with patch.dict(os.environ, {'BACKUP_REPLICA_MAX_AGE_SECONDS': '900'}):
                with self.assertRaisesRegex(BackupError, 'REPLICA_MAX_AGE_TOO_SHORT'):
                    backup.replica_max_age()

    def test_unexpected_failure_logs_no_exception_text(self):
        with patch.object(backup, 'STATE', Path(self.temporary.name)):
            output = io.StringIO()
            def failed():
                raise RuntimeError('secret-sentinel')
            with contextlib.redirect_stdout(output), self.assertRaises(RuntimeError):
                backup.operation('replica', failed)
            event = json.loads(output.getvalue())
            self.assertEqual(event['code'], 'BACKUP_OPERATION_FAILED')
            self.assertNotIn('secret-sentinel', output.getvalue())

    def test_socket_timeout_logs_safe_request_stage_and_keeps_original_timeout(self):
        client = replica.S3({'AWS_ENDPOINT': 'https://endpoint-sentinel.invalid',
                             'WALG_S3_PREFIX': 's3://bucket-sentinel/prefix-sentinel',
                             'AWS_S3_FORCE_PATH_STYLE': 'true', 'WALG_NETWORK_RATE_LIMIT': '10485760',
                             'AWS_REGION': 'auto', 'AWS_ACCESS_KEY_ID': 'access-sentinel',
                             'AWS_SECRET_ACCESS_KEY': 'secret-sentinel'}, role='replica')
        connection = MagicMock()
        connection.getresponse.side_effect = TimeoutError('secret-sentinel')
        output = io.StringIO()
        previous = {'ok': True, 'lastSuccess': backup.stamp(),
                    'manifestSha256': 'previous-verified-manifest'}
        with patch.object(replica.http.client, 'HTTPSConnection', return_value=connection) as factory, \
                patch.object(backup, 'STATE', Path(self.temporary.name)), \
                contextlib.redirect_stdout(output), self.assertRaisesRegex(BackupError, '^REPLICA_S3_TIMEOUT$'):
            backup.save({'replica': previous})
            backup.operation('replica', lambda: client.request('GET', 'key-sentinel'))
        with patch.object(backup, 'STATE', Path(self.temporary.name)):
            state = backup.load()['replica']
        self.assertFalse(state['ok'])
        self.assertFalse(state['running'])
        self.assertEqual(state['lastError'], 'REPLICA_S3_TIMEOUT')
        self.assertEqual(state['lastSuccess'], previous['lastSuccess'])
        self.assertEqual(state['manifestSha256'], previous['manifestSha256'])
        event = json.loads(output.getvalue().splitlines()[0])
        self.assertEqual((event['level'], event['target'], event['method'], event['stage']),
                         ('error', 'replica', 'GET', 'response_headers'))
        self.assertEqual(factory.call_args.kwargs['timeout'], 30)
        self.assertNotIn('sentinel', output.getvalue())
        connection.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
