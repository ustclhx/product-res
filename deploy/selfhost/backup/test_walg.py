import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import walg


class WalgBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        (root / 'access').write_text('access-sentinel\n')
        (root / 'secret').write_text('secret-sentinel\n')
        env = {
            'BACKUP_S3_ENDPOINT': 'https://storage.example.test',
            'BACKUP_S3_REGION': 'us-east-1',
            'BACKUP_S3_PREFIX': 's3://fixture/cluster/pg17',
            'BACKUP_S3_ACCESS_KEY_ID_FILE': str(root / 'access'),
            'BACKUP_S3_SECRET_ACCESS_KEY_FILE': str(root / 'secret'),
            'BACKUP_STATE_DIR': str(root),
            'AWS_SESSION_TOKEN': 'must-not-inherit',
            'AWS_PROFILE': 'must-not-inherit',
            'DATABASE_URL': 'must-not-inherit',
        }
        self.environment = patch.dict(os.environ, env, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_file_credentials_are_isolated_and_success_output_redacted(self):
        with patch.object(walg.subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 0, 'secret-sentinel access-sentinel https://storage.example.test', '')) as run:
            self.assertEqual(walg.invoke(['backup-list', '--json']), '[redacted] [redacted] [redacted]')
        env = run.call_args.kwargs['env']
        self.assertEqual(env['AWS_SECRET_ACCESS_KEY'], 'secret-sentinel')
        self.assertEqual(env['AWS_EC2_METADATA_DISABLED'], 'true')
        self.assertNotIn('AWS_SESSION_TOKEN', env)
        self.assertNotIn('AWS_PROFILE', env)
        self.assertNotIn('DATABASE_URL', env)

    def test_https_ca_and_secret_boundaries(self):
        with patch.dict(os.environ, {'BACKUP_S3_ENDPOINT': 'http://fixture:8333'}):
            with self.assertRaisesRegex(walg.BackupError, '^s3-https-required$'):
                walg._environment()
            with patch.dict(os.environ, {'BACKUP_ALLOW_HTTP': 'true'}):
                self.assertEqual(walg._environment()['AWS_ENDPOINT'], 'http://fixture:8333')
        with patch.dict(os.environ, {'BACKUP_S3_CA_FILE': '/missing-ca-file'}):
            with self.assertRaisesRegex(walg.BackupError, '^invalid-s3-ca-file$'):
                walg._environment()
        with patch.dict(os.environ, {'BACKUP_S3_SECRET_ACCESS_KEY_FILE': '/missing-secret'}):
            with self.assertRaisesRegex(walg.BackupError, '^invalid-secret-file$'):
                walg._environment()

    def test_failed_upload_is_nonzero_and_retains_wal_with_persistent_status(self):
        wal = Path(self.directory.name) / '000000010000000000000001'
        wal.write_bytes(b'wal-fixture')
        with patch.object(walg.subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 1, 'secret-sentinel', 'raw secret-sentinel error')):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(walg.main(['wal-push', str(wal)]), 1)
            self.assertEqual(output.getvalue(), 'selfhost-backup: archive-failed\n')
        self.assertTrue(wal.exists())
        with patch.object(walg.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(walg.main(['wal-push', str(wal)]), 0)
        state = json.loads((wal.parent / 'archive.json').read_text())
        self.assertEqual((state['failures'], state['successes'], state['consecutiveFailures']), (1, 1, 0))
        self.assertEqual(state['lastWal'], wal.name)
        self.assertEqual((wal.parent / 'archive.json').stat().st_mode & 0o777, 0o600)

    def test_config_credentials_and_timeouts_fail_with_safe_codes(self):
        for args in (['--config=secret.json', 'backup-list'], ['--secret-key=sentinel']):
            with self.assertRaisesRegex(walg.BackupError, '^credentials-in-arguments$'):
                walg.invoke(args)
        with patch.object(walg.subprocess, 'run', side_effect=subprocess.TimeoutExpired('secret-sentinel', 60)):
            with self.assertRaisesRegex(walg.BackupError, '^walg-timeout$'):
                walg.invoke(['backup-push', '/data'], timeout=1800)


if __name__ == '__main__':
    unittest.main()
