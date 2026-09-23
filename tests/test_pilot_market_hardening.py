from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from app.core import DomainError
from app.evidence import current_evidence
from app.persistence.store import Store, Tx, encode
from app.pilot.context import RequestIdentity, WorkspaceMember, bind_request
from app.pilot.jobs import cancel, claim, complete, enqueue, mark_dispatched, recover_leases
from app.pilot.services import PilotServices
from app.selection.market_intake import persist_discovery, select_item

NOW = datetime(2026, 9, 20, 8, tzinfo=UTC)


def _identity(workspace_id: str, actor: str, role: str) -> RequestIdentity:
    return RequestIdentity(
        user_id=actor,
        username=actor,
        display_name=actor,
        workspace_id=workspace_id,
        workspace_name="Test workspace",
        workspace_slug="test-workspace",
        role=role,
        session_id="worker",
        csrf_hash="",
        expires_at="",
        members=(WorkspaceMember(actor, actor, role),),
    )


def _project(tx: Tx, *, analyst: str = "analyst") -> dict[str, Any]:
    return tx.add(
        "project",
        {
            "name": "Market project",
            "channel": "AMAZON",
            "market": "US",
            "analyst_id": analyst,
            "decision_owner_id": "owner",
            "current_criteria_id": "criteria-1",
        },
    )


def _market_output(
    value: str,
    *,
    stable_id: str = "provider:us:ITEM-1",
    raw: str = "licensed-raw",
) -> dict[str, Any]:
    return {
        "coverage": "COVERED",
        "provider": "provider",
        "channel": "AMAZON",
        "market": "US",
        "query": "lamp",
        "is_demo": False,
        "meta": {
            "request_id": "request-1",
            "raw_response_hash": "hash-1",
            "raw": {"licensed": raw},
        },
        "items": [
            {
                "external_id": "ITEM-1",
                "name": "Lamp",
                "source_url": "https://market.example/items/1",
                "stable_id": stable_id,
                "offer_id": f"{stable_id}:offer:merchant",
                "observations": [
                    {"field": "price", "value": value, "unit": "per_item", "currency": "USD"}
                ],
            }
        ],
    }


def test_discovery_current_check_revalidates_bound_analyst_role(tmp_path: Path) -> None:
    store = Store(tmp_path / "auth.sqlite3", mode="pilot", workspace_id="workspace-1")
    with store.transaction(NOW) as tx:
        project = _project(tx, analyst="user-1")
    job = {
        "job_kind": "discovery",
        "project_id": project["id"],
        "actor_id": "user-1",
        "input_snapshot": {"project_version": project["version"]},
    }

    with bind_request(_identity("workspace-1", "user-1", "analyst"), store):
        with store.transaction(NOW) as tx:
            assert PilotServices.input_is_current(tx, job) is True

    with bind_request(_identity("workspace-1", "user-1", "contributor"), store):
        with store.transaction(NOW) as tx:
            with pytest.raises(DomainError) as downgraded:
                PilotServices.input_is_current(tx, job)
    assert downgraded.value.code == "ROLE_NOT_ALLOWED"

    with store.transaction(NOW) as tx:
        tx.update(project["id"], {"analyst_id": "user-2"})
    with bind_request(_identity("workspace-1", "user-1", "analyst"), store):
        with store.transaction(NOW) as tx:
            with pytest.raises(DomainError) as reassigned:
                PilotServices.input_is_current(tx, job)
    assert reassigned.value.code == "ROLE_NOT_ALLOWED"


def _enqueue_discovery(store: Store, project_id: str, suffix: str) -> dict[str, Any]:
    with store.transaction(NOW) as tx:
        return enqueue(
            tx,
            "analyst",
            "discovery",
            {
                "provider": "provider",
                "query": suffix,
                "project_version": 1,
                "retention_days": 30,
            },
            project_id,
            max_attempts=2,
        )


def _assert_no_raw_attempts(store: Store) -> None:
    with store.transaction(NOW) as tx:
        attempts = tx.list("job_attempt")
    assert "licensed-raw" not in encode(attempts)
    assert all(
        "raw" not in (attempt.get("output_snapshot") or {}).get("meta", {})
        for attempt in attempts
    )


def test_market_raw_is_ttl_controlled_and_absent_from_all_job_snapshots(tmp_path: Path) -> None:
    store = Store(tmp_path / "raw.sqlite3")
    with store.transaction(NOW) as tx:
        project = _project(tx)
    services = PilotServices()
    output = _market_output("19.50")

    adopted_job = _enqueue_discovery(store, project["id"], "adopted")
    adopted_lease = claim(store, NOW)
    assert adopted_lease is not None
    mark_dispatched(store, adopted_job["id"], adopted_lease["lease_token"], NOW)
    adopted = complete(
        store,
        adopted_job["id"],
        adopted_lease["lease_token"],
        output,
        NOW,
        input_is_current=lambda tx, job: True,
        on_complete=services.on_complete,
        output_snapshot_sanitizer=services.output_snapshot,
    )
    assert adopted["result_disposition"] == "ADOPTED"
    with store.transaction(NOW) as tx:
        materials = tx.list("source_material", project_id=project["id"])
    assert materials[0]["summary"] == {"licensed": "licensed-raw"}
    assert materials[0]["expires_at"] == (NOW + timedelta(days=30)).isoformat()

    stale_job = _enqueue_discovery(store, project["id"], "stale")
    stale_lease = claim(store, NOW)
    assert stale_lease is not None
    mark_dispatched(store, stale_job["id"], stale_lease["lease_token"], NOW)
    stale = complete(
        store,
        stale_job["id"],
        stale_lease["lease_token"],
        output,
        NOW,
        input_is_current=lambda tx, job: False,
        on_complete=services.on_complete,
        output_snapshot_sanitizer=services.output_snapshot,
    )
    assert stale["result_disposition"] == "STALE"

    cancelled_job = _enqueue_discovery(store, project["id"], "cancelled")
    cancelled_lease = claim(store, NOW)
    assert cancelled_lease is not None
    mark_dispatched(store, cancelled_job["id"], cancelled_lease["lease_token"], NOW)
    with store.transaction(NOW) as tx:
        cancel(tx, "analyst", cancelled_job["id"])
    cancelled = complete(
        store,
        cancelled_job["id"],
        cancelled_lease["lease_token"],
        output,
        NOW,
        on_complete=services.on_complete,
        output_snapshot_sanitizer=services.output_snapshot,
    )
    assert cancelled["result_disposition"] == "CANCELLED"

    expired_job = _enqueue_discovery(store, project["id"], "expired")
    expired_lease = claim(store, NOW, lease_seconds=1)
    assert expired_lease is not None
    mark_dispatched(store, expired_job["id"], expired_lease["lease_token"], NOW)
    expired = complete(
        store,
        expired_job["id"],
        expired_lease["lease_token"],
        output,
        NOW + timedelta(seconds=2),
        on_complete=services.on_complete,
        output_snapshot_sanitizer=services.output_snapshot,
    )
    assert expired["result_disposition"] == "LEASE_EXPIRED_LATE"

    late_job = _enqueue_discovery(store, project["id"], "late")
    first_lease = claim(store, NOW, lease_seconds=1)
    assert first_lease is not None
    recover_leases(store, NOW + timedelta(seconds=2))
    second_lease = claim(store, NOW + timedelta(seconds=2), lease_seconds=10)
    assert second_lease is not None
    late = complete(
        store,
        late_job["id"],
        first_lease["lease_token"],
        output,
        NOW + timedelta(seconds=3),
        on_complete=services.on_complete,
        output_snapshot_sanitizer=services.output_snapshot,
    )
    assert late["status"] == "RUNNING"
    _assert_no_raw_attempts(store)
    with store.transaction(NOW) as tx:
        assert len(tx.list("source_material", project_id=project["id"])) == 1


def _persist_batch(
    store: Store,
    project_id: str,
    when: datetime,
    value: str,
    *,
    stable_id: str,
) -> tuple[str, str]:
    with store.transaction(when) as tx:
        result = persist_discovery(
            tx, project_id, _market_output(value, stable_id=stable_id), retention_days=30
        )
    return result["batch"]["id"], result["batch"]["item_ids"][0]


def test_market_selection_never_rolls_current_evidence_back(tmp_path: Path) -> None:
    store = Store(tmp_path / "ordering.sqlite3")
    with store.transaction(NOW) as tx:
        project = _project(tx)
    older = _persist_batch(
        store, project["id"], NOW, "10.00", stable_id="provider:us:ORDERED"
    )
    newer = _persist_batch(
        store,
        project["id"],
        NOW + timedelta(hours=1),
        "20.00",
        stable_id="provider:us:ORDERED",
    )

    with store.transaction(NOW + timedelta(hours=2)) as tx:
        selected_newer = select_item(tx, "analyst", project["id"], *newer)
        select_item(tx, "analyst", project["id"], *older)
        evidence = tx.list("evidence", candidate_id=selected_newer["candidate"]["id"])
        sources = tx.list("source", candidate_id=selected_newer["candidate"]["id"])
    assert [item["value"] for item in current_evidence(evidence)] == ["20.00"]
    assert len(evidence) == 1
    assert len(sources) == 2


def test_equal_timestamp_observations_use_stable_batch_item_order(tmp_path: Path) -> None:
    store = Store(tmp_path / "tie.sqlite3")
    with store.transaction(NOW) as tx:
        project = _project(tx)
    first = _persist_batch(
        store, project["id"], NOW, "10.00", stable_id="provider:us:TIED"
    )
    second = _persist_batch(
        store, project["id"], NOW, "20.00", stable_id="provider:us:TIED"
    )
    ordered = sorted((first, second))
    expected_value = "10.00" if ordered[-1] == first else "20.00"

    with store.transaction(NOW + timedelta(hours=1)) as tx:
        selected = select_item(tx, "analyst", project["id"], *ordered[-1])
        select_item(tx, "analyst", project["id"], *ordered[0])
        evidence = tx.list("evidence", candidate_id=selected["candidate"]["id"])
    assert [item["value"] for item in current_evidence(evidence)] == [expected_value]
    assert len(evidence) == 1

    third = _persist_batch(
        store, project["id"], NOW, "30.00", stable_id="provider:us:TIED-REVERSE"
    )
    fourth = _persist_batch(
        store, project["id"], NOW, "40.00", stable_id="provider:us:TIED-REVERSE"
    )
    reverse_ordered = sorted((third, fourth))
    reverse_expected = "30.00" if reverse_ordered[-1] == third else "40.00"
    with store.transaction(NOW + timedelta(hours=1)) as tx:
        selected = select_item(tx, "analyst", project["id"], *reverse_ordered[0])
        select_item(tx, "analyst", project["id"], *reverse_ordered[-1])
        evidence = tx.list("evidence", candidate_id=selected["candidate"]["id"])
    assert [item["value"] for item in current_evidence(evidence)] == [reverse_expected]
    assert len(evidence) == 2
