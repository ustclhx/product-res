"""Shared command boundary: role checks, atomic writes and retry receipts."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from typing import Any

from fastapi import Request
from pydantic import BaseModel, ConfigDict, Field

from app.persistence.store import Tx, encode
from app.pilot.context import current_identity, current_member_roles

ACTORS = [
    {"id": "analyst", "name": "林晓 · 选品分析", "role": "analyst"},
    {"id": "owner", "name": "陈越 · 决策负责人", "role": "decision"},
    {"id": "contributor", "name": "周宁 · 采购协作", "role": "contributor"},
]
ACTOR_IDS = frozenset(actor["id"] for actor in ACTORS)


class DomainError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        status: int = 422,
        details: dict[str, Any] | None = None,
        commit: bool = False,
    ):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status
        self.details, self.commit = details or {}, commit


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    actor_id: str | None = Field(default=None, min_length=1)
    expected_version: int | None = Field(default=None, ge=1, strict=True)


def require_role(tx: Tx, project: dict[str, Any], actor: str, role: str) -> None:
    identity = current_identity()
    if identity is not None:
        if actor != identity.user_id:
            raise DomainError("FORGED_ACTOR", "请求身份与登录用户不一致", 403)
        tx_workspace_id = getattr(tx, "workspace_id", None)
        if tx_workspace_id != identity.workspace_id:
            raise DomainError("WORKSPACE_ACCESS_DENIED", "工作区上下文不一致", 403)
        assigned_role = current_member_roles().get(actor)
        if assigned_role is None or (role != "contributor" and assigned_role != role):
            raise DomainError("ROLE_NOT_ALLOWED", "当前成员角色无权执行此操作", 403)
        owner_field = {"analyst": "analyst_id", "decision": "decision_owner_id"}.get(role)
        if owner_field is not None and project.get(owner_field) != actor:
            raise DomainError("ROLE_NOT_ALLOWED", "当前成员不是项目指定负责人", 403)
        return
    if getattr(tx, "mode", "demo") == "pilot":
        raise DomainError("AUTH_REQUIRED", "试点操作需要已认证的请求上下文", 401)
    if actor not in ACTOR_IDS:
        raise DomainError("ROLE_NOT_ALLOWED", "请选择已配置的演示参与人", 403)
    if role == "analyst" and project.get("analyst_id") != actor:
        raise DomainError("ROLE_NOT_ALLOWED", "此操作需要项目分析负责人", 403)
    if role == "decision" and project.get("decision_owner_id") != actor:
        raise DomainError("ROLE_NOT_ALLOWED", "此操作需要项目决策负责人", 403)
    if role not in {"analyst", "decision", "contributor"}:
        raise ValueError("unknown role policy")


def execute(
    request: Request,
    command: Command,
    target_id: str | None,
    action: str,
    operation: Callable[[Tx, str], dict[str, Any]],
) -> dict[str, Any]:
    key = request.headers.get("Idempotency-Key", "")
    if not key or len(key) > 255 or any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise DomainError("IDEMPOTENCY_KEY_REQUIRED", "写入操作需要有效的请求标识")
    identity = current_identity()
    if identity is not None:
        actor_id = identity.user_id
        if command.actor_id is not None and command.actor_id != actor_id:
            raise DomainError("FORGED_ACTOR", "请求中的操作者与登录用户不一致", 403)
        workspace_id: str | None = identity.workspace_id
    else:
        workspace_id = None
        requested_actor = command.actor_id
        if requested_actor not in ACTOR_IDS:
            raise DomainError("ROLE_NOT_ALLOWED", "请选择已配置的演示参与人", 403)
        assert requested_actor is not None
        actor_id = requested_actor
    payload = command.model_dump(mode="json")
    payload["actor_id"] = actor_id
    payload_hash = hashlib.sha256(encode(payload).encode()).hexdigest()
    scope = encode(
        [workspace_id, actor_id, action, target_id, key]
        if workspace_id is not None
        else [actor_id, action, target_id, key]
    )
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        if identity is None and getattr(tx, "mode", "demo") == "pilot":
            raise DomainError("AUTH_REQUIRED", "试点操作需要已认证的请求上下文", 401)
        if identity is not None and getattr(tx, "workspace_id", None) != identity.workspace_id:
            raise DomainError("WORKSPACE_ACCESS_DENIED", "工作区上下文不一致", 403)
        receipt = tx.connection.execute("SELECT * FROM receipts WHERE scope=?", (scope,)).fetchone()
        if receipt:
            if receipt["payload_hash"] != payload_hash:
                raise DomainError("IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同内容", 409)
            result: dict[str, Any] = json.loads(receipt["response"])
            if "_command_error" in result:
                error = result["_command_error"]
                raise DomainError(
                    error["code"], error["message"], error["status"], error["details"]
                )
            return result
        if target_id:
            entity = tx.get(target_id)
            if command.expected_version != entity["version"]:
                raise DomainError(
                    "VERSION_CONFLICT",
                    "数据已变化，请刷新后重试",
                    409,
                    {"current_version": entity["version"]},
                )
        try:
            result = operation(tx, actor_id)
        except DomainError as exc:
            if exc.commit:
                # Failed node runs and submission invalidations are durable outcomes too.
                # Store the same rejection so a transport retry cannot repeat their effects.
                rejected = {
                    "_command_error": {
                        "code": exc.code,
                        "message": exc.message,
                        "status": exc.status,
                        "details": exc.details,
                    }
                }
                tx.audit(
                    actor_id,
                    action,
                    target_id,
                    {
                        "request_key": key,
                        "error_code": exc.code,
                        "authenticated_user_id": identity.user_id if identity else None,
                    },
                )
                tx.connection.execute(
                    "INSERT INTO receipts VALUES (?,?,?)", (scope, payload_hash, encode(rejected))
                )
            raise
        tx.audit(
            actor_id,
            action,
            target_id,
            {
                "request_key": key,
                "authenticated_user_id": identity.user_id if identity else None,
                "workspace_id": workspace_id,
            },
        )
        tx.connection.execute(
            "INSERT INTO receipts VALUES (?,?,?)", (scope, payload_hash, encode(result))
        )
        return result
