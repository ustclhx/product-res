from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from app.core import DomainError
from app.outcomes.service import (
    compare_outcome,
    confirm_csv,
    create_review,
    decide_feedback,
    finalize_review,
    preview_csv,
    propose_feedback,
    record_outcome,
)
from app.persistence.store import Store, Tx
from app.validation.service import conclude_validation, create_task, list_tasks, transition_task

NOW = datetime(2026, 9, 20, 8, tzinfo=UTC)


def seed(tx: Tx, *, approved: bool = True, basis: str = "GROSS") -> dict[str, dict[str, Any]]:
    project = tx.add(
        "project",
        {
            "name": "Lifecycle",
            "channel": "AMAZON",
            "market": "US",
            "direction": "camping",
            "goal": "validate",
            "constraints": [],
            "analyst_id": "analyst",
            "decision_owner_id": "owner",
            "current_criteria_id": None,
        },
        entity_id="project-1",
    )
    rules = [
        {
            "field": "moq",
            "operator": "lte",
            "threshold": "200",
            "unit": "unit",
            "currency": None,
        }
    ]
    criteria = tx.add(
        "criteria",
        {
            "rules": rules,
            "required_evidence": ["moq"],
            "template_id": "amazon-camping-v1",
            "template_version": "1",
            "confirmed_by": "owner",
            "confirmed_at": NOW,
            "parent_revision_id": None,
        },
        entity_id="criteria-1",
        project_id=project["id"],
    )
    project = tx.update(project["id"], {"current_criteria_id": criteria["id"]})
    candidate = tx.add(
        "candidate",
        {
            "title": "Tent",
            "external_id": "A1",
            "source_url": None,
            "business_status": "VALIDATING" if approved else "PREPARING",
            "screening_status": "PASS",
            "current_evaluation_id": None,
            "current_submission_id": None,
            "approval_id": None,
            "sku": "SKU-1",
            "market": "US",
            "is_demo": True,
        },
        entity_id="candidate-1",
        project_id=project["id"],
    )
    metrics = {
        "revenue": "1000",
        "refunds": "100",
        "procurement": "300",
        "platform": "100",
        "fulfillment": "100",
        "advertising": "100",
        "other": "50",
    }
    evaluation = tx.add(
        "evaluation",
        {
            "criteria_id": criteria["id"],
            "evidence_ids": [],
            "input_hash": "fixed",
            "dimensions": {},
            "unknowns": [],
            "counterevidence": [],
            "assumptions": [],
            "forecast": {
                "window_start": "2026-09-01T00:00:00Z",
                "window_end": "2026-10-01T00:00:00Z",
                "currency": "USD",
                "units": "10",
                "revenue_basis": basis,
                "metrics": metrics,
            },
            "assistant_versions": [],
        },
        entity_id="evaluation-1",
        project_id=project["id"],
        candidate_id=candidate["id"],
    )
    if approved:
        approval = tx.add(
            "decision",
            {
                "action": "APPROVE",
                "reason": "test",
                "questions": [],
                "actor_id": "owner",
                "evaluation_id": evaluation["id"],
                "criteria_id": criteria["id"],
            },
            entity_id="approval-1",
            project_id=project["id"],
            candidate_id=candidate["id"],
        )
        candidate = tx.update(candidate["id"], {"approval_id": approval["id"]})
        tx.add(
            "obligation",
            {"approval_id": approval["id"], "status": "PENDING"},
            project_id=project["id"],
            candidate_id=candidate["id"],
        )
    return {
        "project": project,
        "criteria": criteria,
        "candidate": candidate,
        "evaluation": evaluation,
    }


def test_validation_task_requires_approval_and_explicit_conclusion(tmp_path: Path) -> None:
    store = Store(tmp_path / "test.sqlite3")
    with store.transaction(NOW) as tx:
        entities = seed(tx)
        task = create_task(
            tx,
            "analyst",
            "candidate-1",
            task_type="TEST",
            question="Will it hold?",
            owner_id="contributor",
            due_at=datetime(2026, 9, 21, tzinfo=UTC),
            completion_criteria="record load result",
            expected_metrics={"load": "10kg"},
        )
        task = transition_task(tx, "contributor", task["id"], state="IN_PROGRESS")
        record = tx.add(
            "evidence",
            {
                "field": "test_result",
                "value": "passed",
                "unit": "record",
                "currency": None,
                "window": None,
                "source_locator": "manual:test",
                "observed_at": NOW,
                "valid_until": None,
                "epistemic_kind": "FACT",
                "verification": "VERIFIED",
                "supersedes_id": None,
                "is_demo": True,
            },
            project_id=str(entities["project"]["id"]),
            candidate_id="candidate-1",
        )
        task = transition_task(
            tx,
            "contributor",
            task["id"],
            state="DONE",
            result="broke at 8kg",
            evidence_ids=[record["id"]],
            target_met=False,
            reason="below target",
        )
        assert task["state"] == "DONE"
        assert tx.get("candidate-1")["business_status"] == "VALIDATING"
        tx.add(
            "candidate",
            {
                "title": "Other",
                "external_id": "A2",
                "source_url": None,
                "business_status": "PREPARING",
                "screening_status": "UNCHECKED",
                "current_evaluation_id": None,
                "current_submission_id": None,
                "approval_id": None,
                "sku": "SKU-2",
                "market": "US",
                "is_demo": True,
            },
            entity_id="candidate-2",
            project_id="project-1",
        )
        create_task(
            tx,
            "analyst",
            "candidate-2",
            task_type="EVIDENCE",
            question="Get MOQ",
            owner_id="contributor",
            due_at=datetime(2026, 9, 21, tzinfo=UTC),
            completion_criteria="verified MOQ",
            field="moq",
        )
        filtered = list_tasks(tx, candidate_id="candidate-1")
        assert [item["id"] for item in filtered] == [task["id"]]
        candidate, conclusion = conclude_validation(
            tx, "owner", "candidate-1", action="FOLLOW_UP", reason="capture outcome"
        )
        assert candidate["business_status"] == "OUTCOME_PENDING"
        assert conclusion["approval_id"] == "approval-1"


def test_evidence_task_cannot_be_completed_by_checking_box(tmp_path: Path) -> None:
    store = Store(tmp_path / "test.sqlite3")
    with store.transaction(NOW) as tx:
        seed(tx, approved=False)
        task = create_task(
            tx,
            "analyst",
            "candidate-1",
            task_type="EVIDENCE",
            question="Get MOQ",
            owner_id="contributor",
            due_at=datetime(2026, 9, 21, tzinfo=UTC),
            completion_criteria="verified supplier MOQ",
            field="moq",
        )
        transition_task(tx, "contributor", task["id"], state="IN_PROGRESS")
        estimate = tx.add(
            "evidence",
            {
                "field": "moq",
                "value": "100",
                "unit": "unit",
                "currency": None,
                "window": None,
                "source_locator": "guess",
                "observed_at": NOW,
                "valid_until": None,
                "epistemic_kind": "ESTIMATE",
                "verification": "VERIFIED",
                "supersedes_id": None,
                "is_demo": True,
            },
            project_id="project-1",
            candidate_id="candidate-1",
        )
        with pytest.raises(DomainError, match="current verified evidence"):
            transition_task(
                tx,
                "contributor",
                task["id"],
                state="DONE",
                result="entered",
                evidence_ids=[estimate["id"]],
                target_met=True,
            )
        fact = tx.add(
            "evidence",
            {
                "field": "moq",
                "value": "100",
                "unit": "unit",
                "currency": None,
                "window": None,
                "source_locator": "supplier:quote-1",
                "observed_at": NOW,
                "valid_until": "2026-10-20T08:00:00Z",
                "epistemic_kind": "FACT",
                "verification": "VERIFIED",
                "supersedes_id": None,
                "is_demo": True,
            },
            project_id="project-1",
            candidate_id="candidate-1",
        )
        completed = transition_task(
            tx,
            "contributor",
            task["id"],
            state="DONE",
            result="supplier confirmed MOQ",
            evidence_ids=[fact["id"]],
            target_met=True,
        )
        assert completed["state"] == "DONE"


def test_finance_missing_is_not_zero_and_net_does_not_double_refunds(tmp_path: Path) -> None:
    store = Store(tmp_path / "test.sqlite3")
    with store.transaction(NOW) as tx:
        seed(tx, basis="NET")
        tx.update("candidate-1", {"business_status": "OUTCOME_PENDING"})
        metrics: dict[str, str | None] = {
            "revenue": "1000",
            "refunds": "100",
            "procurement": "300",
            "platform": "100",
            "fulfillment": "100",
            "advertising": "100",
            "other": "50",
        }
        outcome, _ = record_outcome(
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
            metrics=metrics,
            source_locator="manual:net",
            is_demo=True,
            reason=None,
            sku="SKU-1",
        )
        comparison = compare_outcome(tx, str(outcome["id"]))
        assert comparison["actual_contribution_per_unit"] == "35"
        metrics["advertising"] = None
        missing, _ = record_outcome(
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
            metrics=metrics,
            source_locator="manual:missing",
            is_demo=True,
            reason=None,
            sku="SKU-1",
        )
        missing_comparison = compare_outcome(tx, str(missing["id"]))
        assert missing_comparison["actual_contribution_per_unit"] is None
        assert missing_comparison["basis_comparable"] is True
        assert missing_comparison["contribution_comparable"] is False
        assert missing_comparison["fields"]["revenue"]["variance"] == "0"
        metrics["advertising"] = "100"
        zero_units, _ = record_outcome(
            tx,
            "analyst",
            "candidate-1",
            approval_id="approval-1",
            status="RECORDED",
            window_start="2026-09-01T00:00:00Z",
            window_end="2026-10-01T00:00:00Z",
            currency="USD",
            units="0",
            revenue_basis="NET",
            metrics=metrics,
            source_locator="manual:zero-units",
            is_demo=True,
            reason=None,
            sku="SKU-1",
        )
        zero_comparison = compare_outcome(tx, str(zero_units["id"]))
        assert zero_units["units"] == "0"
        assert zero_comparison["actual_contribution_per_unit"] is None
        assert "ZERO_UNITS" in zero_comparison["reasons"]


def test_feedback_creates_future_criteria_without_changing_project(tmp_path: Path) -> None:
    store = Store(tmp_path / "test.sqlite3")
    with store.transaction(NOW) as tx:
        entities = seed(tx)
        tx.update("candidate-1", {"business_status": "OUTCOME_PENDING"})
        outcome, _ = record_outcome(
            tx,
            "analyst",
            "candidate-1",
            approval_id="approval-1",
            status="RECORDED",
            window_start="2026-08-01T00:00:00Z",
            window_end="2026-09-20T07:00:00Z",
            currency="USD",
            units="10",
            revenue_basis="GROSS",
            metrics=entities["evaluation"]["forecast"]["metrics"],
            source_locator="manual:feedback",
            is_demo=True,
            reason=None,
            sku="SKU-1",
        )
        create_review(
            tx,
            "analyst",
            str(outcome["id"]),
            deviation_reasons=["supplier variance"],
            notes="raise MOQ limit only for next cycle",
        )
        before = entities["criteria"]["rules"]
        invalid_rules = [
            [{**before[0], "operator": "run_code"}],
            [{**before[0], "threshold": "NaN"}],
            [{key: value for key, value in before[0].items() if key != "unit"}],
        ]
        for invalid in invalid_rules:
            with pytest.raises(DomainError, match="valid criteria rules"):
                propose_feedback(
                    tx,
                    "analyst",
                    str(outcome["id"]),
                    before_rules=before,
                    after_rules=invalid,
                    reason="invalid rule must not persist",
                )
        legacy_invalid = tx.add(
            "feedback",
            {
                "outcome_id": outcome["id"],
                "before_rules": before,
                "after_rules": [{**before[0], "threshold": "Infinity"}],
                "reason": "legacy invalid proposal",
                "status": "PROPOSED",
                "new_criteria_id": None,
            },
            project_id="project-1",
            candidate_id="candidate-1",
        )
        with pytest.raises(DomainError, match="finite numeric thresholds"):
            decide_feedback(tx, "owner", str(legacy_invalid["id"]), confirm=True)
        decide_feedback(
            tx,
            "owner",
            str(legacy_invalid["id"]),
            confirm=False,
            reason="invalid legacy rule",
        )
        after = [{**before[0], "threshold": "250"}]
        feedback = propose_feedback(
            tx,
            "analyst",
            str(outcome["id"]),
            before_rules=before,
            after_rules=after,
            reason="supplier batch economics",
        )
        feedback, criteria = decide_feedback(tx, "owner", str(feedback["id"]), confirm=True)
        assert criteria is not None and feedback["new_criteria_id"] == criteria["id"]
        rejected = propose_feedback(
            tx,
            "analyst",
            str(outcome["id"]),
            before_rules=before,
            after_rules=[{**before[0], "threshold": "150"}],
            reason="alternative interpretation",
        )
        rejected, rejected_criteria = decide_feedback(
            tx, "owner", str(rejected["id"]), confirm=False, reason="sample is too small"
        )
        assert rejected["status"] == "REJECTED" and rejected_criteria is None
        assert tx.get("project-1")["current_criteria_id"] == "criteria-1"
        assert finalize_review(tx, "owner", "candidate-1")["business_status"] == "REVIEWED"


def test_finalize_waits_for_observation_window_end(tmp_path: Path) -> None:
    store = Store(tmp_path / "test.sqlite3")
    with store.transaction(NOW) as tx:
        entities = seed(tx)
        tx.update("candidate-1", {"business_status": "OUTCOME_PENDING"})
        outcome, _ = record_outcome(
            tx,
            "analyst",
            "candidate-1",
            approval_id="approval-1",
            status="RECORDED",
            window_start="2026-09-20T00:00:00Z",
            window_end="2026-10-20T00:00:00Z",
            currency="USD",
            units="10",
            revenue_basis="GROSS",
            metrics=entities["evaluation"]["forecast"]["metrics"],
            source_locator="manual:open-window",
            is_demo=False,
            reason=None,
            sku="SKU-1",
        )
        create_review(
            tx,
            "analyst",
            str(outcome["id"]),
            deviation_reasons=["interim result"],
            notes="window is still collecting observations",
        )
        with pytest.raises(DomainError, match="before the recorded observation window ends"):
            finalize_review(tx, "owner", "candidate-1")
        assert tx.get("candidate-1")["business_status"] == "OUTCOME_PENDING"


def test_csv_preview_requires_unambiguous_mapping_and_is_bounded(tmp_path: Path) -> None:
    store = Store(tmp_path / "test.sqlite3")
    with store.transaction(NOW) as tx:
        seed(tx)
        header = "sku,status,window_start,window_end,currency,units,revenue_basis,source_locator\n"
        row = "UNKNOWN,NOT_LAUNCHED,,,,,,csv:2\n"
        preview = preview_csv(tx, header + row)
        assert preview["rows"][0]["errors"] == ["MAPPING_NOT_FOUND"]
        assert preview["rows"][0]["valid"] is False


def test_csv_confirm_revalidates_and_deduplicates(tmp_path: Path) -> None:
    store = Store(tmp_path / "test.sqlite3")
    with store.transaction(NOW) as tx:
        seed(tx)
        tx.update("candidate-1", {"business_status": "OUTCOME_PENDING"})
        csv_text = (
            "candidate_id,approval_id,status,window_start,window_end,currency,units,"
            "revenue_basis,revenue,refunds,procurement,platform,fulfillment,advertising,"
            "other,source_locator,is_demo\n"
            "candidate-1,approval-1,RECORDED,2026-09-01T00:00:00Z,"
            "2026-10-01T00:00:00Z,USD,0,GROSS,1000,100,300,100,100,100,50,"
            "csv:lifecycle:2,true\n"
        )
        preview = preview_csv(tx, csv_text)
        first = confirm_csv(tx, "analyst", csv_text, preview["content_hash"], [2])
        assert len(first["items"]) == 1
        replay = confirm_csv(tx, "analyst", csv_text, preview["content_hash"], [2])
        assert replay["items"] == []
        assert replay["duplicates"][0]["outcome_id"] == first["items"][0]["id"]
        changed = csv_text.replace("GROSS,1000", "GROSS,1200")
        changed_preview = preview_csv(tx, changed)
        with pytest.raises(DomainError) as conflict:
            confirm_csv(tx, "analyst", changed, changed_preview["content_hash"], [2])
        assert conflict.value.code == "OUTCOME_SOURCE_CONFLICT"
        assert len(tx.list("outcome")) == 1
