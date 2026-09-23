"""Request-local pilot identity and workspace Store selection."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import Any

from app.persistence.store import Store


@dataclass(frozen=True, slots=True)
class WorkspaceMember:
    id: str
    name: str
    role: str


@dataclass(frozen=True, slots=True)
class RequestIdentity:
    user_id: str
    username: str
    display_name: str
    workspace_id: str
    workspace_name: str
    workspace_slug: str
    role: str
    session_id: str
    csrf_hash: str
    expires_at: str
    members: tuple[WorkspaceMember, ...]
    is_admin: bool = False


_identity: ContextVar[RequestIdentity | None] = ContextVar("pilot_identity", default=None)
_workspace_store: ContextVar[Store | None] = ContextVar("pilot_workspace_store", default=None)


def current_identity() -> RequestIdentity | None:
    return _identity.get()


def current_members() -> tuple[WorkspaceMember, ...]:
    identity = current_identity()
    return identity.members if identity is not None else ()


def current_member_roles() -> dict[str, str]:
    """Return the authenticated workspace's active user-id to role mapping."""

    return {member.id: member.role for member in current_members()}


@contextmanager
def bind_request(identity: RequestIdentity, store: Store) -> Iterator[None]:
    identity_token: Token[RequestIdentity | None] = _identity.set(identity)
    store_token: Token[Store | None] = _workspace_store.set(store)
    try:
        yield
    finally:
        _workspace_store.reset(store_token)
        _identity.reset(identity_token)


class StoreProxy:
    """Resolve Store operations from ContextVars without mutating app-global state."""

    def __init__(self, fallback: Store | None = None):
        self._fallback = fallback

    def _current(self) -> Store:
        store = _workspace_store.get() or self._fallback
        if store is None:
            raise RuntimeError("no workspace store is bound to this request")
        return store

    def transaction(self, *args: Any, **kwargs: Any) -> Any:
        return self._current().transaction(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._current(), name)
