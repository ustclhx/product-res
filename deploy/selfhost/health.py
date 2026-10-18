#!/usr/bin/env python3
"""有界 readiness 门；响应原文与驱动异常永不进入发布日志。"""
import datetime
import json
import re
import subprocess
import time
import urllib.parse

SHA = re.compile(r'^[a-f0-9]{40}$')


def observed_sha(value):
    return value if isinstance(value, str) and SHA.fullmatch(value) else None


def ready(response, sha):
    body = response.get('body', {})
    if not isinstance(body, dict):
        return False
    if response.get('status') != 200 or body.get('status') != 'ok' or body.get('version') != sha:
        return False
    if any(not isinstance(body.get(name), dict) or body[name].get('status') != 'up'
           for name in ['db', 'cache', 'queue', 'scheduler']):
        return False
    try:
        heartbeat = datetime.datetime.fromisoformat(body['jobs']['lastCronAt'].replace('Z', '+00:00'))
        if heartbeat.tzinfo is None:
            return False
        age = time.time() - heartbeat.timestamp()
        return 0 <= age <= 600
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        return False


def public_probe(url, timeout, env=None):
    parsed = urllib.parse.urlsplit(url)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('health URL must not contain credentials, query or fragment')
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ['localhost', '127.0.0.1', '::1']):
        raise ValueError('public health requires HTTPS; HTTP only for loopback fixtures')
    # curl 默认验证 TLS；每一请求同时受连接与整体期限约束，不跟随重定向。
    result = subprocess.run(['curl', '--silent', '--connect-timeout', str(min(3, timeout)),
                             '--max-time', str(timeout), '--max-filesize', '65536',
                             '--write-out', '\n%{http_code}', url],
                            capture_output=True, timeout=timeout + 1, env=env)
    if result.returncode or len(result.stdout) > 65540:
        return {}
    payload, status = result.stdout.rsplit(b'\n', 1)
    return {'status': int(status), 'body': json.loads(payload)}


def wait_health(sha, web_probe, jobs_probe, timeout=360, interval=5, write=print):
    if not SHA.fullmatch(sha) or timeout <= 0 or interval <= 0:
        raise ValueError('invalid health target or wait bounds')
    deadline = time.monotonic() + timeout
    versions = {'web': None, 'jobs': None}
    while time.monotonic() < deadline:
        results = {}
        for name, probe in [('web', web_probe), ('jobs', jobs_probe)]:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                results[name] = probe(min(8, remaining))
                versions[name] = observed_sha(results[name].get('body', {}).get('version'))
            except (OSError, ValueError, TypeError, AttributeError, subprocess.SubprocessError):
                results[name] = {}
                versions[name] = None
        if all(ready(results.get(name, {}), sha) for name in ['web', 'jobs']):
            write(json.dumps({'event': 'selfhost.health.ready', 'target': sha, **versions}))
            return True
        write(json.dumps({'event': 'selfhost.health.wait', 'target': sha, **versions}))
        time.sleep(min(interval, max(0, deadline - time.monotonic())))
    write(json.dumps({'event': 'selfhost.health.failed', 'target': sha, **versions}))
    return False
