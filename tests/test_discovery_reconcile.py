from __future__ import annotations

import json
from collections.abc import Callable
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from app.core import DomainError
from app.persistence.store import Store, Tx
from app.pilot.context import RequestIdentity, WorkspaceMember, bind_request
from app.pilot.jobs import ExternalJobError, claim, enqueue, fail, mark_dispatched
from app.pilot.reconcile import fetch_dataforseo_recovery, reconcile_discovery
from app.providers.market import HttpResponse

NOW = datetime(2026, 9, 21, 8, 23, 52, tzinfo=UTC)
TASK_ID = "09210823-2580-0644-0000-2625a1dc6566"
QUERY = "car seat back organizer"


def _identity(role: str = "analyst") -> RequestIdentity:
    return RequestIdentity(
        user_id="analyst",
        username="analyst",
        display_name="Analyst",
        workspace_id="workspace-1",
        workspace_name="Workspace",
        workspace_slug="workspace",
        role=role,
        session_id="session",
        csrf_hash="",
        expires_at="",
        members=(WorkspaceMember("analyst", "Analyst", role),),
    )


def _project(tx: Tx) -> dict[str, Any]:
    return tx.add(
        "project",
        {
            "name": "Amazon research",
            "channel": "AMAZON",
            "market": "US",
            "analyst_id": "analyst",
            "decision_owner_id": "owner",
            "current_criteria_id": "criteria-1",
        },
    )


def _unknown_job(
    store: Store, *, workspace: str = "workspace-1"
) -> tuple[dict[str, Any], dict[str, Any]]:
    with bind_request(_identity(), store), store.transaction(NOW) as tx:
        project = _project(tx)
        job = enqueue(
            tx,
            "analyst",
            "discovery",
            {
                "workspace_id": workspace,
                "provider": "dataforseo",
                "query": QUERY,
                "channel": "AMAZON",
                "market": "US",
                "project_version": project["version"],
                "retention_days": 7,
            },
            project["id"],
            max_attempts=1,
        )
    leased = claim(store, NOW, worker_id="worker", lease_seconds=60)
    assert leased is not None
    mark_dispatched(store, job["id"], str(leased["lease_token"]), NOW)
    failed = fail(
        store,
        job["id"],
        str(leased["lease_token"]),
        ExternalJobError("MARKET_UNKNOWN", "timeout", outcome_unknown=True),
        NOW + timedelta(seconds=30),
    )
    return project, failed


def _audit() -> dict[str, Any]:
    return {
        "id": TASK_ID,
        "url": "v3/merchant/amazon/products/live/advanced",
        "datetime_posted": "2026-09-21 08:24:22 +00:00",
        "datetime_done": "2026-09-21 08:24:22 +00:00",
        "status": 20000,
        "cost": 0.0033,
        "metadata": {
            "api": "merchant",
            "function": "products",
            "se": "amazon",
            "language_code": "en_US",
            "location_code": 2840,
            "keyword": QUERY,
            "depth": 10,
            "se_type": "organic",
            "device": "desktop",
            "os": "windows",
        },
    }


def _task_document() -> dict[str, Any]:
    parameters = {"keyword": QUERY, "location_code": 2840, "language_code": "en_US"}
    return {
        "status_code": 20000,
        "cost": 0,
        "tasks": [
            {
                "id": TASK_ID,
                "status_code": 20000,
                "cost": 0,
                "data": parameters,
                "result_count": 1,
                "result": [
                    {
                        **parameters,
                        "type": "organic",
                        "se_domain": "amazon.com",
                        "items": [
                            {
                                "data_asin": "B012345678",
                                "title": "Seat organizer",
                                "url": "https://www.amazon.com/dp/B012345678?tag=tracking",
                                "price_from": 29.99,
                                "currency": "USD",
                            }
                        ],
                    }
                ],
            }
        ],
    }


def _recover(
    store: Store,
    job: dict[str, Any],
    document: dict[str, Any] | None = None,
    audit: dict[str, Any] | None = None,
    *,
    role: str = "analyst",
) -> dict[str, Any]:
    with bind_request(_identity(role), store), store.transaction(NOW + timedelta(minutes=2)) as tx:
        return reconcile_discovery(
            tx,
            "analyst",
            job["id"],
            document or _task_document(),
            audit or _audit(),
            job["version"],
        )


def test_reconcile_success_is_idempotent_and_preserves_unknown_attempt(tmp_path: Path) -> None:
    store = Store(tmp_path / "reconcile.sqlite3", mode="pilot", workspace_id="workspace-1")
    _project_row, job = _unknown_job(store)
    with store.transaction(NOW) as tx:
        attempt_before = tx.get(str(job["active_attempt_id"]), "job_attempt")

    recovered = _recover(store, job)
    assert recovered["reused"] is False
    assert recovered["job"]["status"] == "SUCCEEDED"
    assert recovered["job"]["last_error"] is None
    assert recovered["job"]["reconciliation"]["query_resent"] is False
    assert recovered["job"]["reconciliation"]["id_list_cost"] == 0.0033
    assert recovered["job"]["reconciliation"]["task_get_cost"] == {
        "response": 0.0,
        "task": 0.0,
    }
    assert recovered["result"]["batch"]["cost"] == 0.0033

    replayed = _recover(store, job)
    assert replayed["reused"] is True
    assert replayed["result"]["batch"]["id"] == recovered["result"]["batch"]["id"]
    with store.transaction(NOW) as tx:
        assert len(tx.list("discovery_batch")) == 1
        assert tx.get(str(job["active_attempt_id"]), "job_attempt") == attempt_before
        audit = tx.activity(job["id"])
    assert [row["action"] for row in audit].count("JOB_DISCOVERY_RECONCILED") == 1


def test_reconcile_rejects_wrong_workspace_and_role_without_writes(tmp_path: Path) -> None:
    store = Store(tmp_path / "auth.sqlite3", mode="pilot", workspace_id="workspace-1")
    _project_row, wrong_workspace = _unknown_job(store, workspace="workspace-2")
    with pytest.raises(DomainError) as workspace_error:
        _recover(store, wrong_workspace)
    assert workspace_error.value.code == "WORKSPACE_ACCESS_DENIED"

    store2 = Store(tmp_path / "role.sqlite3", mode="pilot", workspace_id="workspace-1")
    _project_row, job = _unknown_job(store2)
    with pytest.raises(DomainError) as role_error:
        _recover(store2, job, role="contributor")
    assert role_error.value.code == "ROLE_NOT_ALLOWED"
    with store2.transaction(NOW) as tx:
        assert tx.list("discovery_batch") == []


Mutation = Callable[[Store, dict[str, Any], dict[str, Any], dict[str, Any]], None]


def _cancelled(
    store: Store, job: dict[str, Any], _document: dict[str, Any], _audit_row: dict[str, Any]
) -> None:
    with store.transaction(NOW) as tx:
        tx.update(job["id"], {"cancel_requested_at": NOW.isoformat()})
    job["version"] += 1


def _not_unknown(
    store: Store, job: dict[str, Any], _document: dict[str, Any], _audit_row: dict[str, Any]
) -> None:
    with store.transaction(NOW) as tx:
        tx.update(job["id"], {"status": "FAILED"})
    job["version"] += 1


def _stale_project(
    store: Store, job: dict[str, Any], _document: dict[str, Any], _audit_row: dict[str, Any]
) -> None:
    with store.transaction(NOW) as tx:
        tx.update(str(job["project_id"]), {"name": "changed"})


def _wrong_task(
    _store: Store, _job: dict[str, Any], document: dict[str, Any], _audit_row: dict[str, Any]
) -> None:
    document["tasks"][0]["id"] = "other-task"


def _wrong_query(
    _store: Store, _job: dict[str, Any], document: dict[str, Any], _audit_row: dict[str, Any]
) -> None:
    document["tasks"][0]["data"]["keyword"] = "other"


def _wrong_location(
    _store: Store, _job: dict[str, Any], document: dict[str, Any], _audit_row: dict[str, Any]
) -> None:
    document["tasks"][0]["result"][0]["location_code"] = 2826


def _wrong_language(
    _store: Store, _job: dict[str, Any], document: dict[str, Any], _audit_row: dict[str, Any]
) -> None:
    document["tasks"][0]["result"][0]["language_code"] = "en_GB"


@pytest.mark.parametrize(
    ("mutation", "code"),
    [
        (_cancelled, "RECONCILIATION_CANCELLED"),
        (_not_unknown, "RECONCILIATION_STATE_INVALID"),
        (_stale_project, "RECONCILIATION_INPUT_STALE"),
        (_wrong_task, "RECONCILIATION_TASK_MISMATCH"),
        (_wrong_query, "RECONCILIATION_INPUT_MISMATCH"),
        (_wrong_location, "RECONCILIATION_INPUT_MISMATCH"),
        (_wrong_language, "RECONCILIATION_INPUT_MISMATCH"),
    ],
)
def test_reconcile_rejections_are_atomic(tmp_path: Path, mutation: Mutation, code: str) -> None:
    store = Store(tmp_path / f"{code}.sqlite3", mode="pilot", workspace_id="workspace-1")
    _project_row, job = _unknown_job(store)
    document, audit = deepcopy(_task_document()), deepcopy(_audit())
    mutation(store, job, document, audit)
    with pytest.raises(DomainError) as caught:
        _recover(store, job, document, audit)
    assert caught.value.code == code
    with store.transaction(NOW) as tx:
        assert tx.list("discovery_batch") == []
        assert tx.list("source_material") == []


def test_reconcile_rejects_zero_id_list_cost_and_different_replay_task(tmp_path: Path) -> None:
    store = Store(tmp_path / "cost.sqlite3", mode="pilot", workspace_id="workspace-1")
    _project_row, job = _unknown_job(store)
    free_query = _audit()
    free_query["cost"] = 0
    with pytest.raises(DomainError) as cost_error:
        _recover(store, job, audit=free_query)
    assert cost_error.value.code == "RECONCILIATION_EVIDENCE_INVALID"

    recovered = _recover(store, job)
    other = _audit()
    other["id"] = "different-task"
    with pytest.raises(DomainError) as conflict:
        _recover(store, job, audit=other)
    assert conflict.value.code == "RECONCILIATION_CONFLICT"
    assert recovered["result"]["batch"]["cost"] == 0.0033


def test_recovery_fetches_only_fixed_provider_endpoints(tmp_path: Path) -> None:
    store = Store(tmp_path / "fetch.sqlite3", mode="pilot", workspace_id="workspace-1")
    _project_row, job = _unknown_job(store)
    with store.transaction(NOW) as tx:
        attempt = tx.get(str(job["active_attempt_id"]), "job_attempt")
    secret = tmp_path / "secret"
    secret.write_text("login:password", encoding="utf-8")

    class Transport:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str, bytes | None]] = []

        def request(
            self,
            method: str,
            url: str,
            *,
            headers: dict[str, str],
            body: bytes | None,
            timeout: float,
            max_bytes: int,
        ) -> HttpResponse:
            self.calls.append((method, url, body))
            document = (
                {"status_code": 20000, "tasks": [{"result": [_audit()]}]}
                if method == "POST"
                else _task_document()
            )
            return HttpResponse(200, {}, json.dumps(document).encode())

    transport = Transport()
    document, audit = fetch_dataforseo_recovery(
        {"secret_file": str(secret), "timeout_seconds": 30, "licensed": True},
        TASK_ID,
        attempt,
        NOW + timedelta(minutes=2),
        transport=transport,
    )

    assert audit["id"] == TASK_ID
    assert document["tasks"][0]["id"] == TASK_ID
    assert [(method, url) for method, url, _body in transport.calls] == [
        ("POST", "https://api.dataforseo.com/v3/merchant/id_list"),
        (
            "GET",
            "https://api.dataforseo.com/v3/merchant/amazon/products/task_get/advanced/"
            + TASK_ID,
        ),
    ]
    assert json.loads(transport.calls[0][2] or b"null")[0]["include_metadata"] is True


def test_recovery_requires_current_provider_authorization() -> None:
    with pytest.raises(DomainError) as caught:
        fetch_dataforseo_recovery({"licensed": False}, "task", {}, datetime.now(UTC))
    assert caught.value.code == "RECONCILIATION_PROVIDER_NOT_READY"
