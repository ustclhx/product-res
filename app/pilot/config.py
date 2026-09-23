"""Validated process configuration for separate demo and pilot runtimes."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast
from urllib.parse import urlsplit

RuntimeMode = Literal["demo", "pilot"]


@dataclass(frozen=True, slots=True)
class Settings:
    mode: RuntimeMode
    data_dir: Path
    public_url: str
    demo_db_path: Path | None
    control_db_path: Path | None
    workspaces_dir: Path | None
    session_ttl_seconds: int = 12 * 60 * 60
    login_window_seconds: int = 15 * 60
    login_max_failures: int = 5

    @classmethod
    def from_env(cls, *, db_path: str | Path | None = None) -> Settings:
        raw_mode = os.environ.get("PRODUCT_RES_MODE", "demo").strip().lower()
        if raw_mode not in {"demo", "pilot"}:
            raise RuntimeError("PRODUCT_RES_MODE must be 'demo' or 'pilot'")
        mode = cast(RuntimeMode, raw_mode)

        configured_data_dir = os.environ.get("PRODUCT_RES_DATA_DIR")
        if mode == "pilot" and not configured_data_dir:
            raise RuntimeError("pilot mode requires PRODUCT_RES_DATA_DIR")
        data_dir = Path(
            configured_data_dir
            or Path(__file__).resolve().parents[2] / ".local"
        ).expanduser().resolve()

        configured_public_url = os.environ.get("PRODUCT_RES_PUBLIC_URL")
        if mode == "pilot" and not configured_public_url:
            raise RuntimeError("pilot mode requires PRODUCT_RES_PUBLIC_URL")
        public_url = _validated_public_url(configured_public_url or "http://localhost")

        if mode == "pilot":
            if db_path is not None or os.environ.get("PRODUCT_RES_DB"):
                raise RuntimeError(
                    "pilot databases are selected by the workspace registry; "
                    "PRODUCT_RES_DB/db_path is forbidden"
                )
            return cls(
                mode=mode,
                data_dir=data_dir,
                public_url=public_url,
                demo_db_path=None,
                control_db_path=data_dir / "control.sqlite3",
                workspaces_dir=data_dir / "workspaces",
                session_ttl_seconds=_positive_int_env("PRODUCT_RES_SESSION_TTL_SECONDS", 43_200),
                login_window_seconds=_positive_int_env("PRODUCT_RES_LOGIN_WINDOW_SECONDS", 900),
                login_max_failures=_positive_int_env("PRODUCT_RES_LOGIN_MAX_FAILURES", 5),
            )

        resolved_db_path = Path(
            db_path or os.environ.get("PRODUCT_RES_DB") or data_dir / "workspace.sqlite3"
        ).expanduser().resolve()
        return cls(
            mode=mode,
            data_dir=data_dir,
            public_url=public_url,
            demo_db_path=resolved_db_path,
            control_db_path=None,
            workspaces_dir=None,
        )

    @property
    def public_origin(self) -> str:
        parsed = urlsplit(self.public_url)
        return f"{parsed.scheme}://{parsed.netloc}"

    @property
    def secure_cookie(self) -> bool:
        return urlsplit(self.public_url).scheme == "https"


def _positive_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a positive integer") from exc
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive integer")
    return value


def _validated_public_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    parsed = urlsplit(normalized)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise RuntimeError(
            "PRODUCT_RES_PUBLIC_URL must be an http(s) origin without credentials or path"
        )
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" and host not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError("pilot public URL must use HTTPS except on loopback")
    return normalized
