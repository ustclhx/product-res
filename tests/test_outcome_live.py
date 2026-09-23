from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.core import DomainError
from app.outcomes.service import (
    confirm_csv,
    counts_as_real,
    create_review,
    decide_feedback,
    preview_csv,
    propose_feedback,
    record_outcome,
)
from app.persistence.store import Store
from app.pilot.context import RequestIdentity, WorkspaceMember, bind_request
from tests.test_lifecycle import seed

NOW = datetime(2026, 9, 20, 8, tzinfo=UTC)
METRICS = {
    "revenue": "1000",
    "refunds": "100",
    "procurement": "300",
    "platform": "100",
    "fulfillment": "100",
    "advertising": "100",
    "other": "50",
}


def _prepare(store: Store) -> None:
    with store.transaction(NOW) as tx:
        seed(tx)
        tx.update("candidate-1", {"business_status": "OUTCOME_PENDING"})


def _record(
    tx,
    *,
    origin: str | None,
    source: str = "manual:live",
    revision: str | None = None,
    revenue: str = "1000",
):
    return record_outcome(
        tx,
        "analyst",
        "candidate-1",
        approval_id="approval-1",
        status="RECORDED",
        window_start="2026-09-01T00:00:00Z",
        window_end="2026-10-01T00:00:00Z",
        currency="USD",
        units="10",
        revenue_basis="NET",
        metrics={**METRICS, "revenue": revenue},
        source_locator=source,
        is_demo=False,
        reason=None,
        sku="SKU-1",
        data_origin=origin,
        source_revision=revision,
    )


def test_pilot_requires_explicit_real_or_test_and_separates_real_statistics(tmp_path: Path) -> None:
    store = Store(tmp_path / "pilot.sqlite3", mode="pilot", workspace_id="pilot-a")
    _prepare(store)
    identity = RequestIdentity(
        user_id="analyst",
        username="analyst",
        display_name="analyst",
        workspace_id="pilot-a",
        workspace_name="pilot",
        workspace_slug="pilot",
        role="analyst",
        session_id="test",
        csrf_hash="",
        expires_at="",
        members=(WorkspaceMember("analyst", "analyst", "analyst"),),
    )
    with bind_request(identity, store), store.transaction(NOW) as tx:
        with pytest.raises(DomainError) as missing:
            _record(tx, origin=None)
        assert missing.value.code == "DATA_ORIGIN_REQUIRED"
        with pytest.raises(DomainError) as demo:
            _record(tx, origin="DEMO")
        assert demo.value.code == "DEMO_OUTCOME_FORBIDDEN"
        real, _ = _record(tx, origin="REAL")
        test, _ = _record(tx, origin="TEST")
        assert real["data_origin"] == "REAL" and real["is_demo"] is False
        assert test["data_origin"] == "TEST" and test["is_demo"] is False
        assert counts_as_real(real) is True
        assert counts_as_real(test) is False
        assert len(tx.list("outcome", candidate_id="candidate-1")) == 2


def test_csv_mapping_blocks_ambiguous_sku_and_confirms_explicit_mapping(tmp_path: Path) -> None:
    store = Store(tmp_path / "mapping.sqlite3")
    with store.transaction(NOW) as tx:
        entities = seed(tx)
        tx.update("candidate-1", {"business_status": "OUTCOME_PENDING"})
        second_fields = {
            key: value
            for key, value in entities["candidate"].items()
            if key not in {"id", "kind", "version", "created_at", "project_id", "candidate_id"}
        }
        second_fields["business_status"] = "OUTCOME_PENDING"
        second = tx.add(
            "candidate",
            {**second_fields, "title": "Tent duplicate", "approval_id": "approval-2"},
            entity_id="candidate-2",
            project_id="project-1",
        )
        evaluation_fields = {
            key: value
            for key, value in entities["evaluation"].items()
            if key not in {"id", "kind", "version", "created_at", "project_id", "candidate_id"}
        }
        evaluation = tx.add(
            "evaluation",
            evaluation_fields,
            entity_id="evaluation-2",
            project_id="project-1",
            candidate_id=second["id"],
        )
        tx.add(
            "decision",
            {
                "action": "APPROVE",
                "reason": "test",
                "questions": [],
                "actor_id": "owner",
                "evaluation_id": evaluation["id"],
                "criteria_id": "criteria-1",
            },
            entity_id="approval-2",
            project_id="project-1",
            candidate_id=second["id"],
        )
        csv = "sku,status,reason,data_origin\nSKU-1,NOT_LAUNCHED,未上市等待供应商,REAL\n"
        ambiguous = preview_csv(tx, csv)
        assert ambiguous["rows"][0]["errors"] == ["AMBIGUOUS_MAPPING"]
        mapping = {"candidate_id": "candidate-1", "approval_id": "approval-1"}
        explicit = preview_csv(tx, csv, {"2": mapping})
        assert explicit["rows"][0]["valid"] is True
        confirmed = confirm_csv(tx, "analyst", csv, explicit["content_hash"], [2], {"2": mapping})
        assert confirmed["items"][0]["data_origin"] == "REAL"


def test_same_content_idempotent_changed_content_requires_revision_and_preserves_snapshots(
    tmp_path: Path,
) -> None:
    store = Store(tmp_path / "revision.sqlite3")
    with store.transaction(NOW) as tx:
        seed(tx)
        tx.update("candidate-1", {"business_status": "OUTCOME_PENDING"})
        first, duplicate = _record(tx, origin="REAL", source="csv:2")
        replay, duplicate = _record(tx, origin="REAL", source="csv:2")
        assert duplicate is True and replay["id"] == first["id"]
        with pytest.raises(DomainError) as conflict:
            _record(tx, origin="REAL", source="csv:2", revenue="1100")
        assert conflict.value.code == "OUTCOME_SOURCE_CONFLICT"
        revised, duplicate = _record(tx, origin="REAL", source="csv:2", revision="refund-v2")
        assert duplicate is False and revised["source_revision"] == "refund-v2"
        assert revised["approval_id"] == "approval-1"
        assert first["id"] != revised["id"]


def test_feedback_chain_keeps_original_approval_snapshot(tmp_path: Path) -> None:
    store = Store(tmp_path / "feedback.sqlite3")
    with store.transaction(NOW) as tx:
        entities = seed(tx)
        tx.update("candidate-1", {"business_status": "OUTCOME_PENDING"})
        outcome, _ = _record(tx, origin="REAL", source="manual:feedback")
        create_review(tx, "analyst", outcome["id"], deviation_reasons=["费用变化"], notes="复核")
        before = entities["criteria"]["rules"]
        after = [{**before[0], "threshold": "250"}]
        feedback = propose_feedback(
            tx,
            "analyst",
            outcome["id"],
            before_rules=before,
            after_rules=after,
            reason="下一轮收紧起订量",
        )
        confirmed, criteria = decide_feedback(tx, "owner", feedback["id"], confirm=True)
        assert confirmed["source_chain"]["outcome_id"] == outcome["id"]
        assert confirmed["source_chain"]["approval_id"] == "approval-1"
        assert criteria["parent_revision_id"] == "criteria-1"
        assert criteria["source_outcome_id"] == outcome["id"]
        assert tx.get("approval-1")["criteria_id"] == "criteria-1"
