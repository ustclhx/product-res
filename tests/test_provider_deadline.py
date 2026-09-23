from __future__ import annotations

import contextlib
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from app.providers.market import ProviderError, UrllibTransport
from app.providers.newapi import NewAPIAdapter, NewAPIConfig, NewAPIError, StdlibHTTPTransport

DEADLINE_SECONDS = 0.75


class _SlowHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        server = self.server
        assert isinstance(server, _TestServer)
        with server.count_lock:
            server.request_count += 1
        status = 500 if self.path == "/slow-error" else 200
        payload = b"x" * 20
        self.send_response(status)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        for byte in payload:
            try:
                self.wfile.write(bytes((byte,)))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
            time.sleep(0.08)

    def log_message(self, format: str, *args: object) -> None:
        return


class _TestServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address: tuple[str, int]) -> None:
        super().__init__(server_address, _SlowHandler)
        self.count_lock = threading.Lock()
        self.request_count = 0


@contextlib.contextmanager
def _slow_server() -> Iterator[tuple[str, _TestServer]]:
    server = _TestServer(("127.0.0.1", 0))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}", server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)


@pytest.mark.parametrize("path", ["/slow-success", "/slow-error"])
def test_newapi_transport_enforces_one_deadline_across_the_entire_response(path: str) -> None:
    with _slow_server() as (base_url, server):
        started = time.monotonic()
        with pytest.raises(TimeoutError):
            StdlibHTTPTransport().request(
                "GET",
                base_url + path,
                headers={},
                body=None,
                timeout_seconds=DEADLINE_SECONDS,
                max_response_bytes=1_024,
            )
        elapsed = time.monotonic() - started

    assert server.request_count == 1
    assert elapsed < 1.3


@pytest.mark.parametrize("path", ["/slow-success", "/slow-error"])
def test_market_transport_enforces_one_deadline_across_the_entire_response(path: str) -> None:
    with _slow_server() as (base_url, server):
        started = time.monotonic()
        with pytest.raises(ProviderError) as caught:
            UrllibTransport().request(
                "GET",
                base_url + path,
                headers={},
                body=None,
                timeout=DEADLINE_SECONDS,
                max_bytes=1_024,
            )
        elapsed = time.monotonic() - started

    assert caught.value.code == "unknown"
    assert server.request_count == 1
    assert elapsed < 1.3


def test_newapi_timeout_after_dispatch_is_outcome_unknown_and_is_not_retried(tmp_path) -> None:
    secret = tmp_path / "newapi-secret"
    secret.write_text("secret", encoding="utf-8")
    with _slow_server() as (base_url, server):
        adapter = NewAPIAdapter(
            NewAPIConfig(
                base_url=base_url,
                trusted_hosts=frozenset({"127.0.0.1"}),
                secret_file=secret,
                model="test-model",
                timeout_seconds=DEADLINE_SECONDS,
                max_requests=1,
                allow_http=True,
            )
        )
        with pytest.raises(NewAPIError) as caught:
            adapter.models()

    assert caught.value.code == "NEWAPI.TIMEOUT"
    assert caught.value.metadata == {"retryable": False, "outcome_unknown": True}
    assert server.request_count == 1
