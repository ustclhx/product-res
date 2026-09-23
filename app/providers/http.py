"""Hard-deadline stdlib HTTP execution for provider adapters.

``urllib`` applies its timeout to individual socket operations, so a peer can
keep a request alive indefinitely by sending bytes often enough.  This module
runs the complete DNS/connect/read operation in a short-lived interpreter and
kills and reaps it when one monotonic deadline expires.
"""

from __future__ import annotations

import base64
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class DeadlineHTTPResponse:
    status_code: int
    headers: Mapping[str, str]
    body: bytes


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


def _is_timeout(exc: BaseException) -> bool:
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return True
    return isinstance(exc, urllib.error.URLError) and isinstance(
        exc.reason, (TimeoutError, socket.timeout)
    )


def _worker() -> int:
    """Read one request from stdin and emit one bounded JSON response."""

    try:
        raw = json.load(sys.stdin)
        body_value = raw.get("body")
        body = base64.b64decode(body_value, validate=True) if body_value is not None else None
        request = urllib.request.Request(
            url=str(raw["url"]),
            data=body,
            headers={str(key): str(value) for key, value in raw["headers"].items()},
            method=str(raw["method"]),
        )
        opener = urllib.request.build_opener(_NoRedirect())
        limit = int(raw["max_response_bytes"])
        socket_timeout = float(raw["socket_timeout_seconds"])
        try:
            try:
                with opener.open(request, timeout=socket_timeout) as response:
                    payload = response.read(limit + 1)
                    result = {
                        "kind": "response",
                        "status_code": int(response.status),
                        "headers": {
                            str(key): str(value) for key, value in response.headers.items()
                        },
                        "body": base64.b64encode(payload).decode("ascii"),
                    }
            except urllib.error.HTTPError as exc:
                payload = exc.read(limit + 1)
                result = {
                    "kind": "response",
                    "status_code": int(exc.code),
                    "headers": {
                        str(key): str(value)
                        for key, value in (exc.headers.items() if exc.headers else [])
                    },
                    "body": base64.b64encode(payload).decode("ascii"),
                }
        except (OSError, urllib.error.URLError) as exc:
            result = {"kind": "error", "timeout": _is_timeout(exc)}
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        result = {"kind": "error", "timeout": False}
    json.dump(result, sys.stdout, separators=(",", ":"))
    return 0


def request_with_deadline(
    method: str,
    url: str,
    *,
    headers: Mapping[str, str],
    body: bytes | None,
    timeout_seconds: float,
    max_response_bytes: int,
) -> DeadlineHTTPResponse:
    """Execute one request under a process-enforced monotonic deadline."""

    started = time.monotonic()
    if timeout_seconds <= 0:
        raise TimeoutError("provider request deadline expired")
    encoded = json.dumps(
        {
            "method": method,
            "url": url,
            "headers": dict(headers),
            "body": base64.b64encode(body).decode("ascii") if body is not None else None,
            "socket_timeout_seconds": timeout_seconds,
            "max_response_bytes": max_response_bytes,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    process = subprocess.Popen(
        [sys.executable, "-m", "app.providers.http", "--worker"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        cwd=Path(__file__).resolve().parents[2],
    )
    remaining = timeout_seconds - (time.monotonic() - started)
    if remaining <= 0:
        process.kill()
        process.communicate()
        raise TimeoutError("provider request deadline expired")
    try:
        stdout, _ = process.communicate(encoded, timeout=remaining)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.communicate()
        raise TimeoutError("provider request deadline expired") from exc
    except BaseException:
        process.kill()
        process.communicate()
        raise
    if process.returncode != 0:
        raise OSError("provider request process failed")
    try:
        result = json.loads(stdout)
        if not isinstance(result, dict):
            raise OSError("provider request process returned an invalid response")
        if result.get("kind") == "error":
            if result.get("timeout") is True:
                raise TimeoutError("provider socket operation timed out")
            raise OSError("provider request failed")
        return DeadlineHTTPResponse(
            status_code=int(result["status_code"]),
            headers={str(key): str(value) for key, value in result["headers"].items()},
            body=base64.b64decode(result["body"], validate=True),
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise OSError("provider request process returned an invalid response") from exc


if __name__ == "__main__" and len(sys.argv) == 2 and sys.argv[1] == "--worker":
    raise SystemExit(_worker())
