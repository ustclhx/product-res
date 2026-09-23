from __future__ import annotations

from pathlib import Path

from app.api.routes.workbench import router
from app.demo.service import SAMPLE_VERSION
from app.main import create_app
from app.persistence.store import Store
from fastapi.testclient import TestClient


def _client(path: Path) -> TestClient:
    app = create_app(path)
    if not any(getattr(route, "path", None) == "/api/v1/demo" for route in app.routes):
        app.include_router(router, prefix="/api/v1")
    return TestClient(app)


def _initialize(client: TestClient, key: str = "demo-init") -> dict[str, object]:
    response = client.post(
        "/api/v1/demo/init",
        headers={"Idempotency-Key": key},
        json={"actor_id": "owner", "expected_version": None},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_empty_database_never_seeds_on_read_or_restart(tmp_path: Path) -> None:
    path = tmp_path / "empty.sqlite3"
    first = _client(path)
    assert first.get("/api/v1/demo").json() == {
        "actors": [
            {"id": "analyst", "name": "林晓 · 选品分析", "role": "analyst"},
            {"id": "owner", "name": "陈越 · 决策负责人", "role": "decision"},
            {"id": "contributor", "name": "周宁 · 采购协作", "role": "contributor"},
        ],
        "initialized": False,
        "has_business_data": False,
        "sample_version": SAMPLE_VERSION,
        "clock": "2026-09-20T08:00:00+00:00",
        "version": None,
    }
    assert first.get("/api/v1/workbench").json()["pending_evidence"] == []

    restarted = _client(path)
    assert restarted.get("/api/v1/demo").json()["initialized"] is False
    with Store(path).transaction() as tx:
        assert tx.list("project") == []


def test_explicit_seed_has_each_queue_and_honest_outcome_coverage(tmp_path: Path) -> None:
    path = tmp_path / "seed.sqlite3"
    client = _client(path)
    initialized = _initialize(client)
    assert initialized["initialized"] is True
    assert initialized["version"] == 1
    assert len(initialized["projects"]) == 3

    board = client.get("/api/v1/workbench").json()
    assert len(board["pending_evidence"]) == 1
    assert len(board["pending_review"]) == 1
    assert len(board["overdue"]) == 1
    assert len(board["pending_outcomes"]) == 1
    for queue_name in ("pending_evidence", "pending_review", "overdue", "pending_outcomes"):
        assert {"candidate_id", "title", "reason", "next_action"} <= set(board[queue_name][0])
    assert board["coverage"]["missing"]["count"] == 2
    assert board["coverage"]["not_launched"]["count"] == 1
    assert board["coverage"]["recorded"]["count"] == 1

    with Store(path).transaction() as tx:
        rows = tx.connection.execute("SELECT data FROM entities").fetchall()
        assert rows
        assert all('"is_demo":true' in row["data"] for row in rows)

    restarted = _client(path)
    assert restarted.get("/api/v1/demo").json()["version"] == 1
    assert restarted.get("/api/v1/workbench").json() == board


def test_reset_is_versioned_idempotent_and_isolated_to_its_database(tmp_path: Path) -> None:
    first_path = tmp_path / "first.sqlite3"
    other_path = tmp_path / "other.sqlite3"
    first = _client(first_path)
    other = _client(other_path)
    _initialize(first, "first-init")
    _initialize(other, "other-init")

    effort = first.post(
        "/api/v1/effort-entries",
        headers={"Idempotency-Key": "effort-one"},
        json={
            "actor_id": "analyst",
            "expected_version": 1,
            "category": "VERIFICATION",
            "minutes": 20,
            "notes": "核验供应商报价",
        },
    )
    assert effort.status_code == 200
    assert effort.json()["version"] == 2
    assert effort.json()["item"]["is_demo"] is True

    stale = first.post(
        "/api/v1/demo/reset",
        headers={"Idempotency-Key": "stale-reset"},
        json={
            "actor_id": "owner",
            "expected_version": 1,
            "sample_version": SAMPLE_VERSION,
        },
    )
    assert stale.status_code == 409
    assert stale.json()["error_code"] == "VERSION_CONFLICT"

    payload = {
        "actor_id": "owner",
        "expected_version": 2,
        "sample_version": SAMPLE_VERSION,
    }
    first_reset = first.post(
        "/api/v1/demo/reset",
        headers={"Idempotency-Key": "reset-current"},
        json=payload,
    )
    retry = first.post(
        "/api/v1/demo/reset",
        headers={"Idempotency-Key": "reset-current"},
        json=payload,
    )
    assert first_reset.status_code == retry.status_code == 200
    assert first_reset.json() == retry.json()
    assert first_reset.json()["version"] == 3
    assert first.get("/api/v1/effort-entries").json()["items"] == []
    assert other.get("/api/v1/demo").json()["version"] == 1
    assert len(other.get("/api/v1/workbench").json()["pending_evidence"]) == 1


def test_effort_never_fabricates_efficiency_and_activity_is_filterable(tmp_path: Path) -> None:
    client = _client(tmp_path / "effort.sqlite3")
    _initialize(client)
    response = client.post(
        "/api/v1/effort-entries",
        headers={"Idempotency-Key": "effort-record"},
        json={
            "actor_id": "contributor",
            "expected_version": 1,
            "category": "CORRECTION",
            "minutes": 15,
            "notes": "修正币种口径",
            "is_demo": False,
        },
    )
    assert response.status_code == 200
    entry = response.json()["item"]
    listing = client.get("/api/v1/effort-entries").json()
    assert listing["items"][0]["id"] == entry["id"]
    assert listing["items"][0]["is_demo"] is False
    assert listing["validation"] == {
        "status": "PENDING_BASELINE",
        "has_baseline": False,
        "efficiency_percentage": None,
        "message": "尚无人工流程基线，不能计算效率收益",
    }

    all_activity = client.get("/api/v1/activity").json()["items"]
    assert any(item["action"] == "effort.record" for item in all_activity)
    filtered = client.get("/api/v1/activity", params={"entity_id": "demo-workspace"}).json()[
        "items"
    ]
    assert filtered and {item["entity_id"] for item in filtered} == {"demo-workspace"}


def test_manual_workspace_can_record_effort_without_loading_demo(tmp_path: Path) -> None:
    client = _client(tmp_path / "manual.sqlite3")
    project = client.post(
        "/api/v1/projects",
        headers={"Idempotency-Key": "manual-project"},
        json={
            "actor_id": "analyst",
            "name": "手工项目",
            "channel": "DTC",
            "market": "US",
            "goal": "验证手工路径",
            "analyst_id": "analyst",
            "decision_owner_id": "owner",
        },
    )
    assert project.status_code == 200
    status = client.get("/api/v1/demo").json()
    assert status["has_business_data"] is True and status["initialized"] is False
    effort = client.post(
        "/api/v1/effort-entries",
        headers={"Idempotency-Key": "effort"},
        json={
            "actor_id": "analyst",
            "category": "VERIFICATION",
            "minutes": 15,
            "notes": "实际核验工时",
            "is_demo": False,
        },
    )
    assert effort.status_code == 200, effort.text
    assert effort.json()["item"]["is_demo"] is False
    assert client.get("/api/v1/demo").json()["initialized"] is False


def test_workbench_preserves_all_active_evidence_responsibilities(tmp_path: Path) -> None:
    path = tmp_path / "all-responsibilities.sqlite3"
    client = _client(path)
    _initialize(client)
    before = client.get("/api/v1/workbench").json()["pending_evidence"][0]
    with Store(path).transaction() as tx:
        candidate = tx.get(before["candidate_id"], "candidate")
        task = tx.add(
            "task",
            {
                "type": "EVIDENCE", "field": "vehicle_fitment",
                "question": "检查实车适配", "owner_id": "contributor",
                "due_at": "2026-10-01T08:00:00+00:00", "state": "BLOCKED",
                "completion_criteria": "留存样品与实车检查记录",
            },
            project_id=candidate["project_id"], candidate_id=candidate["id"],
        )
    after = client.get("/api/v1/workbench").json()["pending_evidence"][0]
    assert after["task_count"] == before["task_count"] + 1
    visible = next(item for item in after["evidence_tasks"] if item["id"] == task["id"])
    assert visible["owner_id"] == "contributor"
    assert visible["state"] == "BLOCKED"
    assert visible["completion_criteria"] == "留存样品与实车检查记录"
