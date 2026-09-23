from __future__ import annotations

import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from app.core import DomainError
from app.persistence.store import Store, Tx
from app.pilot.jobs import (
    CANCELLED,
    OUTCOME_UNKNOWN,
    QUEUED,
    RUNNING,
    SUCCEEDED,
    ExternalJobError,
    cancel,
    claim,
    complete,
    enqueue,
    fail,
    get_public,
    mark_dispatched,
    process_one,
    recover_leases,
)

NOW = datetime(2026, 9, 20, 8, tzinfo=UTC)


def _store(tmp_path: Path) -> tuple[Store, str]:
    store = Store(tmp_path / "pilot-jobs.sqlite3")
    with store.transaction(NOW) as tx:
        project = tx.add("project", {"name": "pilot"})
    return store, str(project["id"])


def _enqueue(store: Store, project_id: str, **kwargs: Any) -> dict[str, Any]:
    with store.transaction(NOW) as tx:
        return enqueue(
            tx,
            "analyst",
            "DISCOVERY",
            kwargs.pop("input_snapshot", {"query": "desk lamp"}),
            project_id,
            **kwargs,
        )


def test_enqueue_is_deduplicated_and_public_view_hides_snapshots(tmp_path: Path) -> None:
    store, project_id = _store(tmp_path)
    first = _enqueue(
        store,
        project_id,
        dedupe_key="request-1",
        input_snapshot={"query": "lamp", "api_key": "must-not-leak"},
    )
    replay = _enqueue(
        store,
        project_id,
        dedupe_key="request-1",
        input_snapshot={"api_key": "must-not-leak", "query": "lamp"},
    )
    assert replay["id"] == first["id"]
    with store.transaction(NOW) as tx:
        public = get_public(tx, first["id"])
    assert "input_snapshot" not in public
    assert "dedupe_key" not in public
    assert "lease_token" not in public
    assert public["input_metadata"]["keys"] == ["api_key", "query"]
    assert "must-not-leak" not in repr(public)

    with pytest.raises(DomainError, match="同一任务请求标识"):
        _enqueue(
            store,
            project_id,
            dedupe_key="request-1",
            input_snapshot={"query": "different"},
        )


def test_duplicate_claim_and_finish_create_one_business_result(tmp_path: Path) -> None:
    store, project_id = _store(tmp_path)
    queued = _enqueue(store, project_id)
    waiting = _enqueue(store, project_id, input_snapshot={"query": "second"})
    claimed = claim(store, NOW, worker_id="one")
    assert claimed is not None and claimed["id"] == queued["id"]
    assert claim(store, NOW, worker_id="two") is None
    dispatched = mark_dispatched(store, queued["id"], claimed["lease_token"], NOW)
    assert dispatched["status"] == RUNNING

    callback_count = 0

    def adopt(tx: Tx, job: dict[str, Any], output: Any) -> dict[str, Any]:
        nonlocal callback_count
        callback_count += 1
        record = tx.add("source", {"provider_id": output["id"]}, project_id=job["project_id"])
        return {"source_id": record["id"]}

    finished = complete(
        store,
        queued["id"],
        claimed["lease_token"],
        {"id": "remote-1"},
        NOW,
        on_complete=adopt,
    )
    replay = complete(
        store,
        queued["id"],
        claimed["lease_token"],
        {"id": "remote-1"},
        NOW,
        on_complete=adopt,
    )
    assert finished["status"] == replay["status"] == SUCCEEDED
    assert callback_count == 1
    next_claim = claim(store, NOW, worker_id="two")
    assert next_claim is not None and next_claim["id"] == waiting["id"]
    with store.transaction(NOW) as tx:
        assert len(tx.list("source")) == 1
        assert len(tx.list("job_attempt")) == 2


def test_cancelled_and_stale_outputs_are_historical_only(tmp_path: Path) -> None:
    store, project_id = _store(tmp_path)
    cancelled_job = _enqueue(store, project_id)
    lease = claim(store, NOW)
    assert lease is not None
    mark_dispatched(store, cancelled_job["id"], lease["lease_token"], NOW)
    with store.transaction(NOW + timedelta(seconds=1)) as tx:
        cancelled = cancel(tx, "analyst", cancelled_job["id"])
    assert cancelled["status"] == CANCELLED

    adopted = False

    def should_not_adopt(tx: Tx, job: dict[str, Any], output: Any) -> None:
        del tx, job, output
        nonlocal adopted
        adopted = True

    late = complete(
        store,
        cancelled_job["id"],
        lease["lease_token"],
        {"secret": "late"},
        NOW + timedelta(seconds=2),
        on_complete=should_not_adopt,
    )
    assert late["status"] == CANCELLED
    assert adopted is False
    with store.transaction(NOW) as tx:
        attempt = tx.list("job_attempt")[0]
        assert attempt["result_disposition"] == "CANCELLED_LATE"
        assert attempt["output_snapshot"] == {"secret": "late"}

    stale_job = _enqueue(store, project_id, input_snapshot={"version": 1})
    stale_lease = claim(store, NOW + timedelta(seconds=3))
    assert stale_lease is not None
    mark_dispatched(store, stale_job["id"], stale_lease["lease_token"], NOW + timedelta(seconds=3))
    stale = complete(
        store,
        stale_job["id"],
        stale_lease["lease_token"],
        {"draft": "old"},
        NOW + timedelta(seconds=4),
        input_is_current=lambda tx, job: False,
        on_complete=should_not_adopt,
    )
    assert stale["status"] == SUCCEEDED
    assert stale["result_disposition"] == "STALE"
    assert stale["adoptable"] is False
    assert adopted is False


def test_expired_leases_retry_only_before_dispatch(tmp_path: Path) -> None:
    store, project_id = _store(tmp_path)
    before_dispatch = _enqueue(store, project_id, max_attempts=2)
    first = claim(store, NOW, lease_seconds=5)
    assert first is not None
    recovered = recover_leases(store, NOW + timedelta(seconds=6))
    assert recovered[0]["id"] == before_dispatch["id"]
    assert recovered[0]["status"] == QUEUED
    second = claim(store, NOW + timedelta(seconds=6), lease_seconds=5)
    assert second is not None and second["attempt_count"] == 2
    stale_delivery = complete(
        store,
        before_dispatch["id"],
        first["lease_token"],
        {"should": "remain historical"},
        NOW + timedelta(seconds=7),
    )
    assert stale_delivery["status"] == RUNNING
    assert stale_delivery["lease_token"] == second["lease_token"]

    # Exhaust this undispatched attempt, then create a separate dispatched case.
    exhausted = recover_leases(store, NOW + timedelta(seconds=12))[0]
    assert exhausted["status"] == "FAILED"
    after_dispatch = _enqueue(store, project_id)
    dispatched = claim(store, NOW + timedelta(seconds=13), lease_seconds=5)
    assert dispatched is not None and dispatched["id"] == after_dispatch["id"]
    mark_dispatched(
        store,
        after_dispatch["id"],
        dispatched["lease_token"],
        NOW + timedelta(seconds=13),
    )
    unknown = recover_leases(store, NOW + timedelta(seconds=19))[0]
    assert unknown["status"] == OUTCOME_UNKNOWN
    assert claim(store, NOW + timedelta(seconds=20)) is None


def test_uncertain_provider_failure_is_not_automatically_retried(tmp_path: Path) -> None:
    store, project_id = _store(tmp_path)
    job = _enqueue(store, project_id, max_attempts=5)
    calls = 0

    def uncertain(_: dict[str, Any]) -> Any:
        nonlocal calls
        calls += 1
        raise ExternalJobError(
            "PROVIDER_TIMEOUT",
            "token=top-secret gateway timeout",
            outcome_unknown=True,
            retryable=True,
        )

    result = process_one(store, uncertain, clock=lambda: NOW)
    assert result is not None and result["id"] == job["id"]
    assert result["status"] == OUTCOME_UNKNOWN
    assert result["attempt_count"] == 1
    assert result["last_error"]["message"] == "token=[redacted] gateway timeout"
    assert process_one(store, uncertain, clock=lambda: NOW) is None
    assert calls == 1


def test_cancel_request_keeps_provider_diagnostic_received_by_failure(tmp_path: Path) -> None:
    store, project_id = _store(tmp_path)
    with store.transaction(NOW) as tx:
        job = enqueue(
            tx,
            "analyst",
            "assistant",
            {
                "usage_context": {
                    "node_kind": "EVIDENCE_CHECKLIST",
                    "model": "deepseek-v3",
                    "input_bytes": 12,
                    "max_output_tokens": 18_000,
                    "max_total_tokens": 200_000,
                }
            },
            project_id,
        )
    claimed = claim(store, NOW)
    assert claimed is not None
    mark_dispatched(store, job["id"], claimed["lease_token"], NOW)
    with store.transaction(NOW) as tx:
        tx.update(job["id"], {"cancel_requested_at": NOW.isoformat()})

    failed = fail(
        store,
        job["id"],
        claimed["lease_token"],
        ExternalJobError(
            "NEWAPI.OUTPUT_TRUNCATED",
            "safe",
            diagnostic={
                "node_kind": "EVIDENCE_CHECKLIST",
                "model": "deepseek-v3",
                "input_bytes": 20,
                "input_tokens": 8,
                "output_tokens": 2,
                "total_tokens": 10,
                "elapsed_ms": 4,
                "max_output_tokens": 18_000,
                "max_total_tokens": 200_000,
                "finish_reason": "length",
            },
        ),
        NOW,
    )
    assert failed["status"] == CANCELLED
    with store.transaction(NOW) as tx:
        receipt = tx.list("model_usage")[0]
    assert receipt["outcome_status"] == "cancelled"
    assert receipt["error_code"] == "NEWAPI.OUTPUT_TRUNCATED"
    assert receipt["total_tokens"] == 10
    assert receipt["finish_reason"] == "length"


def test_slow_provider_does_not_block_other_workspace_writes(tmp_path: Path) -> None:
    store, project_id = _store(tmp_path)
    _enqueue(store, project_id)
    entered = threading.Event()
    release = threading.Event()
    outcome: list[dict[str, Any] | None] = []

    def slow_runner(_: dict[str, Any]) -> dict[str, str]:
        entered.set()
        assert release.wait(timeout=2)
        return {"id": "remote"}

    worker = threading.Thread(
        target=lambda: outcome.append(
            process_one(store, slow_runner, clock=lambda: NOW, lease_seconds=30)
        )
    )
    worker.start()
    assert entered.wait(timeout=2)
    with store.transaction(NOW) as tx:
        tx.add("source", {"value": "concurrent"}, project_id=project_id)
    release.set()
    worker.join(timeout=2)
    assert not worker.is_alive()
    assert outcome[0] is not None and outcome[0]["status"] == SUCCEEDED
    with store.transaction(NOW) as tx:
        assert len(tx.list("source")) == 1
