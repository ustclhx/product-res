#!/usr/bin/env python3
"""Safety boundary tests; no root, network, package install or host firewall calls."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('init_server', Path(__file__).with_name('init-server.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InitializationSafety(unittest.TestCase):
    def test_fixed_supported_matrix_and_exact_packages(self):
        for distro, version, suite in [('ubuntu', '24.04', 'noble'), ('debian', '12', 'bookworm')]:
            for arch in ['amd64', 'arm64']:
                release = f'ID={distro}\nVERSION_ID="{version}"\nVERSION_CODENAME={suite}\n'
                self.assertEqual(module.supported(release, arch), (distro, version, suite))
                versions = module.package_versions(distro, version, suite)
                self.assertEqual(versions['docker-ce'], f'5:28.5.1-1~{distro}.{version}~{suite}')
                self.assertEqual(versions['docker-compose-plugin'], f'2.40.3-1~{distro}.{version}~{suite}')
        for release, arch in [('ID=ubuntu\nVERSION_ID=22.04\nVERSION_CODENAME=jammy', 'amd64'),
                              ('ID=debian\nVERSION_ID=12\nVERSION_CODENAME=bookworm', 'armhf')]:
            with self.assertRaises(module.Refused):
                module.supported(release, arch)

    def test_port_conflicts_rejected_even_when_only_loopback(self):
        tcp = 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*'
        udp = 'UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*'
        module.check_listeners(tcp, udp)
        for port in [80, 443, 3000, 5432]:
            with self.assertRaises(module.Refused):
                module.check_listeners(tcp + f'\nLISTEN 0 128 127.0.0.1:{port} 0.0.0.0:*', udp)
        module.check_listeners(tcp + '\nLISTEN 0 128 [::]:443 [::]:*', udp, initialized=True)
        with self.assertRaises(module.Refused):
            module.check_listeners(tcp, 'UNCONN 0 0 0.0.0.0:6379 0.0.0.0:*')

    def test_existing_firewall_rules_and_drop_policy_rejected(self):
        module.check_empty_rules('# generated\n*filter\n:INPUT ACCEPT [0:0]\nCOMMIT')
        for rules in ['*filter\n:INPUT DROP [0:0]\nCOMMIT',
                      '*nat\n:LIMADNS - [0:0]\nCOMMIT',
                      '*filter\n-A INPUT -p tcp --dport 22 -j ACCEPT\nCOMMIT']:
            with self.assertRaises(module.Refused):
                module.check_empty_rules(rules)

    def test_existing_config_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / '.env'
            module.write_new(path, 'fixture-preserved\n')
            with self.assertRaises(FileExistsError):
                module.write_new(path, 'replacement\n')
            self.assertEqual(path.read_text(), 'fixture-preserved\n')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_symlink_path_rejected_before_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'link'
            path.symlink_to(Path(tmp))
            with self.assertRaises(module.Refused):
                module.safe_path(path / '.env')

    def test_existing_install_state_and_used_directory_refuse_before_commands(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'state').mkdir()
            with patch.object(module, 'STATE', root / 'state'), patch.object(module, 'run') as run:
                with self.assertRaises(module.Refused):
                    module.fresh_preflight(root / 'deployment')
                run.assert_not_called()
            (root / '.env').write_text('fixture')
            with patch.object(module, 'STATE', root / 'absent'), patch.object(module, 'run') as run:
                with self.assertRaises(module.Refused):
                    module.fresh_preflight(root)
                run.assert_not_called()

    def test_incomplete_initialization_cannot_be_claimed_as_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'state.json').write_text('{"complete":false}')
            with patch.object(module, 'STATE', root), patch.object(module, 'safe_path'), patch.object(module, 'run') as run:
                with self.assertRaises(module.Refused):
                    module.verify(root / 'deployment', {})
                run.assert_not_called()

    def test_firewall_snapshot_checks_jump_precedes_docker_rules(self):
        def run(*args):
            chain = args[-1]
            if chain == 'FORWARD':
                return '-P FORWARD DROP\n-A FORWARD -j DOCKER-FORWARD\n-A FORWARD -j DOCKER-USER'
            return '-P INPUT ACCEPT\n-A INPUT -j SAAS-INPUT'
        with patch.object(module, 'run', side_effect=run):
            with self.assertRaises(module.Refused):
                module.firewall_snapshot()


if __name__ == '__main__':
    unittest.main()
