from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from app.main import create_app
from app.pilot.admin import bootstrap_admin
from app.pilot.auth import ControlStore, verify_password
from app.pilot.config import Settings
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
