from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from app.main import create_app
from app.pilot.admin import bootstrap_admin
from app.pilot.auth import ControlStore, verify_password
from app.pilot.config import Settings
from app.pilot.context import RequestIdentity
from fastapi.testclient import TestClient

ORIGIN = "http://localhost"


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        mode="pilot",
        data_dir=tmp_path,
        public_url=ORIGIN,
        demo_db_path=None,
        control_db_path=tmp_path / "control.sqlite3",
        workspaces_dir=tmp_path / "workspaces",
    )


def _login(
    app: Any, username: str, password: str, workspace_id: str
) -> tuple[TestClient, str, dict[str, Any]]:
    client = TestClient(app)
    response = client.post(
        "/api/v1/auth/login",
        headers={"Origin": ORIGIN},
        json={"username": username, "password": password, "workspace_id": workspace_id},
    )
    assert response.status_code == 200, response.text
    return client, response.json()["csrf_token"], response.json()


def _headers(csrf: str) -> dict[str, str]:
    return {"Origin": ORIGIN, "X-CSRF-Token": csrf}


def test_v1_control_database_migrates_atomically_without_changing_passwords(
    tmp_path: Path,
) -> None:
    path = tmp_path / "control.sqlite3"
    encoded = "scrypt$16384$8$1$00$11"
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE control_schema_version(version INTEGER PRIMARY KEY);
            INSERT INTO control_schema_version VALUES(1);
            CREATE TABLE users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                active INTEGER NOT NULL CHECK(active IN (0,1)),
                created_at TEXT NOT NULL
            );
            """
        )
        connection.execute(
            "INSERT INTO users VALUES(?,?,?,?,1,?)",
            ("user-1", "existing", "Existing", encoded, "2026-01-01T00:00:00+00:00"),
        )

    ControlStore(path, tmp_path / "workspaces")

    with sqlite3.connect(path) as connection:
        row = connection.execute(
            "SELECT password_hash,is_admin,version FROM users WHERE id='user-1'"
        ).fetchone()
        assert connection.execute("SELECT version FROM control_schema_version").fetchall() == [
            (2,)
        ]
        assert row == (encoded, 0, 1)
        assert connection.execute(
            "SELECT name FROM sqlite_master WHERE name='control_audit'"
        ).fetchone() == ("control_audit",)


def test_control_migration_serializes_concurrent_fresh_v1_and_v2_startup(
    tmp_path: Path,
) -> None:
    for initial in ("fresh", "v1", "v2"):
        root = tmp_path / initial
        root.mkdir()
        path = root / "control.sqlite3"
        workspaces = root / "workspaces"
        if initial == "v1":
            with sqlite3.connect(path) as connection:
                connection.executescript(
                    """
                    CREATE TABLE control_schema_version(version INTEGER PRIMARY KEY);
                    INSERT INTO control_schema_version VALUES(1);
                    CREATE TABLE users (
                        id TEXT PRIMARY KEY,
                        username TEXT NOT NULL UNIQUE,
                        display_name TEXT NOT NULL,
                        password_hash TEXT NOT NULL,
                        active INTEGER NOT NULL CHECK(active IN (0,1)),
                        created_at TEXT NOT NULL
                    );
                    """
                )
        elif initial == "v2":
            ControlStore(path, workspaces)

        def open_store(
            _index: int, control_path: Path = path, workspaces_dir: Path = workspaces
        ) -> ControlStore:
            return ControlStore(control_path, workspaces_dir)

        with ThreadPoolExecutor(max_workers=6) as pool:
            stores = list(pool.map(open_store, range(12)))

        assert len(stores) == 12
        with sqlite3.connect(path) as connection:
            assert connection.execute(
                "SELECT version FROM control_schema_version"
            ).fetchall() == [(2,)]
            columns = [row[1] for row in connection.execute("PRAGMA table_info(users)")]
        assert columns.count("is_admin") == 1
        assert columns.count("version") == 1


def test_admin_account_lifecycle_enforces_permissions_versions_and_session_revocation(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app = create_app(settings=settings)
    control: ControlStore = app.state.auth.control
    first = control.init_workspace("first", "First")
    second = control.init_workspace("second", "Second")
    bootstrapped = bootstrap_admin(control, "root.admin", "Root Admin")
    admin_client, csrf, session = _login(
        app, "root.admin", bootstrapped["password"], first.id
    )
    assert session["user"]["is_admin"] is True
    assert session["workspace"]["role"] == "contributor"

    created = admin_client.post(
        "/api/v1/admin/accounts",
        headers=_headers(csrf),
        json={
            "username": "new.user",
            "display_name": "New User",
            "memberships": [
                {"workspace_id": first.id, "role": "analyst"},
                {"workspace_id": second.id, "role": "decision"},
            ],
        },
    )
    assert created.status_code == 200, created.text
    payload = created.json()
    account = payload["account"]
    assert account["is_admin"] is False
    assert account["version"] == 1
    assert len(payload["password"]) >= 24
    assert "password" not in account and "password_hash" not in account

    user_client, user_csrf, user_session = _login(
        app, "new.user", payload["password"], first.id
    )
    assert user_session["user"]["is_admin"] is False
    denied = user_client.get("/api/v1/admin/accounts")
    assert denied.status_code == 403
    assert denied.json()["error_code"] == "ADMIN_REQUIRED"

    missing_csrf = admin_client.post(
        f"/api/v1/admin/accounts/{account['id']}/reset-password",
        headers={"Origin": ORIGIN},
        json={"expected_version": 1},
    )
    assert missing_csrf.status_code == 403
    assert missing_csrf.json()["error_code"] == "CSRF_REJECTED"

    updated = admin_client.patch(
        f"/api/v1/admin/accounts/{account['id']}",
        headers=_headers(csrf),
        json={
            "expected_version": 1,
            "display_name": "Renamed User",
            "active": True,
            "memberships": [{"workspace_id": second.id, "role": "contributor"}],
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["account"]["version"] == 2
    assert user_client.get("/api/v1/auth/session").status_code == 401

    conflict = admin_client.patch(
        f"/api/v1/admin/accounts/{account['id']}",
        headers=_headers(csrf),
        json={
            "expected_version": 1,
            "display_name": "Stale",
            "active": True,
            "memberships": [{"workspace_id": second.id, "role": "contributor"}],
        },
    )
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "VERSION_CONFLICT"

    relogged, _relogged_csrf, _ = _login(app, "new.user", payload["password"], second.id)
    reset = admin_client.post(
        f"/api/v1/admin/accounts/{account['id']}/reset-password",
        headers=_headers(csrf),
        json={"expected_version": 2},
    )
    assert reset.status_code == 200, reset.text
    assert reset.json()["account"]["version"] == 3
    assert relogged.get("/api/v1/auth/session").status_code == 401
    _login(app, "new.user", reset.json()["password"], second.id)

    listing = admin_client.get("/api/v1/admin/accounts")
    assert listing.status_code == 200
    assert {workspace["id"] for workspace in listing.json()["workspaces"]} == {
        first.id,
        second.id,
    }
    assert "password" not in listing.text and "password_hash" not in listing.text
    assert user_csrf

    with sqlite3.connect(control.path) as connection:
        stored = connection.execute(
            "SELECT password_hash FROM users WHERE id=?", (account["id"],)
        ).fetchone()[0]
        columns = [row[1] for row in connection.execute("PRAGMA table_info(control_audit)")]
        actions = [row[0] for row in connection.execute("SELECT action FROM control_audit")]
    assert verify_password(reset.json()["password"], stored)
    assert columns == ["id", "actor_user_id", "action", "target_user_id", "created_at"]
    assert actions == [
        "ACCOUNT_ADMIN_BOOTSTRAPPED",
        "ACCOUNT_CREATED",
        "ACCOUNT_UPDATED",
        "ACCOUNT_PASSWORD_RESET",
    ]


def test_admin_rejects_duplicates_invalid_memberships_and_self_lockout(tmp_path: Path) -> None:
    app = create_app(settings=_settings(tmp_path))
    control: ControlStore = app.state.auth.control
    workspace = control.init_workspace("primary", "Primary")
    bootstrap = bootstrap_admin(control, "admin.user", "Admin")
    client, csrf, _ = _login(app, "admin.user", bootstrap["password"], workspace.id)
    admin_account = bootstrap["account"]

    self_lockout = client.patch(
        f"/api/v1/admin/accounts/{admin_account['id']}",
        headers=_headers(csrf),
        json={
            "expected_version": 1,
            "display_name": "Admin",
            "active": False,
            "memberships": admin_account["memberships"],
        },
    )
    assert self_lockout.status_code == 409
    assert self_lockout.json()["error_code"] == "SELF_LOCKOUT_REJECTED"

    self_membership_change = client.patch(
        f"/api/v1/admin/accounts/{admin_account['id']}",
        headers=_headers(csrf),
        json={
            "expected_version": 1,
            "display_name": "Admin",
            "active": True,
            "memberships": [{"workspace_id": workspace.id, "role": "decision"}],
        },
    )
    assert self_membership_change.status_code == 409
    assert self_membership_change.json()["error_code"] == "SELF_LOCKOUT_REJECTED"

    duplicate_membership = client.post(
        "/api/v1/admin/accounts",
        headers=_headers(csrf),
        json={
            "username": "member.one",
            "display_name": "Member",
            "memberships": [
                {"workspace_id": workspace.id, "role": "analyst"},
                {"workspace_id": workspace.id, "role": "decision"},
            ],
        },
    )
    assert duplicate_membership.status_code == 422
    assert duplicate_membership.json()["error_code"] == "DUPLICATE_MEMBERSHIP"

    created = client.post(
        "/api/v1/admin/accounts",
        headers=_headers(csrf),
        json={
            "username": "member.one",
            "display_name": "Member",
            "memberships": [{"workspace_id": workspace.id, "role": "analyst"}],
        },
    )
    assert created.status_code == 200
    duplicate = client.post(
        "/api/v1/admin/accounts",
        headers=_headers(csrf),
        json={
            "username": "member.one",
            "display_name": "Duplicate",
            "memberships": [{"workspace_id": workspace.id, "role": "analyst"}],
        },
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["error_code"] == "USERNAME_CONFLICT"


def test_admin_changes_own_password_and_revokes_only_own_sessions(tmp_path: Path) -> None:
    app = create_app(settings=_settings(tmp_path))
    control: ControlStore = app.state.auth.control
    workspace = control.init_workspace("primary", "Primary")
    bootstrap = bootstrap_admin(control, "admin.user", "Admin")
    client, csrf, _ = _login(app, "admin.user", bootstrap["password"], workspace.id)
    second_admin_client, _second_csrf, _ = _login(
        app, "admin.user", bootstrap["password"], workspace.id
    )
    member = control.create_user("member.user", "Member", "member-password")
    control.add_member(workspace.id, "member.user", "analyst")
    member_client, _member_csrf, _ = _login(
        app, "member.user", "member-password", workspace.id
    )

    new_password = "  newer secret  "
    changed = client.post(
        "/api/v1/admin/change-password",
        headers=_headers(csrf),
        json={"current_password": bootstrap["password"], "new_password": new_password},
    )
    assert changed.status_code == 200, changed.text
    assert changed.json() == {"password_changed": True}
    assert new_password not in changed.text and "scrypt" not in changed.text
    assert second_admin_client.get("/api/v1/auth/session").status_code == 401
    assert member_client.get("/api/v1/auth/session").status_code == 200

    old_login = TestClient(app).post(
        "/api/v1/auth/login",
        headers={"Origin": ORIGIN},
        json={
            "username": " admin.user ",
            "password": bootstrap["password"],
            "workspace_id": workspace.id,
        },
    )
    assert old_login.status_code == 401
    _login(app, " admin.user ", new_password, workspace.id)

    with sqlite3.connect(control.path) as connection:
        version, stored_hash = connection.execute(
            "SELECT version,password_hash FROM users WHERE id=?", (bootstrap["account"]["id"],)
        ).fetchone()
        actions = connection.execute(
            "SELECT action FROM control_audit WHERE target_user_id=? ORDER BY created_at,id",
            (bootstrap["account"]["id"],),
        ).fetchall()
    assert version == 2
    assert verify_password(new_password, stored_hash)
    assert ("ACCOUNT_PASSWORD_CHANGED",) in actions
    assert member["id"]


def test_change_password_rejects_bad_credentials_permissions_and_invalid_payloads(
    tmp_path: Path,
) -> None:
    app = create_app(settings=_settings(tmp_path))
    control: ControlStore = app.state.auth.control
    workspace = control.init_workspace("primary", "Primary")
    bootstrap = bootstrap_admin(control, "admin.user", "Admin")
    client, csrf, _ = _login(app, "admin.user", bootstrap["password"], workspace.id)

    bad_current = client.post(
        "/api/v1/admin/change-password",
        headers=_headers(csrf),
        json={"current_password": "wrong-password", "new_password": "new-password-123"},
    )
    assert bad_current.status_code == 400
    assert bad_current.json() == {
        "error_code": "CURRENT_PASSWORD_INVALID",
        "message": "当前密码错误",
        "details": {},
    }
    assert "wrong-password" not in bad_current.text

    unchanged = client.post(
        "/api/v1/admin/change-password",
        headers=_headers(csrf),
        json={
            "current_password": bootstrap["password"],
            "new_password": bootstrap["password"],
        },
    )
    assert unchanged.status_code == 422
    assert unchanged.json()["error_code"] == "PASSWORD_UNCHANGED"

    for body in (
        {"current_password": bootstrap["password"], "new_password": "short"},
        {
            "current_password": bootstrap["password"],
            "new_password": "valid-password-123",
            "user_id": bootstrap["account"]["id"],
        },
    ):
        invalid = client.post(
            "/api/v1/admin/change-password", headers=_headers(csrf), json=body
        )
        assert invalid.status_code == 422

    missing_csrf = client.post(
        "/api/v1/admin/change-password",
        headers={"Origin": ORIGIN},
        json={
            "current_password": bootstrap["password"],
            "new_password": "valid-password-123",
        },
    )
    assert missing_csrf.status_code == 403
    assert missing_csrf.json()["error_code"] == "CSRF_REJECTED"

    member = control.create_user("member.user", "Member", "member-password")
    control.add_member(workspace.id, "member.user", "analyst")
    member_client, member_csrf, _ = _login(
        app, "member.user", "member-password", workspace.id
    )
    forbidden = member_client.post(
        "/api/v1/admin/change-password",
        headers=_headers(member_csrf),
        json={"current_password": "member-password", "new_password": "new-password-123"},
    )
    assert forbidden.status_code == 403
    assert forbidden.json()["error_code"] == "ADMIN_REQUIRED"

    with sqlite3.connect(control.path) as connection:
        stored_hash, version = connection.execute(
            "SELECT password_hash,version FROM users WHERE id=?",
            (bootstrap["account"]["id"],),
        ).fetchone()
        rejected = connection.execute(
            "SELECT COUNT(*) FROM control_audit WHERE action='ACCOUNT_PASSWORD_CHANGE_REJECTED'"
        ).fetchone()[0]
    assert verify_password(bootstrap["password"], stored_hash)
    assert version == 1
    assert rejected == 1
    assert member["id"]


def test_change_password_throttles_failures_and_rejects_revoked_session(tmp_path: Path) -> None:
    settings = replace(_settings(tmp_path), login_max_failures=2)
    app = create_app(settings=settings)
    control: ControlStore = app.state.auth.control
    workspace = control.init_workspace("primary", "Primary")
    bootstrap = bootstrap_admin(control, "admin.user", "Admin")
    client, csrf, _ = _login(app, "admin.user", bootstrap["password"], workspace.id)

    statuses = []
    for _ in range(2):
        response = client.post(
            "/api/v1/admin/change-password",
            headers=_headers(csrf),
            json={"current_password": "wrong-password", "new_password": "new-password-123"},
        )
        statuses.append((response.status_code, response.json()["error_code"]))
    assert statuses == [(400, "CURRENT_PASSWORD_INVALID"), (429, "PASSWORD_CHANGE_THROTTLED")]
    throttled = client.post(
        "/api/v1/admin/change-password",
        headers=_headers(csrf),
        json={
            "current_password": bootstrap["password"],
            "new_password": "new-password-123",
        },
    )
    assert throttled.status_code == 429
    assert throttled.json()["error_code"] == "PASSWORD_CHANGE_THROTTLED"

    authenticate = app.state.auth.authenticate

    def authenticate_then_revoke(token: str | None):
        identity = authenticate(token)
        with control.transaction() as connection:
            connection.execute(
                "UPDATE sessions SET revoked_at=? WHERE id=?",
                ("2026-01-01T00:00:00+00:00", identity.session_id),
            )
        return identity

    app.state.auth.authenticate = authenticate_then_revoke
    rejected = client.post(
        "/api/v1/admin/change-password",
        headers=_headers(csrf),
        json={
            "current_password": bootstrap["password"],
            "new_password": "another-password-123",
        },
    )
    assert rejected.status_code == 403
    assert rejected.json()["error_code"] == "ADMIN_REQUIRED"


@pytest.mark.parametrize("operation", ["login", "switch-workspace"])
def test_password_change_blocks_in_flight_session_creation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str,
) -> None:
    app = create_app(settings=_settings(tmp_path))
    manager = app.state.auth
    control: ControlStore = manager.control
    first = control.init_workspace("first", "First")
    second = control.init_workspace("second", "Second")
    bootstrap = bootstrap_admin(control, "admin.user", "Admin")
    client, csrf, _ = _login(app, "admin.user", bootstrap["password"], first.id)
    changer, changer_csrf, _ = _login(app, "admin.user", bootstrap["password"], first.id)
    original_create = manager._create_session
    changed = False

    def change_before_create(
        user_id: str, workspace_id: str, *, expected_user_version: int | None = None,
        source_session_id: str | None = None,
    ) -> tuple[RequestIdentity, str, str]:
        nonlocal changed
        if not changed:
            changed = True
            response = changer.post(
                "/api/v1/admin/change-password", headers=_headers(changer_csrf),
                json={"current_password": bootstrap["password"],
                      "new_password": "new-concurrent-password"},
            )
            assert response.status_code == 200
        return original_create(
            user_id, workspace_id, expected_user_version=expected_user_version,
            source_session_id=source_session_id,
        )

    monkeypatch.setattr(manager, "_create_session", change_before_create)
    if operation == "login":
        response = TestClient(app).post(
            "/api/v1/auth/login", headers={"Origin": ORIGIN},
            json={"username": "admin.user", "password": bootstrap["password"],
                  "workspace_id": first.id},
        )
    else:
        response = client.post(
            "/api/v1/auth/switch-workspace", headers=_headers(csrf),
            json={"workspace_id": second.id},
        )
    assert response.status_code == 401
    with sqlite3.connect(control.path) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM sessions WHERE user_id=? AND revoked_at IS NULL",
            (bootstrap["account"]["id"],),
        ).fetchone()[0] == 0
    _login(app, "admin.user", "new-concurrent-password", second.id)
