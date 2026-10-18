"""重要恢复边界；Docker/S3实际链由test-backup.mjs --restore验证。"""
import argparse
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import restore


class RestoreTests(unittest.TestCase):
    def test_walg_nanosecond_metadata_and_fractional_utc_on_host_python(self):
        self.assertEqual(restore.iso_time('2026-10-14T10:00:00.123456789Z').microsecond, 123456)
        self.assertEqual(restore.utc('2026-10-14T10:00:00.1Z'), '2026-10-14T10:00:00.100000Z')

    def test_requires_explicit_utc_and_preserves_fraction(self):
        self.assertEqual(restore.utc('2026-10-14T10:00:00.123456+00:00'),
                         '2026-10-14T10:00:00.123456Z')
        for value in ['2026-10-14 10:00:00', '2026-10-14T10:00:00+08:00',
                      '2026-10-14T10:00:00', "2026-10-14T10:00:00Z'", '2026-02-30T10:00:00Z']:
            with self.subTest(value=value), self.assertRaises(restore.RestoreError):
                restore.utc(value)

    def test_env_rejects_credentials_and_untrusted_endpoint(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 's3.env'
            valid = 'BACKUP_S3_ENDPOINT=https://s3.example.test\nBACKUP_S3_REGION=test-1\nBACKUP_S3_PREFIX=s3://backup-fixture/cluster\n'
            path.write_text(valid)
            self.assertEqual(len(restore.env_file(path)), 3)
            for content in [valid + 'AWS_SECRET_ACCESS_KEY=sentinel\n', valid.replace('https://', 'http://'),
                            valid.replace('s3.example.test', 'user:sentinel@s3.example.test'),
                            valid.replace('/cluster', '/../cluster')]:
                path.write_text(content)
                with self.assertRaises(restore.RestoreError):
                    restore.env_file(path)

    def test_existing_state_and_invalid_target_fail_before_docker(self):
        with tempfile.TemporaryDirectory() as root:
            args = argparse.Namespace(target_time='2026-10-14T10:00:00Z',
                backup_id='base_000000010000000000000001', project='selfhost-restore-d-restore-unit',
                image='registry.example.test/postgres@sha256:' + 'a' * 64,
                database='product_res_production', timeout=30, state_dir=root)
            with patch.object(restore, 'run') as docker:
                with self.assertRaisesRegex(restore.RestoreError, 'RESTORE_STATE_PATH_NOT_NEW'):
                    restore.restore(args)
                docker.assert_not_called()
                args.backup_id = 'LATEST'
                with self.assertRaisesRegex(restore.RestoreError, 'RESTORE_INVALID_BACKUP_ID'):
                    restore.restore(args)
                docker.assert_not_called()

    def test_checks_reject_commands_and_only_export_boolean_results(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'checks.json'
            path.write_text(json.dumps({'creditsEnabled': False, 'checks': [
                {'name': 'markers', 'sql': 'SELECT true; DROP TABLE x'}]}))
            with self.assertRaisesRegex(restore.RestoreError, 'RESTORE_INVALID_CHECKS'):
                restore.checks_file(path)
            path.write_text(json.dumps({'creditsEnabled': False, 'checks': [
                {'name': 'markers', 'sql': 'SELECT true'}]}))
            self.assertEqual(restore.checks_file(path)['checks'][0]['name'], 'markers')

    def test_failed_check_does_not_promote_or_claim_success(self):
        state = {'validation': {'creditsEnabled': False, 'checks': []}}
        with patch.object(restore, 'sql', side_effect=['t', 't', 'f']) as query, patch.object(restore, 'save'):
            with self.assertRaisesRegex(restore.RestoreError, 'RESTORE_CHECK_FAILED'):
                restore.validate(state)
            self.assertFalse(state['checks'][-1]['ok'])
            self.assertFalse(any('promote' in call.args[1] for call in query.call_args_list))
            self.assertNotIn('status', state)

    def test_replay_after_target_rejects_validation(self):
        state = {'targetTime': '2026-10-14T10:00:00Z', 'clusterId': '123',
                 'validation': {'creditsEnabled': False, 'checks': []}}
        metadata = json.dumps({'at': '2026-10-14T10:00:01+00:00', 'lsn': '0/A', 'cluster': '123'})
        with patch.object(restore, 'sql', side_effect=['t'] * 8 + [metadata]), patch.object(restore, 'save'):
            with self.assertRaisesRegex(restore.RestoreError, 'RESTORE_POINT_AFTER_TARGET'):
                restore.validate(state)
            self.assertNotIn('status', state)

    def test_cleanup_refuses_foreign_resources(self):
        state = {'project': 'selfhost-restore-unit', 'owner': 'our-owner'}
        result = argparse.Namespace(returncode=0, stdout=json.dumps([{'Config': {'Labels': {restore.LABEL: 'production'}}}]))
        with patch.object(restore, 'run', return_value=result) as docker:
            with self.assertRaisesRegex(restore.RestoreError, 'RESTORE_RESOURCE_NOT_OWNED'):
                restore.cleanup(state)
            self.assertEqual(docker.call_count, 1)
            self.assertNotIn('rm', docker.call_args.args[0])

    def test_docker_failure_diagnostics_do_not_escape(self):
        result = argparse.Namespace(returncode=1, stdout='business-body', stderr='secret-sentinel')
        with patch('subprocess.run', return_value=result):
            with self.assertRaisesRegex(restore.RestoreError, '^RESTORE_DOCKER_FAILED$'):
                restore.run(['docker', 'test'])


if __name__ == '__main__':
    unittest.main()
