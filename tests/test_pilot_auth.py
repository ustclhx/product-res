from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from app.main import create_app
from app.persistence.store import Store
from app.pilot.auth import SESSION_COOKIE, ControlStore, verify_password
from app.pilot.cli import _read_password, build_parser
from app.pilot.config import Settings
from app.selection.projects import template_defaults
from fastapi.testclient import TestClient

ORIGIN = "http://localhost"
PASSWORDS = {
    "analyst": "correct horse battery staple",
    "owner": "correct horse battery owner",
    "contributor": "correct horse battery contributor",
}


@pytest.fixture
def pilot(tmp_path: Path) -> dict[str, Any]:
    settings = Settings(
        mode="pilot",
        data_dir=tmp_path,
        public_url=ORIGIN,
        demo_db_path=None,
        control_db_path=tmp_path / "control.sqlite3",
        workspaces_dir=tmp_path / "workspaces",
        session_ttl_seconds=60,
        login_window_seconds=900,
        login_max_failures=3,
    )
    app = create_app(settings=settings)
    control: ControlStore = app.state.auth.control
    users = {
        name: control.create_user(name, name.title(), password)
        for name, password in PASSWORDS.items()
    }
    workspaces = {
        slug: control.init_workspace(slug, slug.title())
        for slug in ("partner", "internal")
    }
    for workspace in workspaces.values():
        control.add_member(workspace.id, users["analyst"]["username"], "analyst")
        control.add_member(workspace.id, users["owner"]["username"], "decision")
    control.add_member(
        workspaces["partner"].id, users["contributor"]["username"], "contributor"
    )
    return {
        "app": app,
        "control": control,
        "users": users,
        "workspaces": workspaces,
    }


def _login(
    pilot: dict[str, Any], username: str = "analyst", workspace: str = "partner"
) -> tuple[TestClient, str, dict[str, Any]]:
    client = TestClient(pilot["app"])
    response = client.post(
        "/api/v1/auth/login",
        headers={"Origin": ORIGIN},
        json={
            "username": username,
            "password": PASSWORDS[username],
            "workspace_id": pilot["workspaces"][workspace].id,
        },
    )
    assert response.status_code == 200, response.text
    return client, response.json()["csrf_token"], response.json()


def _headers(csrf: str, key: str = "auth-test") -> dict[str, str]:
    return {"Origin": ORIGIN, "X-CSRF-Token": csrf, "Idempotency-Key": key}


def _project_payload(pilot: dict[str, Any]) -> dict[str, Any]:
    return {
        "actor_id": pilot["users"]["analyst"]["id"],
        "name": "Auth regression project",
        "channel": "AMAZON",
        "market": "US",
        "direction": "camping lamp",
        "goal": "validate authenticated project access",
        "constraints": ["small first order"],
        "analyst_id": pilot["users"]["analyst"]["id"],
        "decision_owner_id": pilot["users"]["owner"]["id"],
    }


def test_demo_runtime_remains_backward_compatible(tmp_path: Path) -> None:
    client = TestClient(create_app(tmp_path / "demo.sqlite3"))
    assert client.get("/api/v1/health").json()["mode"] == "demo"
    response = client.get("/api/v1/demo")
    assert response.status_code == 200
    assert response.json()["initialized"] is False


def test_pilot_uses_real_utc_clock_and_requires_explicit_workspace(pilot: dict[str, Any]) -> None:
    before = datetime.now(UTC)
    client, _csrf, payload = _login(pilot)
    after = datetime.now(UTC) + timedelta(seconds=1)
    expires_at = datetime.fromisoformat(payload["expires_at"])
    assert before < expires_at < after + timedelta(seconds=60)

    no_workspace = client.post(
        "/api/v1/auth/login",
        headers={"Origin": ORIGIN},
        json={"username": "analyst", "password": PASSWORDS["analyst"]},
    )
    assert no_workspace.status_code == 409
    assert no_workspace.json()["error_code"] == "WORKSPACE_SELECTION_REQUIRED"
    assert len(no_workspace.json()["details"]["workspaces"]) == 2


def test_pilot_rejects_existing_demo_and_unmarked_databases(tmp_path: Path) -> None:
    demo_path = tmp_path / "existing-demo.sqlite3"
    Store(demo_path, mode="demo")
    with pytest.raises(RuntimeError, match=r"模式|mode"):
        Store(demo_path, mode="pilot", workspace_id="workspace")

    unmarked_path = tmp_path / "unmarked.sqlite3"
    with sqlite3.connect(unmarked_path) as connection:
        connection.execute("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)")
        connection.execute("INSERT INTO schema_version VALUES (1)")
    with pytest.raises(RuntimeError, match=r"未标记|marked"):
        Store(unmarked_path, mode="pilot", workspace_id="workspace")


def test_blank_pilot_has_no_workspace_but_health_is_available(tmp_path: Path) -> None:
    settings = Settings(
        mode="pilot",
        data_dir=tmp_path,
        public_url=ORIGIN,
        demo_db_path=None,
        control_db_path=tmp_path / "control.sqlite3",
        workspaces_dir=tmp_path / "workspaces",
    )
    client = TestClient(create_app(settings=settings))
    assert client.get("/api/v1/health").status_code == 200
    session = client.get("/api/v1/auth/session")
    assert session.status_code == 401
    assert session.json()["error_code"] == "AUTH_REQUIRED"


def test_missing_auth_invalid_origin_and_csrf_are_rejected(pilot: dict[str, Any]) -> None:
    client = TestClient(pilot["app"])
    missing = client.get("/api/v1/projects")
    assert missing.status_code == 401
    assert missing.json()["error_code"] == "AUTH_REQUIRED"

    invalid_origin = client.post(
        "/api/v1/auth/login",
        headers={"Origin": "https://attacker.example"},
        json={
            "username": "analyst",
            "password": PASSWORDS["analyst"],
            "workspace_id": pilot["workspaces"]["partner"].id,
        },
    )
    assert invalid_origin.status_code == 403
    assert invalid_origin.json()["error_code"] == "ORIGIN_REJECTED"

    logged_in, csrf, _ = _login(pilot)
    bad_csrf = logged_in.post(
        "/api/v1/projects",
        headers={"Origin": ORIGIN, "X-CSRF-Token": "wrong", "Idempotency-Key": "bad-csrf"},
        json=_project_payload(pilot),
    )
    assert bad_csrf.status_code == 403
    assert bad_csrf.json()["error_code"] == "CSRF_REJECTED"
    missing_csrf = logged_in.post(
        "/api/v1/projects",
        headers={"Origin": ORIGIN, "Idempotency-Key": "missing-csrf"},
        json=_project_payload(pilot),
    )
    assert missing_csrf.status_code == 403
    assert missing_csrf.json()["error_code"] == "CSRF_REJECTED"
    assert csrf


def test_forged_actor_is_rejected_and_role_restrictions_hold(pilot: dict[str, Any]) -> None:
    analyst, csrf, _ = _login(pilot, "analyst")
    forged = _project_payload(pilot)
    forged["actor_id"] = pilot["users"]["owner"]["id"]
    response = analyst.post(
        "/api/v1/projects", headers=_headers(csrf, "forged-actor"), json=forged
    )
    assert response.status_code == 403
    assert response.json()["error_code"] == "FORGED_ACTOR"

    project_response = analyst.post(
        "/api/v1/projects", headers=_headers(csrf, "role-project"), json=_project_payload(pilot)
    )
    assert project_response.status_code == 200, project_response.text
    project = project_response.json()["project"]
    owner, owner_csrf, _ = _login(pilot, "owner")
    defaults = template_defaults("amazon-camping-v1")
    confirmed = owner.post(
        f"/api/v1/projects/{project['id']}/criteria-revisions",
        headers=_headers(owner_csrf, "role-confirm"),
        json={
            **defaults,
            "actor_id": pilot["users"]["owner"]["id"],
            "expected_version": project["version"],
            "parent_revision_id": None,
        },
    )
    assert confirmed.status_code == 200, confirmed.text

    contributor, contributor_csrf, _ = _login(pilot, "contributor")
    denied = contributor.post(
        f"/api/v1/projects/{project['id']}/criteria-revisions",
        headers=_headers(contributor_csrf, "role-contributor"),
        json={
            **defaults,
            "actor_id": pilot["users"]["contributor"]["id"],
            "expected_version": confirmed.json()["project"]["version"],
            "parent_revision_id": confirmed.json()["project"]["current_criteria_id"],
        },
    )
    assert denied.status_code == 403
    assert denied.json()["error_code"] == "ROLE_NOT_ALLOWED"


def test_passwords_are_hashed_and_invalid_username_is_safe(pilot: dict[str, Any]) -> None:
    with sqlite3.connect(pilot["control"].path) as connection:
        row = connection.execute(
            "SELECT password_hash FROM users WHERE username='analyst'"
        ).fetchone()
    assert row is not None
    assert row[0].startswith("scrypt$")
    assert PASSWORDS["analyst"] not in row[0]
    assert verify_password(PASSWORDS["analyst"], row[0])

    client = TestClient(pilot["app"])
    invalid = client.post(
        "/api/v1/auth/login",
        headers={"Origin": ORIGIN},
        json={
            "username": "!!!",
            "password": PASSWORDS["analyst"],
            "workspace_id": pilot["workspaces"]["partner"].id,
        },
    )
    assert invalid.status_code in {401, 422}
    assert invalid.status_code != 500


def test_logout_expiry_and_revocation(pilot: dict[str, Any]) -> None:
    client, csrf, _ = _login(pilot)
    logout = client.post("/api/v1/auth/logout", headers=_headers(csrf, "logout"))
    assert logout.status_code == 200
    assert client.get("/api/v1/auth/session").status_code == 401

    client, _csrf, _ = _login(pilot)
    manager = pilot["app"].state.auth
    manager.clock = lambda: datetime.now(UTC) + timedelta(seconds=120)
    expired = client.get("/api/v1/auth/session")
    assert expired.status_code == 401
    assert expired.json()["error_code"] == "SESSION_EXPIRED"


def test_session_reload_returns_csrf_and_workspace_switch_rotates_cookie(
    pilot: dict[str, Any],
) -> None:
    client, csrf, _ = _login(pilot)
    old_token = client.cookies.get(SESSION_COOKIE)
    reloaded = TestClient(pilot["app"])
    reloaded.cookies.set(SESSION_COOKIE, old_token)
    session = reloaded.get("/api/v1/auth/session")
    assert session.status_code == 200
    assert session.json()["csrf_token"]

    switched = client.post(
        "/api/v1/auth/switch-workspace",
        headers=_headers(csrf, "switch"),
        json={"workspace_id": pilot["workspaces"]["internal"].id},
    )
    assert switched.status_code == 200, switched.text
    assert switched.json()["workspace"]["id"] == pilot["workspaces"]["internal"].id
    new_token = client.cookies.get(SESSION_COOKIE)
    assert new_token and new_token != old_token

    old_session = TestClient(pilot["app"])
    old_session.cookies.set(SESSION_COOKIE, old_token)
    assert old_session.get("/api/v1/auth/session").status_code == 401


def test_login_throttling_and_cli_password_file(tmp_path: Path, pilot: dict[str, Any]) -> None:
    client = TestClient(pilot["app"])
    body = {
        "username": "analyst",
        "password": "wrong password",
        "workspace_id": pilot["workspaces"]["partner"].id,
    }
    for _ in range(pilot["app"].state.settings.login_max_failures):
        response = client.post("/api/v1/auth/login", headers={"Origin": ORIGIN}, json=body)
        assert response.status_code == 401
    throttled = client.post("/api/v1/auth/login", headers={"Origin": ORIGIN}, json=body)
    assert throttled.status_code == 429
    assert throttled.json()["error_code"] == "LOGIN_THROTTLED"

    password_file = tmp_path / "password.txt"
    password_file.write_text("private password\n", encoding="utf-8")
    password_file.chmod(0o600)
    assert _read_password(password_file) == "private password"
    parsed = build_parser().parse_args(
        [
            "create-user",
            "--username",
            "new-user",
            "--display-name",
            "New User",
            "--password-file",
            str(password_file),
        ]
    )
    assert parsed.password_file == password_file
