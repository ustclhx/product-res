"""文件 secret 与受限环境的 WAL-G 边界；原始诊断不进入运维日志。"""

import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit


class BackupError(Exception):
    """只包含固定错误码，调用方可安全记录。"""


def _secret(name, settings=None):
    settings = os.environ if settings is None else settings
    try:
        if name.removesuffix('_FILE') in settings:
            raise ValueError
        value = Path(settings[name]).read_bytes().decode('utf-8').removesuffix('\n')
        if not value or len(value) > 4096 or any(c in value for c in '\r\n\0'):
            raise ValueError
        return value
    except (OSError, KeyError, ValueError):
        raise BackupError('invalid-secret-file') from None


def _positive(name, default, settings=None):
    settings = os.environ if settings is None else settings
    value = settings.get(name, str(default))
    if not re.fullmatch(r'[1-9][0-9]*', value):
        raise BackupError('invalid-resource-limit')
    return value


def _environment(settings=None):
    settings = os.environ if settings is None else settings
    endpoint = settings.get('BACKUP_S3_ENDPOINT', '')
    try:
        parsed = urlsplit(endpoint)
        if (any(ord(c) < 32 for c in endpoint)
                or parsed.scheme not in ('https', 'http') or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ('', '/') or not parsed.port and endpoint.endswith(':')):
            raise ValueError
    except ValueError:
        raise BackupError('invalid-s3-endpoint') from None
    if parsed.scheme == 'http' and settings.get('BACKUP_ALLOW_HTTP') != 'true':
        raise BackupError('s3-https-required')
    prefix = settings.get('BACKUP_S3_PREFIX', '')
    if not re.fullmatch(r's3://[a-z0-9][a-z0-9.-]+/[A-Za-z0-9_./-]+', prefix):
        raise BackupError('invalid-s3-prefix')
    if any(part in ('.', '..') for part in prefix[5:].split('/')):
        raise BackupError('invalid-s3-prefix')
    region = settings.get('BACKUP_S3_REGION', '')
    if not re.fullmatch(r'[A-Za-z0-9-]+', region):
        raise BackupError('invalid-s3-region')
    path_style = settings.get('BACKUP_S3_FORCE_PATH_STYLE', 'true')
    if path_style not in ('true', 'false'):
        raise BackupError('invalid-s3-path-style')
    # 白名单重建，避免共享 AWS profile、代理或应用环境提供另一组凭据。
    env = {
        'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/nonexistent', 'LANG': 'C.UTF-8',
        'TMPDIR': settings.get('BACKUP_TMP_DIR', '/var/lib/selfhost-backup/tmp'),
        'PGHOST': '/var/run/postgresql', 'PGPORT': '5432', 'PGUSER': 'postgres',
        'PGDATABASE': settings.get('POSTGRES_DB', 'product_res_production'),
        'PGCONNECT_TIMEOUT': '10', 'PGAPPNAME': 'selfhost-backup',
        'AWS_ENDPOINT': endpoint, 'AWS_REGION': region,
        'AWS_S3_FORCE_PATH_STYLE': path_style, 'WALG_S3_PREFIX': prefix,
        'AWS_ACCESS_KEY_ID': _secret('BACKUP_S3_ACCESS_KEY_ID_FILE', settings),
        'AWS_SECRET_ACCESS_KEY': _secret('BACKUP_S3_SECRET_ACCESS_KEY_FILE', settings),
        'AWS_EC2_METADATA_DISABLED': 'true', 'AWS_SHARED_CREDENTIALS_FILE': '/dev/null',
        'AWS_CONFIG_FILE': '/dev/null', 'AWS_SDK_LOAD_CONFIG': 'false',
        'WALG_COMPRESSION_METHOD': 'lz4', 'WALG_DELTA_MAX_STEPS': '0',
        'WALG_UPLOAD_CONCURRENCY': '1', 'WALG_UPLOAD_DISK_CONCURRENCY': '1',
        'WALG_DOWNLOAD_CONCURRENCY': '1', 'WALG_S3_MAX_RETRIES': '2',
        'WALG_DISK_RATE_LIMIT': _positive('BACKUP_DISK_RATE_LIMIT', 20971520, settings),
        'WALG_NETWORK_RATE_LIMIT': _positive('BACKUP_NETWORK_RATE_LIMIT', 10485760, settings),
        'WALG_LOG_LEVEL': 'ERROR',
    }
    ca_file = settings.get('BACKUP_S3_CA_FILE')
    if ca_file:
        if '\0' in ca_file or not Path(ca_file).is_file() or not os.access(ca_file, os.R_OK):
            raise BackupError('invalid-s3-ca-file')
        env['WALG_S3_CA_CERT_FILE'] = ca_file
        env['AWS_CA_BUNDLE'] = ca_file
    return env


def invoke(args, timeout=120):
    """调用固定二进制，成功返回 stdout，失败抛无敏感内容的 BackupError。"""
    if (not isinstance(args, (list, tuple)) or not args
            or any(not isinstance(arg, str) or '\0' in arg for arg in args)):
        raise BackupError('invalid-walg-arguments')
    for arg in args:
        option = arg.split('=', 1)[0].lower()
        if (option in ('-c', '--config', '--config-file')
                or option.startswith('--') and re.search(r'credential|password|access.key|secret|token', option)
                or re.search(r'^[A-Z_]*(?:SECRET|PASSWORD|TOKEN|ACCESS_KEY)[A-Z_]*=', arg)
                or re.search(r'://[^/]*@', arg)):
            raise BackupError('credentials-in-arguments')
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 86400:
        raise BackupError('invalid-walg-timeout')
    env = _environment()
    try:
        result = subprocess.run(['/usr/local/bin/wal-g', *args], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise BackupError('walg-timeout') from None
    except (OSError, UnicodeError):
        raise BackupError('walg-execution-failed') from None
    if result.returncode != 0:
        raise BackupError('walg-command-failed')
    output = result.stdout
    for name in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT', 'WALG_S3_PREFIX'):
        output = output.replace(env[name], '[redacted]')
    return output


def _archive_status(wal, success):
    directory = Path(os.environ.get('BACKUP_STATE_DIR', '/var/lib/selfhost-backup'))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (directory / 'archive.lock').open('a') as lock:
        os.chmod(directory / 'archive.lock', 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = directory / 'archive.json'
        state = json.loads(path.read_text()) if path.exists() else {}
        if not isinstance(state, dict):
            raise ValueError('invalid-archive-state')
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        key = 'successes' if success else 'failures'
        state[key] = state.get(key, 0) + 1
        state['lastSuccess' if success else 'lastFailure'] = now
        state['consecutiveFailures'] = 0 if success else state.get('consecutiveFailures', 0) + 1
        if re.fullmatch(r'[0-9A-F]{24}(?:\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history', wal):
            state['lastWal' if success else 'lastFailedWal'] = wal
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=directory, delete=False) as file:
                temporary = file.name
                os.chmod(temporary, 0o600)
                json.dump(state, file, sort_keys=True)
                file.write('\n')
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
            temporary = None
            descriptor = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        finally:
            if temporary:
                os.unlink(temporary)


def main(args):
    archive = bool(args and args[0] == 'wal-push')
    success = False
    try:
        output = invoke(args, timeout=60 if archive else 120)
        success = True
    except BackupError:
        output = ''
    if archive:
        try:
            _archive_status(Path(args[1]).name if len(args) > 1 else '', success)
        except (OSError, ValueError, TypeError):
            success = False
        print('selfhost-backup: archive-success' if success else 'selfhost-backup: archive-failed')
    elif success:
        print(output, end='')
    else:
        print('selfhost-backup: walg-failed', file=sys.stderr)
    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
