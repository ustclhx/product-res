"""Server-side pilot users, memberships, sessions, and authentication routes."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
import threading
from collections.abc import Callable, Iterator
from contextlib import closing, contextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from app.core import DomainError
from app.persistence.store import Store
from app.pilot.config import Settings
from app.pilot.context import RequestIdentity, WorkspaceMember, current_identity

SESSION_COOKIE = "product_res_session"
CSRF_HEADER = "X-CSRF-Token"
MEMBER_ROLES = frozenset({"analyst", "decision", "contributor"})
_USERNAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{2,99}$")
_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$")
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1

router = APIRouter(prefix="/auth", tags=["pilot-auth"])


@dataclass(frozen=True, slots=True)
class WorkspaceRecord:
    id: str
    name: str
    slug: str
    business_db_path: Path
    active: bool


class LoginCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    username: str = Field(min_length=3, max_length=100)
    password: str = Field(min_length=1, max_length=1024)
    workspace_id: str | None = Field(default=None, min_length=1, max_length=100)


class SwitchWorkspaceCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    workspace_id: str = Field(min_length=1, max_length=100)


class ControlStore:
    """Control-plane SQLite repository; business rows never live in this database."""

    def __init__(self, path: str | Path, workspaces_dir: str | Path):
        self.path = Path(path).expanduser().resolve()
        self.workspaces_dir = Path(workspaces_dir).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.workspaces_dir.mkdir(parents=True, exist_ok=True)
        self._stores: dict[str, Store] = {}
        self._stores_lock = threading.Lock()
        self._migrate()

    def _connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.path), timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        return connection

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self._connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _migrate(self) -> None:
        with closing(self._connection()) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            try:
                connection.execute("BEGIN IMMEDIATE")
                has_version_table = connection.execute(
                    """
                    SELECT 1 FROM sqlite_master
                    WHERE type='table' AND name='control_schema_version'
                    """
                ).fetchone()
                if not has_version_table:
                    for statement in (
                        "CREATE TABLE control_schema_version (version INTEGER PRIMARY KEY)",
                        """
                        CREATE TABLE users (
                            id TEXT PRIMARY KEY,
                            username TEXT NOT NULL UNIQUE,
                            display_name TEXT NOT NULL,
                            password_hash TEXT NOT NULL,
                            active INTEGER NOT NULL CHECK(active IN (0,1)),
                            created_at TEXT NOT NULL
                        )
                        """,
                        """
                        CREATE TABLE workspaces (
                            id TEXT PRIMARY KEY,
                            name TEXT NOT NULL,
                            slug TEXT NOT NULL UNIQUE,
                            business_db_path TEXT NOT NULL UNIQUE,
                            active INTEGER NOT NULL CHECK(active IN (0,1)),
                            created_at TEXT NOT NULL
                        )
                        """,
                        """
                        CREATE TABLE memberships (
                            workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                            user_id TEXT NOT NULL REFERENCES users(id),
                            role TEXT NOT NULL CHECK(role IN ('analyst','decision','contributor')),
                            active INTEGER NOT NULL CHECK(active IN (0,1)),
                            created_at TEXT NOT NULL,
                            PRIMARY KEY(workspace_id,user_id)
                        )
                        """,
                        """
                        CREATE TABLE sessions (
                            id TEXT PRIMARY KEY,
                            token_hash TEXT NOT NULL UNIQUE,
                            csrf_hash TEXT NOT NULL,
                            user_id TEXT NOT NULL REFERENCES users(id),
                            workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                            created_at TEXT NOT NULL,
                            expires_at TEXT NOT NULL,
                            revoked_at TEXT
                        )
                        """,
                        """
                        CREATE INDEX sessions_user_workspace
                        ON sessions(user_id,workspace_id,expires_at)
                        """,
                        """
                        CREATE TABLE login_attempts (
                            id TEXT PRIMARY KEY,
                            username TEXT NOT NULL,
                            remote_ip TEXT NOT NULL,
                            attempted_at TEXT NOT NULL,
                            succeeded INTEGER NOT NULL CHECK(succeeded IN (0,1))
                        )
                        """,
                        """
                        CREATE INDEX login_attempt_window
                        ON login_attempts(username,remote_ip,attempted_at)
                        """,
                    ):
                        connection.execute(statement)
                    connection.execute("INSERT INTO control_schema_version VALUES (1)")
                versions = connection.execute(
                    "SELECT version FROM control_schema_version ORDER BY version"
                ).fetchall()
                current_versions = [row[0] for row in versions]
                if current_versions == [2]:
                    connection.commit()
                    return
                if current_versions != [1]:
                    raise RuntimeError("incompatible pilot control database schema")
                connection.execute(
                    """
                    ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0
                    CHECK(is_admin IN (0,1))
                    """
                )
                connection.execute(
                    """
                    ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1
                    CHECK(version >= 1)
                    """
                )
                connection.execute(
                    """
                    CREATE TABLE control_audit (
                        id TEXT PRIMARY KEY,
                        actor_user_id TEXT NOT NULL REFERENCES users(id),
                        action TEXT NOT NULL,
                        target_user_id TEXT NOT NULL REFERENCES users(id),
                        created_at TEXT NOT NULL
                    )
                    """
                )
                connection.execute(
                    """
                    CREATE INDEX control_audit_target_time
                    ON control_audit(target_user_id,created_at)
                    """
                )
                connection.execute("UPDATE control_schema_version SET version=2 WHERE version=1")
                connection.commit()
            except Exception:
                if connection.in_transaction:
                    connection.rollback()
                raise
            versions = connection.execute(
                "SELECT version FROM control_schema_version ORDER BY version"
            ).fetchall()
            if [row[0] for row in versions] != [2]:
                raise RuntimeError("incompatible pilot control database schema")

    def create_user(self, username: str, display_name: str, password: str) -> dict[str, str]:
        normalized = _normalize_username(username)
        shown_name = display_name.strip()
        if not shown_name or len(shown_name) > 200:
            raise ValueError("display name must contain 1-200 characters")
        password_hash = hash_password(password)
        user_id = str(uuid4())
        now = _utc_now().isoformat()
        try:
            with self.transaction() as connection:
                connection.execute(
                    """
                    INSERT INTO users(id,username,display_name,password_hash,active,created_at)
                    VALUES (?,?,?,?,1,?)
                    """,
                    (user_id, normalized, shown_name, password_hash, now),
                )
        except sqlite3.IntegrityError as exc:
            raise ValueError("username already exists") from exc
        return {"id": user_id, "username": normalized, "name": shown_name}

    def init_workspace(self, slug: str, name: str) -> WorkspaceRecord:
        normalized_slug = slug.strip().lower()
        if not _SLUG.fullmatch(normalized_slug):
            raise ValueError("workspace slug must be 3-64 lowercase letters, digits, or hyphens")
        shown_name = name.strip()
        if not shown_name or len(shown_name) > 200:
            raise ValueError("workspace name must contain 1-200 characters")
        workspace_id = str(uuid4())
        path = self._validated_workspace_path(self.workspaces_dir / f"{normalized_slug}.sqlite3")
        if path.exists():
            raise ValueError("workspace database path already exists")

        # Store creates the schema and an immutable pilot marker before registration.
        Store(path, mode="pilot", workspace_id=workspace_id)
        now = _utc_now().isoformat()
        try:
            with self.transaction() as connection:
                connection.execute(
                    "INSERT INTO workspaces VALUES (?,?,?,?,1,?)",
                    (workspace_id, shown_name, normalized_slug, str(path), now),
                )
        except sqlite3.IntegrityError as exc:
            raise ValueError("workspace slug or database path already exists") from exc
        return WorkspaceRecord(workspace_id, shown_name, normalized_slug, path, True)

    def add_member(self, workspace: str, username: str, role: str) -> dict[str, str]:
        normalized_role = role.strip().lower()
        if normalized_role not in MEMBER_ROLES:
            raise ValueError("role must be analyst, decision, or contributor")
        normalized_username = _normalize_username(username)
        with self.transaction() as connection:
            workspace_row = connection.execute(
                "SELECT * FROM workspaces WHERE (id=? OR slug=?) AND active=1",
                (workspace, workspace),
            ).fetchone()
            user_row = connection.execute(
                "SELECT * FROM users WHERE username=? AND active=1", (normalized_username,)
            ).fetchone()
            if workspace_row is None:
                raise ValueError("active workspace not found")
            if user_row is None:
                raise ValueError("active user not found")
            connection.execute(
                """
                INSERT INTO memberships VALUES (?,?,?,1,?)
                ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,active=1
                """,
                (
                    workspace_row["id"],
                    user_row["id"],
                    normalized_role,
                    _utc_now().isoformat(),
                ),
            )
        return {
            "workspace_id": str(workspace_row["id"]),
            "user_id": str(user_row["id"]),
            "role": normalized_role,
        }

    def list_workspaces(self) -> list[WorkspaceRecord]:
        with closing(self._connection()) as connection:
            rows = connection.execute(
                "SELECT * FROM workspaces WHERE active=1 ORDER BY created_at,id"
            ).fetchall()
        return [self._workspace_record(row) for row in rows]

    def workspace_store(self, workspace_id: str) -> Store:
        workspace = self.get_workspace(workspace_id)
        with self._stores_lock:
            store = self._stores.get(workspace.id)
            if store is None:
                store = Store(workspace.business_db_path, mode="pilot", workspace_id=workspace.id)
                self._stores[workspace.id] = store
            return store

    def get_workspace(self, workspace_id: str) -> WorkspaceRecord:
        with closing(self._connection()) as connection:
            row = connection.execute(
                "SELECT * FROM workspaces WHERE id=? AND active=1", (workspace_id,)
            ).fetchone()
        if row is None:
            raise DomainError("WORKSPACE_NOT_FOUND", "工作区不存在或不可用", 404)
        return self._workspace_record(row)

    def _workspace_record(self, row: sqlite3.Row) -> WorkspaceRecord:
        return WorkspaceRecord(
            id=str(row["id"]),
            name=str(row["name"]),
            slug=str(row["slug"]),
            business_db_path=self._validated_workspace_path(Path(str(row["business_db_path"]))),
            active=bool(row["active"]),
        )

    def _validated_workspace_path(self, path: Path) -> Path:
        resolved = path.expanduser().resolve()
        try:
            resolved.relative_to(self.workspaces_dir)
        except ValueError as exc:
            raise RuntimeError("workspace registry path escapes PRODUCT_RES_DATA_DIR") from exc
        return resolved

    def list_user_workspaces(self, user_id: str) -> list[dict[str, str]]:
        with closing(self._connection()) as connection:
            rows = connection.execute(
                """
                SELECT w.id,w.name,w.slug,m.role
                FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
                WHERE m.user_id=? AND m.active=1 AND w.active=1
                ORDER BY w.created_at,w.id
                """,
                (user_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def workspace_members(self, workspace_id: str) -> tuple[WorkspaceMember, ...]:
        with closing(self._connection()) as connection:
            rows = connection.execute(
                """
                SELECT u.id,u.display_name AS name,m.role
                FROM memberships m JOIN users u ON u.id=m.user_id
                WHERE m.workspace_id=? AND m.active=1 AND u.active=1
                ORDER BY u.created_at,u.id
                """,
                (workspace_id,),
            ).fetchall()
        return tuple(
            WorkspaceMember(str(row["id"]), str(row["name"]), str(row["role"])) for row in rows
        )


class AuthManager:
    def __init__(
        self,
        settings: Settings,
        control: ControlStore,
        *,
        clock: Callable[[], datetime] | None = None,
    ):
        self.settings = settings
        self.control = control
        self.clock = clock or (lambda: datetime.now(UTC))

    @classmethod
    def from_settings(cls, settings: Settings) -> AuthManager:
        if (
            settings.mode != "pilot"
            or settings.control_db_path is None
            or settings.workspaces_dir is None
        ):
            raise ValueError("AuthManager requires pilot settings")
        return cls(settings, ControlStore(settings.control_db_path, settings.workspaces_dir))

    def login(
        self, username: str, password: str, workspace_id: str | None, remote_ip: str
    ) -> tuple[RequestIdentity, str, str, list[dict[str, str]]]:
        try:
            normalized = _normalize_username(username)
        except ValueError as exc:
            raise DomainError("INVALID_CREDENTIALS", "用户名或口令错误", 401) from exc
        now = self.clock()
        cutoff = (now - timedelta(seconds=self.settings.login_window_seconds)).isoformat()
        with self.control.transaction() as connection:
            connection.execute("DELETE FROM login_attempts WHERE attempted_at<?", (cutoff,))
            failed = connection.execute(
                """
                SELECT COUNT(*) FROM login_attempts
                WHERE username=? AND remote_ip=? AND attempted_at>=? AND succeeded=0
                """,
                (normalized, remote_ip, cutoff),
            ).fetchone()[0]
            if int(failed) >= self.settings.login_max_failures:
                raise DomainError("LOGIN_THROTTLED", "登录尝试过多，请稍后再试", 429)
            user = connection.execute(
                "SELECT * FROM users WHERE username=? AND active=1", (normalized,)
            ).fetchone()
            valid = user is not None and verify_password(password, str(user["password_hash"]))
            connection.execute(
                "INSERT INTO login_attempts VALUES (?,?,?,?,?)",
                (str(uuid4()), normalized, remote_ip, now.isoformat(), int(valid)),
            )
            user_id = str(user["id"]) if user is not None else ""

        if not valid:
            raise DomainError("INVALID_CREDENTIALS", "用户名或口令错误", 401)

        workspaces = self.control.list_user_workspaces(user_id)
        if not workspaces:
            raise DomainError("NO_WORKSPACE_MEMBERSHIP", "账号尚未加入可用工作区", 403)
        if workspace_id is None:
            if len(workspaces) != 1:
                raise DomainError(
                    "WORKSPACE_SELECTION_REQUIRED",
                    "请选择工作区",
                    409,
                    {"workspaces": workspaces},
                )
            workspace_id = workspaces[0]["id"]
        selected = next((item for item in workspaces if item["id"] == workspace_id), None)
        if selected is None:
            raise DomainError("WORKSPACE_ACCESS_DENIED", "无权访问该工作区", 403)
        identity, token, csrf = self._create_session(user_id, workspace_id)
        return identity, token, csrf, workspaces

    def authenticate(self, token: str | None) -> RequestIdentity:
        if not token:
            raise DomainError("AUTH_REQUIRED", "请先登录", 401)
        token_hash = _token_hash(token)
        now = self.clock()
        with self.control.transaction() as connection:
            row = connection.execute(
                """
                SELECT s.id AS session_id,s.csrf_hash,s.expires_at,
                       u.id AS user_id,u.username,u.display_name,u.is_admin,
                       w.id AS workspace_id,w.name AS workspace_name,w.slug AS workspace_slug,
                       m.role
                FROM sessions s
                JOIN users u ON u.id=s.user_id
                JOIN workspaces w ON w.id=s.workspace_id
                JOIN memberships m ON m.user_id=s.user_id AND m.workspace_id=s.workspace_id
                WHERE s.token_hash=? AND s.revoked_at IS NULL
                  AND u.active=1 AND w.active=1 AND m.active=1
                """,
                (token_hash,),
            ).fetchone()
            if row is None:
                raise DomainError("AUTH_REQUIRED", "会话无效，请重新登录", 401)
            if _parse_utc(str(row["expires_at"])) <= now:
                connection.execute(
                    "UPDATE sessions SET revoked_at=? WHERE id=?",
                    (now.isoformat(), row["session_id"]),
                )
                raise DomainError("SESSION_EXPIRED", "会话已过期，请重新登录", 401)
        return self._identity_from_row(row)

    def validate_origin(self, request: Request) -> None:
        origin = request.headers.get("Origin")
        if origin is None or origin.rstrip("/") != self.settings.public_origin:
            raise DomainError("ORIGIN_REJECTED", "请求来源无效", 403)

    def validate_csrf(self, request: Request, identity: RequestIdentity) -> None:
        supplied = request.headers.get(CSRF_HEADER, "")
        if not supplied or not hmac.compare_digest(_token_hash(supplied), identity.csrf_hash):
            raise DomainError("CSRF_REJECTED", "请求校验失败，请刷新后重试", 403)

    def logout(self, session_id: str) -> None:
        with self.control.transaction() as connection:
            connection.execute(
                "UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
                (self.clock().isoformat(), session_id),
            )

    def switch_workspace(
        self, identity: RequestIdentity, workspace_id: str
    ) -> tuple[RequestIdentity, str, str, list[dict[str, str]]]:
        workspaces = self.control.list_user_workspaces(identity.user_id)
        if not any(item["id"] == workspace_id for item in workspaces):
            raise DomainError("WORKSPACE_ACCESS_DENIED", "无权访问该工作区", 403)
        self.logout(identity.session_id)
        new_identity, token, csrf = self._create_session(identity.user_id, workspace_id)
        return new_identity, token, csrf, workspaces

    def _create_session(self, user_id: str, workspace_id: str) -> tuple[RequestIdentity, str, str]:
        now = self.clock()
        expires_at = now + timedelta(seconds=self.settings.session_ttl_seconds)
        session_id = str(uuid4())
        token = secrets.token_urlsafe(32)
        csrf = _token_hash(f"csrf:{token}")
        with self.control.transaction() as connection:
            row = connection.execute(
                """
                SELECT u.id AS user_id,u.username,u.display_name,
                       u.is_admin,
                       w.id AS workspace_id,w.name AS workspace_name,w.slug AS workspace_slug,
                       m.role
                FROM users u JOIN memberships m ON m.user_id=u.id
                JOIN workspaces w ON w.id=m.workspace_id
                WHERE u.id=? AND w.id=? AND u.active=1 AND m.active=1 AND w.active=1
                """,
                (user_id, workspace_id),
            ).fetchone()
            if row is None:
                raise DomainError("WORKSPACE_ACCESS_DENIED", "无权访问该工作区", 403)
            connection.execute(
                "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,NULL)",
                (
                    session_id,
                    _token_hash(token),
                    _token_hash(csrf),
                    user_id,
                    workspace_id,
                    now.isoformat(),
                    expires_at.isoformat(),
                ),
            )
        values = dict(row)
        values.update(
            session_id=session_id,
            csrf_hash=_token_hash(csrf),
            expires_at=expires_at.isoformat(),
        )
        return self._identity_from_row(values), token, csrf

    def _identity_from_row(self, row: sqlite3.Row | dict[str, Any]) -> RequestIdentity:
        workspace_id = str(row["workspace_id"])
        return RequestIdentity(
            user_id=str(row["user_id"]),
            username=str(row["username"]),
            display_name=str(row["display_name"]),
            workspace_id=workspace_id,
            workspace_name=str(row["workspace_name"]),
            workspace_slug=str(row["workspace_slug"]),
            role=str(row["role"]),
            session_id=str(row["session_id"]),
            csrf_hash=str(row["csrf_hash"]),
            expires_at=str(row["expires_at"]),
            members=self.control.workspace_members(workspace_id),
            is_admin=bool(row["is_admin"]),
        )


def hash_password(password: str) -> str:
    if len(password) < 12 or len(password) > 1024:
        raise ValueError("password must contain 12-1024 characters")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P
    )
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n, r, p, salt, expected = encoded.split("$", 5)
        if algorithm != "scrypt":
            return False
        digest = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt),
            n=int(n),
            r=int(r),
            p=int(p),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest.hex(), expected)


def session_payload(
    identity: RequestIdentity, workspaces: list[dict[str, str]], csrf_token: str | None = None
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "user": {
            "id": identity.user_id,
            "username": identity.username,
            "name": identity.display_name,
            "is_admin": identity.is_admin,
        },
        "workspace": {
            "id": identity.workspace_id,
            "name": identity.workspace_name,
            "slug": identity.workspace_slug,
            "role": identity.role,
        },
        "workspaces": workspaces,
        "members": [asdict(member) for member in identity.members],
        "expires_at": identity.expires_at,
    }
    if csrf_token is not None:
        payload["csrf_token"] = csrf_token
    return payload


@router.post("/login")
def login(request: Request, response: Response, command: LoginCommand) -> dict[str, Any]:
    manager: AuthManager = request.app.state.auth
    remote_ip = request.client.host if request.client is not None else "unknown"
    identity, token, csrf, workspaces = manager.login(
        command.username, command.password, command.workspace_id, remote_ip
    )
    _set_session_cookie(response, manager.settings, token, manager.settings.session_ttl_seconds)
    return session_payload(identity, workspaces, csrf)


@router.get("/session")
def get_session(request: Request) -> dict[str, Any]:
    identity = _required_identity()
    manager: AuthManager = request.app.state.auth
    csrf = _token_hash(f"csrf:{request.cookies.get(SESSION_COOKIE, '')}")
    return session_payload(identity, manager.control.list_user_workspaces(identity.user_id), csrf)


@router.post("/logout")
def logout(request: Request, response: Response) -> dict[str, bool]:
    identity = _required_identity()
    manager: AuthManager = request.app.state.auth
    manager.logout(identity.session_id)
    response.delete_cookie(SESSION_COOKIE, path="/", secure=manager.settings.secure_cookie)
    return {"logged_out": True}


@router.post("/switch-workspace")
def switch_workspace(
    request: Request, response: Response, command: SwitchWorkspaceCommand
) -> dict[str, Any]:
    manager: AuthManager = request.app.state.auth
    identity, token, csrf, workspaces = manager.switch_workspace(
        _required_identity(), command.workspace_id
    )
    _set_session_cookie(response, manager.settings, token, manager.settings.session_ttl_seconds)
    return session_payload(identity, workspaces, csrf)


def _set_session_cookie(response: Response, settings: Settings, token: str, max_age: int) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=max_age,
        httponly=True,
        secure=settings.secure_cookie,
        samesite="lax",
        path="/",
    )


def _required_identity() -> RequestIdentity:
    identity = current_identity()
    if identity is None:
        raise DomainError("AUTH_REQUIRED", "请先登录", 401)
    return identity


def _normalize_username(username: str) -> str:
    normalized = username.strip().lower()
    if not _USERNAME.fullmatch(normalized):
        raise ValueError("username must be 3-100 letters, digits, dots, underscores, or hyphens")
    return normalized


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise RuntimeError("pilot timestamps must include a UTC offset")
    return parsed.astimezone(UTC)
