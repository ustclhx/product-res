from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from app.api.routes.evidence import router as evidence_router
from app.api.routes.reviews import router as reviews_router
from app.core import DomainError
from app.evidence import current_evidence, evaluate_screening
from app.persistence.store import DEMO_NOW, Store, Tx
from app.providers.assistant import NodeKind
from app.selection.decisions import (
    decide_submission,
    reopen_candidate,
    submit_evaluation,
)
from app.selection.evaluations import create_evaluation, run_assistant
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _seed(tx: Tx) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    project = tx.add(
        "project",
        {
            "name": "Evidence test",
            "channel": "AMAZON",
            "market": "US",
            "direction": "desk",
            "goal": "test",
            "constraints": {},
            "analyst_id": "analyst",
            "decision_owner_id": "owner",
            "current_criteria_id": None,
        },
    )
    criteria = tx.add(
        "criteria",
        {
            "rules": [
                {
                    "field": "moq",
                    "operator": "lte",
                    "threshold": "200",
                    "unit": "units",
                    "currency": None,
                }
            ],
            "required_evidence": ["moq", "procurement_cost"],
            "template_id": "amazon-demo",
            "template_version": "1",
            "confirmed_by": "owner",
            "confirmed_at": DEMO_NOW.isoformat(),
            "parent_revision_id": None,
        },
        project_id=project["id"],
    )
    project = tx.update(project["id"], {"current_criteria_id": criteria["id"]})
    candidate = tx.add(
        "candidate",
        {
            "title": "Desk lamp",
            "external_id": "A-1",
            "source_url": "https://example.test/item",
            "business_status": "PREPARING",
            "screening_status": "UNCHECKED",
            "current_evaluation_id": None,
            "current_submission_id": None,
            "approval_id": None,
            "sku": None,
            "market": "US",
            "is_demo": True,
        },
        project_id=project["id"],
    )
    return project, criteria, candidate


def _evidence(
    tx: Tx,
    project_id: str,
    candidate_id: str,
    *,
    field: str,
    value: str | None,
    unit: str,
    kind: str = "FACT",
    verification: str = "VERIFIED",
    supersedes_id: str | None = None,
    valid_until: str | None = "2026-10-20T08:00:00+00:00",
) -> dict[str, Any]:
    return tx.add(
        "evidence",
        {
            "field": field,
            "value": value,
            "unit": unit,
            "currency": "USD" if field == "procurement_cost" else None,
            "window": None,
            "source_locator": f"fixture:{field}",
            "observed_at": "2026-09-20T07:00:00+00:00",
            "valid_until": valid_until,
            "epistemic_kind": kind,
            "verification": verification,
            "supersedes_id": supersedes_id,
            "is_demo": True,
            "recorded_by": "contributor",
        },
        project_id=project_id,
        candidate_id=candidate_id,
    )


def _dimensions(evidence_ids: list[str]) -> dict[str, dict[str, Any]]:
    return {
        name: {"summary": f"{name} reviewed", "evidence_ids": evidence_ids}
        for name in ("demand", "competition", "differentiation", "supply_cost", "risk")
    }


def _forecast() -> dict[str, Any]:
    return {
        "currency": "USD",
        "window_start": "2026-09-20T08:00:00+00:00",
        "window_end": "2026-10-20T08:00:00+00:00",
        "revenue_basis": "GROSS",
        "units": "100",
        "metrics": {
            "revenue": "1200",
            "procurement": "500",
            "platform": None,
            "fulfillment": None,
            "advertising": None,
            "refunds": None,
            "other": None,
        },
    }


def _ready_evaluation(
    tx: Tx, project: dict[str, Any], candidate: dict[str, Any]
) -> dict[str, Any]:
    moq = _evidence(tx, project["id"], candidate["id"], field="moq", value="100", unit="units")
    cost = _evidence(
        tx,
        project["id"],
        candidate["id"],
        field="procurement_cost",
        value="5.00",
        unit="per_unit",
    )
    return create_evaluation(
        tx,
        "analyst",
        candidate["id"],
        dimensions=_dimensions([moq["id"], cost["id"]]),
        evidence_ids=[moq["id"], cost["id"]],
        unknowns=["competition depth remains unknown"],
        counterevidence=[],
        assumptions=[],
        forecast=_forecast(),
        assistant_versions={"model": "manual-v1"},
        parent_revision_id=None,
    )


def _test_app(store: Store) -> FastAPI:
    app = FastAPI()
    app.state.store = store
    app.state.clock = lambda: datetime(2026, 9, 20, 8, tzinfo=UTC)
    app.include_router(evidence_router)
    app.include_router(reviews_router)
    return app


def test_evidence_screening_and_reasoned_override_api(tmp_path: Path) -> None:
    store = Store(tmp_path / "evidence-api.sqlite3")
    with store.transaction() as tx:
        _, _, candidate = _seed(tx)
        candidate_id = candidate["id"]
        version = candidate["version"]
    client = TestClient(_test_app(store))

    def add(field: str, value: str, unit: str, expected_version: int) -> dict[str, Any]:
        response = client.post(
            f"/candidates/{candidate_id}/evidence",
            headers={"Idempotency-Key": f"add-{field}"},
            json={
                "actor_id": "contributor",
                "expected_version": expected_version,
                "field": field,
                "value": value,
                "unit": unit,
                "currency": "USD" if field == "procurement_cost" else None,
                "window": None,
                "source_locator": f"quote.csv:{field}",
                "observed_at": "2026-09-20T07:00:00Z",
                "valid_until": "2026-10-20T07:00:00Z",
                "epistemic_kind": "FACT",
                "verification": "VERIFIED",
                "supersedes_id": None,
                "is_demo": True,
            },
        )
        assert response.status_code == 200
        return response.json()

    version = add("moq", "500", "units", version)["candidate"]["version"]
    version = add("procurement_cost", "5", "per_unit", version)["candidate"]["version"]
    screened = client.post(
        f"/candidates/{candidate_id}/screenings",
        headers={"Idempotency-Key": "screen-failed-moq"},
        json={"actor_id": "analyst", "expected_version": version},
    )
    assert screened.status_code == 200
    assert screened.json()["screening"]["status"] == "EXCLUDED"
    version = screened.json()["candidate"]["version"]
    missing_reason = client.post(
        f"/candidates/{candidate_id}/screening-overrides",
        headers={"Idempotency-Key": "override-without-reason"},
        json={"actor_id": "owner", "expected_version": version, "reason": ""},
    )
    assert missing_reason.status_code == 422
    overridden = client.post(
        f"/candidates/{candidate_id}/screening-overrides",
        headers={"Idempotency-Key": "override-moq"},
        json={
            "actor_id": "owner",
            "expected_version": version,
            "reason": "Pilot quantity is acceptable",
        },
    )
    assert overridden.status_code == 200
    assert overridden.json()["screening"]["status"] == "OVERRIDDEN"
    assert overridden.json()["candidate"]["business_status"] == "PREPARING"


def test_revision_heads_conflicts_and_override_invalidation(tmp_path: Path) -> None:
    store = Store(tmp_path / "evidence.sqlite3")
    with store.transaction() as tx:
        project, criteria, candidate = _seed(tx)
        old = _evidence(
            tx, project["id"], candidate["id"], field="moq", value="500", unit="units"
        )
        estimate = _evidence(
            tx,
            project["id"],
            candidate["id"],
            field="procurement_cost",
            value="5",
            unit="per_unit",
            kind="ESTIMATE",
        )
        first = evaluate_screening(criteria, [old, estimate], [], now=tx.now)
        assert first["status"] == "EXCLUDED"
        assert first["missing_fields"] == ["procurement_cost"]
        override = tx.add(
            "override",
            {
                "criteria_id": criteria["id"],
                "input_hash": first["input_hash"],
                "rule_key": first["failed_rule_keys"][0],
                "reason": "Accept a small pilot quote",
                "actor_id": "owner",
            },
            project_id=project["id"],
            candidate_id=candidate["id"],
        )
        assert evaluate_screening(criteria, [old, estimate], [override], now=tx.now)["status"] == (
            "NEEDS_EVIDENCE"
        )
        replacement = _evidence(
            tx,
            project["id"],
            candidate["id"],
            field="moq",
            value="100",
            unit="units",
            supersedes_id=old["id"],
        )
        heads = current_evidence([old, replacement])
        assert [item["id"] for item in heads] == [replacement["id"]]
        after_change = evaluate_screening(
            criteria, [old, replacement, estimate], [override], now=tx.now
        )
        assert after_change["input_hash"] != first["input_hash"]
        assert after_change["status"] == "NEEDS_EVIDENCE"
        independent = _evidence(
            tx, project["id"], candidate["id"], field="moq", value="120", unit="units"
        )
        conflict = evaluate_screening(
            criteria, [old, replacement, independent, estimate], [], now=tx.now
        )
        assert conflict["rule_results"][0]["reason"] == "CONFLICT"


def test_assistant_rejects_foreign_citation_and_persists_failed_attempt(tmp_path: Path) -> None:
    store = Store(tmp_path / "assistant.sqlite3")
    with store.transaction() as tx:
        _, _, candidate = _seed(tx)
        candidate_id = candidate["id"]
    with pytest.raises(DomainError) as caught:
        with store.transaction() as tx:
            run_assistant(
                tx,
                "analyst",
                candidate_id,
                node_kind=NodeKind.EVALUATION_ORGANIZER,
                fixture="invalid_reference",
            )
    assert caught.value.code == "ASSISTANT_OUTPUT_INVALID"
    with store.transaction() as tx:
        assert tx.get(candidate_id, "candidate")["business_status"] == "PREPARING"
        runs = tx.list("node_run", candidate_id=candidate_id)
        assert len(runs) == 1
        assert runs[0]["run_state"] == "FAILED"
        assert tx.list("evaluation", candidate_id=candidate_id) == []


def test_stale_submission_is_returned_with_independent_invalidation(tmp_path: Path) -> None:
    store = Store(tmp_path / "stale.sqlite3")
    with store.transaction() as tx:
        project, _, candidate = _seed(tx)
        _ready_evaluation(tx, project, candidate)
        submission = submit_evaluation(tx, "analyst", candidate["id"])
        cost_id = next(
            item["id"]
            for item in tx.list("evidence", candidate_id=candidate["id"])
            if item["field"] == "procurement_cost"
        )
        _evidence(
            tx,
            project["id"],
            candidate["id"],
            field="procurement_cost",
            value="4.50",
            unit="per_unit",
            supersedes_id=cost_id,
        )
        candidate_id = candidate["id"]
        submission_id = submission["submission"]["id"]
    with pytest.raises(DomainError) as caught:
        with store.transaction() as tx:
            decide_submission(
                tx,
                "owner",
                candidate_id,
                action="APPROVE",
                reason="Looks ready",
                questions=[],
            )
    assert caught.value.code == "SUBMISSION_STALE"
    with store.transaction() as tx:
        candidate = tx.get(candidate_id, "candidate")
        assert candidate["business_status"] == "RETURNED"
        invalidations = tx.list("submission_invalidation", candidate_id=candidate_id)
        assert len(invalidations) == 1
        assert invalidations[0]["submission_id"] == submission_id
        assert tx.list("decision", candidate_id=candidate_id) == []


def test_return_requires_new_evaluation_before_resubmission(tmp_path: Path) -> None:
    store = Store(tmp_path / "return-revision.sqlite3")
    with store.transaction() as tx:
        project, _, candidate = _seed(tx)
        created = _ready_evaluation(tx, project, candidate)
        first_evaluation = created["evaluation"]
        submit_evaluation(tx, "analyst", candidate["id"])
        returned = decide_submission(
            tx,
            "owner",
            candidate["id"],
            action="RETURN",
            reason="Clarify the supplier quote",
            questions=["Is the quote valid for the pilot quantity?"],
        )
        assert returned["candidate"]["business_status"] == "RETURNED"

        with pytest.raises(DomainError) as caught:
            submit_evaluation(
                tx,
                "analyst",
                candidate["id"],
                evaluation_id=first_evaluation["id"],
            )
        assert caught.value.code == "NEW_EVALUATION_REQUIRED"
        assert caught.value.details["questions"] == [
            "Is the quote valid for the pilot quantity?"
        ]

        revision = create_evaluation(
            tx,
            "analyst",
            candidate["id"],
            dimensions=_dimensions(first_evaluation["evidence_ids"]),
            evidence_ids=first_evaluation["evidence_ids"],
            unknowns=[],
            counterevidence=[],
            assumptions=["Supplier clarification recorded in the revised assessment"],
            forecast=_forecast(),
            assistant_versions={},
            parent_revision_id=first_evaluation["id"],
        )
        assert revision["evaluation"]["id"] != first_evaluation["id"]
        resubmitted = submit_evaluation(
            tx,
            "analyst",
            candidate["id"],
            evaluation_id=revision["evaluation"]["id"],
        )
        assert resubmitted["candidate"]["business_status"] == "IN_REVIEW"
        assert resubmitted["submission"]["evaluation_id"] == revision["evaluation"]["id"]


def test_approval_retry_creates_one_decision_and_obligation_then_reopen_flow(
    tmp_path: Path,
) -> None:
    store = Store(tmp_path / "approval.sqlite3")
    with store.transaction() as tx:
        project, _, candidate = _seed(tx)
        created = _ready_evaluation(tx, project, candidate)
        candidate = created["candidate"]
        candidate_id = candidate["id"]

    client = TestClient(_test_app(store))
    submitted = client.post(
        f"/candidates/{candidate_id}/submissions",
        headers={"Idempotency-Key": "submit-once"},
        json={
            "actor_id": "analyst",
            "expected_version": candidate["version"],
            "evaluation_id": created["evaluation"]["id"],
        },
    )
    assert submitted.status_code == 200
    submitted_body = submitted.json()
    command = {
        "actor_id": "owner",
        "expected_version": submitted_body["candidate"]["version"],
        "action": "APPROVE",
        "reason": "Proceed to validation",
        "questions": [],
    }
    first = client.post(
        f"/candidates/{candidate_id}/decisions",
        headers={"Idempotency-Key": "approve-once"},
        json=command,
    )
    retry = client.post(
        f"/candidates/{candidate_id}/decisions",
        headers={"Idempotency-Key": "approve-once"},
        json=command,
    )
    assert first.status_code == retry.status_code == 200
    assert first.json() == retry.json()
    with store.transaction() as tx:
        assert len(tx.list("decision", candidate_id=candidate_id)) == 1
        assert len(tx.list("obligation", candidate_id=candidate_id)) == 1

        # Exercise WATCH -> REOPEN independently on a second candidate.
        watched_project, _, watched = _seed(tx)
        ready = _ready_evaluation(tx, watched_project, watched)
        submit_evaluation(tx, "analyst", watched["id"])
        decided = decide_submission(
            tx,
            "owner",
            watched["id"],
            action="WATCH",
            reason="Wait for seasonality",
            questions=[],
        )
        reopened = reopen_candidate(
            tx, "owner", watched["id"], reason="New evidence is available"
        )
        assert decided["candidate"]["business_status"] == "WATCHING"
        assert reopened["candidate"]["business_status"] == "PREPARING"
        assert ready["evaluation"]["id"] in {
            item["evaluation_id"] for item in tx.list("decision", candidate_id=watched["id"])
        }


def test_evidence_only_criteria_still_requires_required_evidence() -> None:
    criteria = {
        "id": "criteria-evidence-only",
        "rules": [],
        "required_evidence": ["procurement_cost"],
        "confirmed_by": "owner",
        "confirmed_at": DEMO_NOW,
    }
    screening = evaluate_screening(criteria, [], [], now=DEMO_NOW)
    assert screening["status"] == "NEEDS_EVIDENCE"
    assert screening["missing_fields"] == ["procurement_cost"]
