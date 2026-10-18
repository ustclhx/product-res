#!/usr/bin/env python3
"""Only initializes a blank, explicitly selected supported host. Never deploys apps."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
STATE = Path('/var/lib/product-res-selfhost-init')
DAEMON = Path('/etc/docker/daemon.json')
FIREWALL = Path('/usr/local/lib/product-res-selfhost/init-firewall.sh')
UNIT = Path('/etc/systemd/system/product-res-selfhost-firewall.service')
DROPIN = Path('/etc/systemd/system/docker.service.d/product-res-selfhost-firewall.conf')
REPO = Path('/etc/apt/sources.list.d/product-res-selfhost-docker.sources')
KEY = Path('/etc/apt/keyrings/product-res-selfhost-docker.asc')
PIN = Path('/etc/apt/preferences.d/product-res-selfhost-docker')
POLICY = Path('/usr/sbin/policy-rc.d')
VERSIONS = {'docker-ce': '28.5.1', 'docker-ce-cli': '28.5.1',
            'containerd.io': '1.7.28', 'docker-buildx-plugin': '0.29.1',
            'docker-compose-plugin': '2.40.3'}
DAEMON_TEXT = json.dumps({'iptables': True, 'ip6tables': True,
                         'userland-proxy': False}, indent=2) + '\n'
UNIT_TEXT = '''[Unit]
Description=Selfhost INPUT and Docker port firewall
Before=docker.service
After=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/usr/local/lib/product-res-selfhost/init-firewall.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
'''
DROPIN_TEXT = '''[Service]
ExecStartPre=/usr/local/lib/product-res-selfhost/init-firewall.sh
ExecStartPost=/usr/local/lib/product-res-selfhost/init-firewall.sh
'''


class Refused(Exception):
    pass


def require(ok, message):
    if not ok:
        raise Refused(message)


def run(*args, allowed=(0,)):
    # 外部工具原始输出不透传，避免 apt/系统配置带出代理凭据。
    result = subprocess.run(args, capture_output=True, text=True, timeout=900)
    require(result.returncode in allowed, 'command failed: ' + args[0])
    return result.stdout.strip()


def safe_path(path):
    require(path.is_absolute() and '..' not in path.parts, 'directory must be absolute without ..')
    for component in [*reversed(path.parents), path]:
        require(not component.is_symlink(), 'symlink in managed path')
        if component.exists():
            require(component.stat().st_uid == 0 and not component.stat().st_mode & 0o022,
                    'managed path has non-root owner or writable ancestor')


def supported(os_release, arch):
    values = dict(re.findall(r'^([A-Z_]+)="?([^"\n]*)"?$', os_release, re.M))
    pair = (values.get('ID'), values.get('VERSION_ID'), values.get('VERSION_CODENAME'))
    require(pair in [('ubuntu', '24.04', 'noble'), ('debian', '12', 'bookworm')],
            'supported OS: Ubuntu 24.04 noble or Debian 12 bookworm')
    require(arch in ['amd64', 'arm64'], 'supported architecture: amd64 or arm64')
    return pair[0], pair[1], pair[2]


def package_versions(distro, release, suite):
    suffix = f'~{distro}.{release}~{suite}'
    return {name: ('5:' if name.startswith('docker-ce') else '') + version +
            ('-2' if name == 'containerd.io' else '-1') + suffix
            for name, version in VERSIONS.items()}


def check_listeners(tcp, udp, initialized=False):
    for protocol, output in [('tcp', tcp), ('udp', udp)]:
        for line in output.splitlines():
            fields = line.split()
            require(len(fields) >= 5, 'cannot parse listening sockets')
            address, port = fields[3].rsplit(':', 1)
            loopback = address.split('%', 1)[0] in ['127.0.0.1', '[::1]', '::1', '127.0.0.53', '127.0.0.54']
            allow = (protocol == 'tcp' and port == '22') or (loopback and port == '53')
            allow |= protocol == 'udp' and port in ['68', '546']
            allow |= port == '5355' and 'systemd-resolve' in line
            allow |= initialized and protocol == 'tcp' and port in ['80', '443']
            require(allow, 'host has a conflicting listening socket; only SSH/DNS/DHCP base services allowed')


def check_empty_rules(output):
    for line in output.splitlines():
        if not line or line.startswith(('#', '*')) or line == 'COMMIT':
            continue
        require(re.fullmatch(r':[A-Z]+ ACCEPT \[\d+:\d+\]', line) is not None,
                'existing firewall rules/policy: use an empty VM, never flush rules')


def fresh_preflight(directory):
    require(not STATE.exists(), 'previous or incomplete initialization exists; inspect manually')
    require(not directory.exists() or not any(directory.iterdir()), 'deployment directory is not empty')
    for path in [DAEMON, FIREWALL, UNIT, DROPIN, REPO, KEY, PIN, POLICY]:
        safe_path(path)
        require(not path.exists(), 'existing managed configuration; refusing to overwrite')
    for directory_path in [Path('/var/lib/docker'), Path('/var/lib/containerd')]:
        require(not directory_path.exists(), 'existing container runtime data; refusing used host')
    packages = list(VERSIONS) + ['docker.io', 'docker-compose', 'podman', 'podman-docker',
                                'containerd', 'runc', 'kubelet']
    for name in packages:
        status = run('dpkg-query', '-W', '-f=${db:Status-Status}', name, allowed=(0, 1))
        require(status != 'installed', 'existing runtime package: ' + name)
    require(not list(Path('/etc/apt/sources.list.d').glob('*docker*')),
            'existing Docker apt repository')
    for service in ['ufw', 'firewalld', 'nftables']:
        require(run('systemctl', 'is-active', service, allowed=(0, 3, 4)) != 'active',
                'existing firewall service: ' + service)
    if shutil.which('nft'):
        require(not run('nft', 'list', 'ruleset'), 'existing nftables rules')
    for tool in ['iptables-save', 'ip6tables-save']:
        if shutil.which(tool):
            check_empty_rules(run(tool))
    check_listeners(run('ss', '-H', '-ltnp'), run('ss', '-H', '-lunp'))
    ssh = os.environ.get('SSH_CONNECTION', '').split()
    require(not ssh or ssh[-1] == '22', 'SSH session uses a non-22 port')
    if shutil.which('sshd'):
        ports = re.findall(r'^port (\d+)$', run('sshd', '-T'), re.M)
        require(ports == ['22'], 'sshd must use only port 22')


def write_new(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as file:
        os.chmod(path, mode)
        file.write(text)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def firewall_snapshot():
    snapshot = {}
    for ipt in ['iptables', 'ip6tables']:
        for chain, target in [('INPUT', 'SAAS-INPUT'), ('FORWARD', 'DOCKER-USER'),
                              ('DOCKER-USER', 'SAAS-DOCKER')]:
            rules = run(ipt, '-w', '-S', chain).splitlines()
            first = next((rule for rule in rules if rule.startswith('-A ')), '')
            require(first == f'-A {chain} -j {target}', 'managed firewall jump changed')
        for chain in ['SAAS-INPUT', 'SAAS-DOCKER']:
            snapshot[ipt + '/' + chain] = run(ipt, '-w', '-S', chain)
    return snapshot


def verify(directory, versions):
    safe_path(STATE)
    state_path = STATE / 'state.json'
    safe_path(state_path)
    state = json.loads(state_path.read_text())
    require(state.get('complete') and state.get('directory') == str(directory) and
            state.get('versions') == versions, 'incomplete/different initialization; inspect manually')
    for path, expected in state['files'].items():
        safe_path(Path(path))
        require(digest(Path(path)) == expected, 'managed configuration changed; inspect manually')
    for name, version in versions.items():
        require(run('dpkg-query', '-W', '-f=${Version}', name) == version,
                'installed package version changed: ' + name)
    require(run('docker', 'version', '--format', '{{.Server.Version}}') == VERSIONS['docker-ce'],
            'Docker server version mismatch')
    require(run('docker', 'compose', 'version', '--short').lstrip('v') == VERSIONS['docker-compose-plugin'],
            'Compose version mismatch')
    require(run('systemctl', 'is-enabled', 'docker') == 'enabled', 'Docker boot startup disabled')
    require(firewall_snapshot() == state['firewall'], 'managed firewall rules changed')
    for path in [directory, directory / 'secrets', directory / 'certs']:
        safe_path(path)
        require(path.is_dir() and path.stat().st_mode & 0o777 == 0o700, 'directory must remain root:0700')
    safe_path(directory / '.env')
    require((directory / '.env').stat().st_mode & 0o777 == 0o600, '.env must remain root:0600')
    check_listeners(run('ss', '-H', '-ltnp'), run('ss', '-H', '-lunp'), initialized=True)


def install(directory, distro, suite, arch, versions):
    STATE.mkdir(mode=0o700)
    write_new(STATE / 'state.json', json.dumps({'complete': False, 'directory': str(directory)}))
    # 首次包安装不能抢先启动无防火墙的Docker，完成本机规则后才显式启动。
    write_new(POLICY, '#!/bin/sh\nexit 101\n', 0o755)
    try:
        run('apt-get', 'update', '-qq')
        run('apt-get', 'install', '-y', '--no-install-recommends', 'ca-certificates', 'curl', 'iptables')
        key = run('curl', '--fail', '--silent', '--show-error', '--proto', '=https', '--tlsv1.2',
                  f'https://download.docker.com/linux/{distro}/gpg')
        write_new(KEY, key + '\n', 0o644)
        write_new(REPO, f'Types: deb\nURIs: https://download.docker.com/linux/{distro}\n'
                  f'Suites: {suite}\nComponents: stable\nArchitectures: {arch}\nSigned-By: {KEY}\n', 0o644)
        run('apt-get', 'update', '-qq')
        run('apt-get', 'install', '-y', '--no-install-recommends',
            *[name + '=' + version for name, version in versions.items()])
        write_new(PIN, '\n'.join(f'Package: {name}\nPin: version {version}\nPin-Priority: 1001\n'
                                for name, version in versions.items()), 0o644)
        write_new(DAEMON, DAEMON_TEXT)
        FIREWALL.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(FIREWALL.parent, 0o700)
        write_new(FIREWALL, (HERE / 'init-firewall.sh').read_text(), 0o700)
        write_new(UNIT, UNIT_TEXT, 0o644)
        write_new(DROPIN, DROPIN_TEXT, 0o644)
        run(str(FIREWALL))
    finally:
        POLICY.unlink()
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', 'product-res-selfhost-firewall.service', 'docker.service')
    directory.mkdir(parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    for child in ['secrets', 'certs']:
        (directory / child).mkdir(mode=0o700)
    # 仅复制同版无真值example，永不source dotenv或读取已有secret。
    write_new(directory / '.env', (HERE / '.env.example').read_text())
    files = [DAEMON, FIREWALL, UNIT, DROPIN, REPO, KEY, PIN]
    state = {'complete': True, 'directory': str(directory), 'versions': versions,
             'files': {str(path): digest(path) for path in files}, 'firewall': firewall_snapshot()}
    (STATE / 'state.json').write_text(json.dumps(state, indent=2) + '\n')
    verify(directory, versions)


def main():
    parser = argparse.ArgumentParser(description='Initialize only a blank Ubuntu24.04/Debian12 host')
    parser.add_argument('--dir', default='/opt/product-res-selfhost', help='empty root-owned deployment directory')
    parser.add_argument('--check', action='store_true', help='read-only preflight/verify, no installation')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'run as root on the explicitly selected empty VM')
    require(sys.platform == 'linux' and Path('/run/systemd/system').is_dir(), 'Linux systemd host required')
    directory = Path(args.dir)
    require(directory != Path('/') and directory.parts[:2] in [('/', 'opt'), ('/', 'srv')]
            and len(directory.parts) >= 3, 'deployment directory must be below /opt or /srv')
    safe_path(directory)
    require(HERE.joinpath('.env.example').is_file(), 'same-release .env.example is required')
    distro, release, suite = supported(Path('/etc/os-release').read_text(), run('dpkg', '--print-architecture'))
    versions = package_versions(distro, release, suite)
    require(os.cpu_count() >= 2, 'at least 2 CPUs required')
    memory = int(re.search(r'^MemTotal:\s+(\d+)', Path('/proc/meminfo').read_text(), re.M)[1])
    require(memory >= 3_750_000, 'at least 4 GiB provisioned RAM required')
    require(shutil.disk_usage('/var/lib').free >= 10 * 1024**3, 'at least 10 GiB free runtime disk required')
    # 只串行化本初始化入口，不参与其他部署锁或结束任何进程。
    with open('/run/product-res-selfhost-init.lock', 'a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if STATE.exists():
            verify(directory, versions)
            print('init-server: existing initialization verified; configuration/data preserved')
            return
        fresh_preflight(directory)
        if args.check:
            print('init-server: blank host preflight passed; no installation performed')
            return
        install(directory, distro, suite, arch=run('dpkg', '--print-architecture'), versions=versions)
    print('init-server: Docker/Compose and firewall ready; configure env, file secrets and TLS before deploy')


if __name__ == '__main__':
    try:
        main()
    except (Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        # 不包含第三方stdout/stderr、配置真值或连接串。
        message = str(error) if isinstance(error, Refused) else type(error).__name__
        print('init-server: refused: ' + message, file=sys.stderr)
        sys.exit(1)
