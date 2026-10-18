"""独立 S3 原始对象复制；不解压、不使用 ETag 作为内容 checksum、不传播删除。"""
import datetime as dt
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import tempfile
import time
from urllib.parse import quote, urlsplit
import xml.etree.ElementTree as ET

from walg import BackupError, _environment
from retention import _wal, timestamp

CHUNK = 1024 * 1024
LAYOUT = ('basebackups_005/', 'wal_005/', 'logical/')
MANIFEST = 'replica/manifest.json'


def enabled():
    value = os.environ.get('BACKUP_REPLICA_ENABLED', 'false')
    if value not in ('true', 'false'):
        raise BackupError('REPLICA_INVALID_ENABLED')
    return value == 'true'


def configuration(replica=False):
    if not replica:
        return _environment()
    # 显式重建第二身份；不允许缺省回退到主目标或共享 AWS profile。
    settings = {key.replace('BACKUP_REPLICA_', 'BACKUP_', 1): value
                for key, value in os.environ.items() if key.startswith('BACKUP_REPLICA_')}
    return _environment(settings)


class S3:
    def __init__(self, config, role='primary'):
        self.config = config
        self.role = role
        self.endpoint = urlsplit(config['AWS_ENDPOINT'])
        location = urlsplit(config['WALG_S3_PREFIX'])
        self.bucket = location.netloc
        self.prefix = location.path.lstrip('/').rstrip('/') + '/'
        self.host = self.endpoint.hostname
        self.port = self.endpoint.port
        self.path_style = config['AWS_S3_FORCE_PATH_STYLE'] == 'true'
        if not self.path_style:
            self.host = self.bucket + '.' + self.host
        self.context = ssl.create_default_context(cafile=config.get('AWS_CA_BUNDLE'))
        self.rate = int(config['WALG_NETWORK_RATE_LIMIT'])
        self.chunk = min(CHUNK, self.rate)

    def request(self, method, key='', query=None, body=None, digest=None, size=0):
        path = '/' + (self.bucket + '/' if self.path_style else '') + self.prefix + key
        if query is not None:
            path = '/' + (self.bucket + '/' if self.path_style else '')
        path = quote(path, safe='/~')
        canonical_query = '&'.join(quote(k, safe='~') + '=' + quote(str(v), safe='~')
                                   for k, v in sorted((query or {}).items()))
        current = dt.datetime.now(dt.timezone.utc)
        date, instant = current.strftime('%Y%m%d'), current.strftime('%Y%m%dT%H%M%SZ')
        payload = digest or hashlib.sha256(b'').hexdigest()
        host = self.host + (':' + str(self.port) if self.port else '')
        headers = {'host': host, 'x-amz-content-sha256': payload, 'x-amz-date': instant}
        signed = ';'.join(sorted(headers))
        canonical = '\n'.join([method, path, canonical_query,
                              ''.join(k + ':' + headers[k] + '\n' for k in sorted(headers)), signed, payload])
        region = self.config['AWS_REGION']
        scope = date + '/' + region + '/s3/aws4_request'
        sign = lambda key, value: hmac.new(key, value.encode(), hashlib.sha256).digest()
        signing = ('AWS4' + self.config['AWS_SECRET_ACCESS_KEY']).encode()
        for part in (date, region, 's3', 'aws4_request'):
            signing = sign(signing, part)
        signature = sign(signing, 'AWS4-HMAC-SHA256\n' + instant + '\n' + scope + '\n' +
                         hashlib.sha256(canonical.encode()).hexdigest()).hex()
        headers['authorization'] = ('AWS4-HMAC-SHA256 Credential=' + self.config['AWS_ACCESS_KEY_ID'] +
                                    '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + signature)
        if method == 'PUT':
            headers['content-length'] = str(size)
        connection = None
        if body is not None:
            stream = body
            def throttled_upload():
                started, transferred = time.monotonic(), 0
                while data := stream.read(self.chunk):
                    transferred += len(data)
                    delay = transferred / self.rate - (time.monotonic() - started)
                    if delay > 0:
                        time.sleep(delay)
                    yield data
            body = throttled_upload()
        stage = 'request'
        try:
            if self.endpoint.scheme == 'https':
                connection = http.client.HTTPSConnection(self.host, self.port, timeout=30, context=self.context)
            else:
                connection = http.client.HTTPConnection(self.host, self.port, timeout=30)
            connection.request(method, path + ('?' + canonical_query if canonical_query else ''),
                               body=body, headers=headers)
            stage = 'response_headers'
            response = connection.getresponse()
            if response.status == 404 and method == 'GET':
                response.close()
                connection.close()
                return None, None
            if response.status not in (200, 201, 204):
                raise BackupError('REPLICA_S3_HTTP_' + str(response.status))
            return connection, response
        except BackupError:
            if connection:
                connection.close()
            raise
        except (OSError, http.client.HTTPException) as error:
            if connection:
                connection.close()
            if isinstance(error, ssl.SSLError):
                code = 'REPLICA_S3_TLS_FAILED'
            elif isinstance(error, socket.gaierror):
                code = 'REPLICA_S3_DNS_FAILED'
            elif isinstance(error, ConnectionRefusedError):
                code = 'REPLICA_S3_CONNECTION_REFUSED'
            elif isinstance(error, TimeoutError):
                code = 'REPLICA_S3_TIMEOUT'
            else:
                code = 'REPLICA_S3_REQUEST_FAILED'
            # 不记录端点、对象key、签名或原始异常；区分请求发送与响应头等待超时。
            print(json.dumps({'event': 'selfhost.backup.replica.request.failed', 'ok': False,
                              'level': 'error', 'code': code, 'target': self.role,
                              'method': method, 'stage': stage, 'objectBytes': size}), flush=True)
            raise BackupError(code) from None

    def list(self):
        result, token = {}, None
        while True:
            query = {'list-type': '2', 'prefix': self.prefix}
            if token:
                query['continuation-token'] = token
            connection, response = self.request('GET', query=query)
            try:
                root = ET.fromstring(response.read())
                for item in root.findall('{*}Contents'):
                    key = item.findtext('{*}Key')
                    if not key or not key.startswith(self.prefix):
                        raise ValueError()
                    relative = key[len(self.prefix):]
                    if relative.startswith(LAYOUT):
                        if relative in result or any(part in ('.', '..') for part in relative.split('/')):
                            raise ValueError()
                        result[relative] = int(item.findtext('{*}Size'))
                token = root.findtext('{*}NextContinuationToken')
                if root.findtext('{*}IsTruncated') != 'true':
                    break
                if not token or token == query.get('continuation-token'):
                    raise ValueError()
            except (ValueError, TypeError, ET.ParseError, OSError, http.client.HTTPException):
                raise BackupError('REPLICA_INVENTORY_INVALID') from None
            finally:
                response.close()
                connection.close()
        return result

    def get(self, key, output=None):
        connection, response = self.request('GET', key)
        if response is None:
            return None
        digest, size = hashlib.sha256(), 0
        started = time.monotonic()
        try:
            while data := response.read(self.chunk):
                size += len(data)
                delay = size / self.rate - (time.monotonic() - started)
                if delay > 0:
                    time.sleep(delay)
                digest.update(data)
                if output:
                    output.write(data)
            if size != int(response.getheader('content-length')):
                raise ValueError()
            return {'bytes': size, 'sha256': digest.hexdigest()}
        except (OSError, ValueError, TypeError, http.client.HTTPException):
            raise BackupError('REPLICA_DOWNLOAD_FAILED') from None
        finally:
            response.close()
            connection.close()

    def put(self, key, stream, record):
        stream.seek(0)
        connection, response = self.request('PUT', key, body=stream,
                                            digest=record['sha256'], size=record['bytes'])
        response.close()
        connection.close()


def check_chain(records, inventory, verification):
    # 源验证时间是PG提交+切段的保守上界，复制wall clock不能变成恢复点。
    first_tli, first = _wal(inventory['preserveFromWal'])
    last_tli, last = _wal(verification['lastWal'])
    if first_tli != last_tli or last < first:
        raise BackupError('REPLICA_CHAIN_INVALID')
    segments = set()
    for key in records:
        match = re.fullmatch(r'wal_005/([0-9A-F]{24})(?:\.(?:lz4|zst|br|gz))?', key)
        if match:
            timeline, segment = _wal(match[1])
            if timeline == first_tli and first <= segment <= last:
                segments.add(segment)
    if len(segments) != last - first + 1:
        raise BackupError('REPLICA_WAL_GAP')
    for backup_id in inventory['retained']:
        if not any(key.startswith('basebackups_005/' + backup_id + '/') for key in records):
            raise BackupError('REPLICA_BASE_MISSING')
        if 'basebackups_005/' + backup_id + '_backup_stop_sentinel.json' not in records:
            raise BackupError('REPLICA_BASE_MISSING')


def sync(inventory, verification, temporary, source=None, target=None):
    if verification.get('ok') is not True:
        raise BackupError('REPLICA_SOURCE_NOT_VERIFIED')
    source = source or S3(configuration())
    target = target or S3(configuration(True), role='replica')
    if (source.endpoint == target.endpoint and source.bucket == target.bucket
            and (source.prefix.startswith(target.prefix) or target.prefix.startswith(source.prefix))):
        raise BackupError('REPLICA_TARGET_OVERLAPS_SOURCE')
    temporary = Path(temporary)
    temporary.mkdir(mode=0o700, parents=True, exist_ok=True)
    listing = source.list()
    copied = 0
    source_records = {}
    for key, size in sorted(listing.items()):
        if shutil.disk_usage(temporary).free < size + 16 * 1024 * 1024:
            raise BackupError('REPLICA_NO_TEMP_SPACE')
        with tempfile.TemporaryFile(dir=temporary) as stream:
            record = source.get(key, stream)
            if record is None or record['bytes'] != size:
                raise BackupError('REPLICA_SOURCE_CHANGED')
            if target.get(key) != record:
                target.put(key, stream, record)
                copied += 1
            if target.get(key) != record:
                raise BackupError('REPLICA_CHECKSUM_MISMATCH')
            source_records[key] = record
    check_chain(source_records, inventory, verification)
    # 保留源端已删除的对象，并将目标的真实完整对象清单纳入manifest。
    records = {}
    for key, size in sorted(target.list().items()):
        record = target.get(key)
        if record is None or record['bytes'] != size or key in source_records and record != source_records[key]:
            raise BackupError('REPLICA_TARGET_CHANGED')
        records[key] = record
    check_chain(records, inventory, verification)
    finished = dt.datetime.now(dt.timezone.utc)
    bound = timestamp(verification['continuousUntil'])
    if bound > finished:
        raise BackupError('REPLICA_BOUND_IN_FUTURE')
    result = {'configured': True, 'ok': True, 'clusterId': inventory['clusterId'],
              'timeline': inventory['timeline'], 'backupId': inventory['latest'],
              'oldestBackupId': inventory['oldest'], 'continuousUntil': verification['continuousUntil'],
              'lastWal': verification['lastWal'], 'lastSuccess': finished.isoformat(),
              'syncLagSeconds': (finished - bound).total_seconds(), 'copiedObjects': copied,
              'objectCount': len(records), 'retention': 'retain-all-independent'}
    raw = json.dumps({'version': 1, **result, 'objects': [dict(key=key, **record)
                                                     for key, record in records.items()]}, sort_keys=True).encode()
    with tempfile.TemporaryFile(dir=temporary) as stream:
        stream.write(raw)
        digest = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        target.put(MANIFEST, stream, digest)
        if target.get(MANIFEST) != digest:
            raise BackupError('REPLICA_MANIFEST_CHECKSUM_MISMATCH')
    return {**result, 'manifestSha256': digest['sha256']}
