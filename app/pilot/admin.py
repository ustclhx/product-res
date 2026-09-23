"""Server-owned pilot account administration."""

from __future__ import annotations

import secrets
import sqlite3
from typing import Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field

from app.core import DomainError
from app.pilot.auth import ControlStore, _normalize_username, _utc_now, hash_password
from app.pilot.context import RequestIdentity, current_identity

router = APIRouter(prefix="/admin", tags=["pilot-admin"])


class MembershipInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    workspace_id: str = Field(min_length=1, max_length=100)
    role: Literal["analyst", "decision", "contributor"]


class CreateAccountCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    username: str = Field(min_length=3, max_length=100)
    display_name: str = Field(min_length=1, max_length=200)
    memberships: list[MembershipInput] = Field(min_length=1)


class UpdateAccountCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    expected_version: int = Field(ge=1, strict=True)
    display_name: str = Field(min_length=1, max_length=200)
    active: bool
    memberships: list[MembershipInput] = Field(min_length=1)


class ResetPasswordCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=1, strict=True)


def bootstrap_admin(control: ControlStore, username: str, display_name: str) -> dict[str, Any]:
    """Create an administrator with contributor access to every active workspace."""

    normalized = _validated_username(username)
    shown_name = _validated_display_name(display_name)
    password = secrets.token_urlsafe(18)
    password_hash = hash_password(password)
    user_id = str(uuid4())
    now = _utc_now().isoformat()
    try:
        with control.transaction() as connection:
            workspaces = connection.execute(
                "SELECT id FROM workspaces WHERE active=1 ORDER BY created_at,id"
            ).fetchall()
            if not workspaces:
                raise ValueError("at least one active workspace is required")
            connection.execute(
                """
                INSERT INTO users(
                    id,username,display_name,password_hash,active,created_at,is_admin,version
                ) VALUES (?,?,?,?,1,?,1,1)
                """,
                (user_id, normalized, shown_name, password_hash, now),
            )
            connection.executemany(
                """
                INSERT INTO memberships(workspace_id,user_id,role,active,created_at)
                VALUES (?,?, 'contributor',1,?)
                """,
                [(str(row["id"]), user_id, now) for row in workspaces],
            )
            _audit(connection, user_id, "ACCOUNT_ADMIN_BOOTSTRAPPED", user_id, now)
            account = _account(connection, user_id)
    except sqlite3.IntegrityError as exc:
        raise ValueError("username already exists") from exc
    return {"account": account, "password": password}


@router.get("/accounts")
def list_accounts(request: Request) -> dict[str, Any]:
    _required_admin()
    control: ControlStore = request.app.state.auth.control
    with control.transaction() as connection:
        _require_current_admin_session(connection, _required_admin())
        rows = connection.execute("SELECT id FROM users ORDER BY created_at,id").fetchall()
        items = [_account(connection, str(row["id"])) for row in rows]
        workspaces = [
            dict(row)
            for row in connection.execute(
                "SELECT id,name,slug FROM workspaces WHERE active=1 ORDER BY created_at,id"
            ).fetchall()
        ]
    return {"items": items, "workspaces": workspaces}


@router.post("/accounts")
def create_account(request: Request, command: CreateAccountCommand) -> dict[str, Any]:
    actor = _required_admin()
    control: ControlStore = request.app.state.auth.control
    username = _validated_username(command.username)
    display_name = _validated_display_name(command.display_name)
    memberships = _validated_memberships(command.memberships)
    password = secrets.token_urlsafe(18)
    password_hash = hash_password(password)
    user_id = str(uuid4())
    now = _utc_now().isoformat()
    try:
        with control.transaction() as connection:
            _require_current_admin_session(connection, actor)
            _require_active_workspaces(connection, memberships)
            connection.execute(
                """
                INSERT INTO users(
                    id,username,display_name,password_hash,active,created_at,is_admin,version
                ) VALUES (?,?,?,?,1,?,0,1)
                """,
                (user_id, username, display_name, password_hash, now),
            )
            _replace_memberships(connection, user_id, memberships, now)
            _audit(connection, actor.user_id, "ACCOUNT_CREATED", user_id, now)
            account = _account(connection, user_id)
    except sqlite3.IntegrityError as exc:
        if "users.username" in str(exc) or "UNIQUE constraint failed: users.username" in str(exc):
            raise DomainError("USERNAME_CONFLICT", "用户名已存在", 409) from exc
        raise
    return {"account": account, "password": password}


@router.patch("/accounts/{account_id}")
def update_account(
    request: Request, account_id: str, command: UpdateAccountCommand
) -> dict[str, Any]:
    actor = _required_admin()
    control: ControlStore = request.app.state.auth.control
    display_name = _validated_display_name(command.display_name)
    memberships = _validated_memberships(command.memberships)
    now = _utc_now().isoformat()
    with control.transaction() as connection:
        _require_current_admin_session(connection, actor)
        current = connection.execute(
            "SELECT active,version FROM users WHERE id=?", (account_id,)
        ).fetchone()
        if current is None:
            raise DomainError("ACCOUNT_NOT_FOUND", "账号不存在", 404)
        if int(current["version"]) != command.expected_version:
            raise DomainError("VERSION_CONFLICT", "账号已被其他操作更新", 409)
        _require_active_workspaces(connection, memberships)
        previous_memberships = _membership_map(connection, account_id)
        membership_changed = previous_memberships != memberships
        active_changed = bool(current["active"]) != command.active
        if account_id == actor.user_id and (not command.active or membership_changed):
            raise DomainError("SELF_LOCKOUT_REJECTED", "不能停用自己或修改自己的工作区权限", 409)
        connection.execute(
            """
            UPDATE users SET display_name=?,active=?,version=version+1
            WHERE id=? AND version=?
            """,
            (display_name, int(command.active), account_id, command.expected_version),
        )
        _replace_memberships(connection, account_id, memberships, now)
        if active_changed or membership_changed:
            _revoke_sessions(connection, account_id, now)
        _audit(connection, actor.user_id, "ACCOUNT_UPDATED", account_id, now)
        account = _account(connection, account_id)
    return {"account": account}


@router.post("/accounts/{account_id}/reset-password")
def reset_password(
    request: Request, account_id: str, command: ResetPasswordCommand
) -> dict[str, Any]:
    actor = _required_admin()
    control: ControlStore = request.app.state.auth.control
    password = secrets.token_urlsafe(18)
    password_hash = hash_password(password)
    now = _utc_now().isoformat()
    with control.transaction() as connection:
        _require_current_admin_session(connection, actor)
        current = connection.execute(
            "SELECT version FROM users WHERE id=?", (account_id,)
        ).fetchone()
        if current is None:
            raise DomainError("ACCOUNT_NOT_FOUND", "账号不存在", 404)
        if int(current["version"]) != command.expected_version:
            raise DomainError("VERSION_CONFLICT", "账号已被其他操作更新", 409)
        connection.execute(
            "UPDATE users SET password_hash=?,version=version+1 WHERE id=? AND version=?",
            (password_hash, account_id, command.expected_version),
        )
        _revoke_sessions(connection, account_id, now)
        _audit(connection, actor.user_id, "ACCOUNT_PASSWORD_RESET", account_id, now)
        account = _account(connection, account_id)
    return {"account": account, "password": password}


def _required_admin() -> RequestIdentity:
    identity = current_identity()
    if identity is None:
        raise DomainError("AUTH_REQUIRED", "请先登录", 401)
    if not identity.is_admin:
        raise DomainError("ADMIN_REQUIRED", "需要管理员权限", 403)
    return identity


def _require_current_admin_session(
    connection: sqlite3.Connection, identity: RequestIdentity
) -> None:
    current = connection.execute(
        """
        SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id
        WHERE u.id=? AND u.active=1 AND u.is_admin=1
          AND s.id=? AND s.revoked_at IS NULL
        """,
        (identity.user_id, identity.session_id),
    ).fetchone()
    if current is None:
        raise DomainError("ADMIN_REQUIRED", "管理员会话已失效，请重新登录", 403)


def _validated_username(value: str) -> str:
    try:
        return _normalize_username(value)
    except ValueError as exc:
        raise DomainError("INVALID_USERNAME", str(exc), 422) from exc


def _validated_display_name(value: str) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > 200:
        raise DomainError("INVALID_DISPLAY_NAME", "显示名称长度必须为 1-200 个字符", 422)
    return normalized


def _validated_memberships(items: list[MembershipInput]) -> dict[str, str]:
    memberships: dict[str, str] = {}
    for item in items:
        if item.workspace_id in memberships:
            raise DomainError("DUPLICATE_MEMBERSHIP", "工作区不能重复", 422)
        memberships[item.workspace_id] = item.role
    if not memberships:
        raise DomainError("MEMBERSHIP_REQUIRED", "账号至少需要一个工作区权限", 422)
    return memberships


def _require_active_workspaces(
    connection: sqlite3.Connection, memberships: dict[str, str]
) -> None:
    placeholders = ",".join("?" for _ in memberships)
    found = connection.execute(
        f"SELECT id FROM workspaces WHERE active=1 AND id IN ({placeholders})",
        tuple(memberships),
    ).fetchall()
    if {str(row["id"]) for row in found} != set(memberships):
        raise DomainError("WORKSPACE_NOT_FOUND", "工作区不存在或不可用", 422)


def _replace_memberships(
    connection: sqlite3.Connection,
    user_id: str,
    memberships: dict[str, str],
    now: str,
) -> None:
    connection.execute("UPDATE memberships SET active=0 WHERE user_id=?", (user_id,))
    connection.executemany(
        """
        INSERT INTO memberships(workspace_id,user_id,role,active,created_at)
        VALUES (?,?,?,1,?)
        ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,active=1
        """,
        [(workspace_id, user_id, role, now) for workspace_id, role in memberships.items()],
    )


def _membership_map(connection: sqlite3.Connection, user_id: str) -> dict[str, str]:
    rows = connection.execute(
        "SELECT workspace_id,role FROM memberships WHERE user_id=? AND active=1",
        (user_id,),
    ).fetchall()
    return {str(row["workspace_id"]): str(row["role"]) for row in rows}


def _account(connection: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    row = connection.execute(
        "SELECT id,username,display_name,active,is_admin,version FROM users WHERE id=?",
        (user_id,),
    ).fetchone()
    if row is None:
        raise DomainError("ACCOUNT_NOT_FOUND", "账号不存在", 404)
    account = dict(row)
    account["active"] = bool(account["active"])
    account["is_admin"] = bool(account["is_admin"])
    account["memberships"] = [
        dict(membership)
        for membership in connection.execute(
            """
            SELECT workspace_id,role FROM memberships
            WHERE user_id=? AND active=1 ORDER BY workspace_id
            """,
            (user_id,),
        ).fetchall()
    ]
    return account


def _revoke_sessions(connection: sqlite3.Connection, user_id: str, now: str) -> None:
    connection.execute(
        "UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
        (now, user_id),
    )


def _audit(
    connection: sqlite3.Connection,
    actor_user_id: str,
    action: str,
    target_user_id: str,
    now: str,
) -> None:
    connection.execute(
        "INSERT INTO control_audit VALUES (?,?,?,?,?)",
        (str(uuid4()), actor_user_id, action, target_user_id, now),
    )
