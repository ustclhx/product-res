from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from app.core import DomainError
from app.main import create_app
from app.outcomes.service import (
    create_research_conclusion,
    decide_feedback,
    get_research_closure,
    propose_research_feedback,
)
from app.persistence.store import Store, Tx
from app.selection.projects import CreateProjectCommand, create_project
from fastapi.testclient import TestClient

NOW = datetime(2026, 9, 22, 8, tzinfo=UTC)


def _seed_research(tx: Tx) -> dict[str, dict[str, Any]]:
    project = tx.add(
        "project",
        {
            "name": "OEM research",
            "channel": "AMAZON",
            "market": "US",
            "direction": "vehicle accessory",
            "goal": "research before procurement",
            "constraints": [],
            "analyst_id": "analyst",
            "decision_owner_id": "owner",
            "current_criteria_id": None,
        },
        entity_id="research-project",
    )
    criteria = tx.add(
        "criteria",
        {
            "rules": [],
            "required_evidence": ["supplier_identity"],
            "template_id": "amazon-camping-v1",
            "template_version": "1",
            "confirmed_by": "owner",
            "confirmed_at": NOW,
            "parent_revision_id": None,
        },
        entity_id="research-criteria",
        project_id=project["id"],
    )
    project = tx.update(project["id"], {"current_criteria_id": criteria["id"]})
    candidate = tx.add(
        "candidate",
        {
            "title": "OEM seat organizer",
            "business_status": "PREPARING",
            "screening_status": "UNCHECKED",
            "approval_id": None,
            "source_url": "https://supplier.example/item/1",
        },
        entity_id="research-candidate",
        project_id=project["id"],
    )
    evidence = tx.add(
        "evidence",
        {"field": "supplier_identity", "value": "Factory A", "source_locator": "quote:A"},
        entity_id="research-evidence",
        project_id=project["id"],
        candidate_id=candidate["id"],
    )
    source = tx.add(
        "source",
        {
            "entry_kind": "MANUAL",
            "provider": "manual",
            "source_ref": "manual:analyst",
            "source_url": "https://supplier.example/item/1",
        },
        entity_id="research-source",
        project_id=project["id"],
        candidate_id=candidate["id"],
    )
    other = tx.add(
        "candidate",
        {"title": "Other candidate", "business_status": "PREPARING"},
        entity_id="other-candidate",
        project_id=project["id"],
    )
    other_evidence = tx.add(
        "evidence",
        {"field": "supplier_identity", "value": "Factory B"},
        entity_id="other-evidence",
        project_id=project["id"],
        candidate_id=other["id"],
    )
    return {
        "project": project,
        "criteria": criteria,
        "candidate": candidate,
        "evidence": evidence,
        "source": source,
        "other_evidence": other_evidence,
    }


def _conclude(tx: Tx) -> dict[str, Any]:
    return create_research_conclusion(
        tx,
        "owner",
        "research-candidate",
        disposition="HOLD",
        reason="供应商暂时无法提供左右前排一致样品",
        learning="下一轮在询价前要求目标车型和双侧样品照片",
        source_locator="supplier:quote-A-2026-09",
        data_origin="REAL",
        evidence_ids=["research-evidence"],
        source_ids=["research-source"],
    )


def test_research_conclusion_is_owner_only_and_rejects_cross_candidate_refs(
    tmp_path: Path,
) -> None:
    store = Store(tmp_path / "research.sqlite3")
    with store.transaction(NOW) as tx:
        seeded = _seed_research(tx)
        with pytest.raises(DomainError) as role:
            create_research_conclusion(
                tx,
                "analyst",
                seeded["candidate"]["id"],
                disposition="STOP",
                reason="margin insufficient",
                learning="screen landed cost first",
                source_locator="manual:review",
                data_origin="REAL",
                evidence_ids=[seeded["evidence"]["id"]],
                source_ids=[seeded["source"]["id"]],
            )
        assert role.value.code == "ROLE_NOT_ALLOWED"
        with pytest.raises(DomainError) as cross_candidate:
            create_research_conclusion(
                tx,
                "owner",
                seeded["candidate"]["id"],
                disposition="STOP",
                reason="margin insufficient",
                learning="screen landed cost first",
                source_locator="manual:review",
                data_origin="REAL",
                evidence_ids=[seeded["other_evidence"]["id"]],
                source_ids=[seeded["source"]["id"]],
            )
        assert cross_candidate.value.code == "CROSS_CANDIDATE_REFERENCE"
        demo_evidence = tx.add(
            "evidence",
            {"field": "supplier_identity", "value": "fixture", "is_demo": True},
            project_id=seeded["project"]["id"],
            candidate_id=seeded["candidate"]["id"],
        )
        with pytest.raises(DomainError) as origin:
            create_research_conclusion(
                tx,
                "owner",
                seeded["candidate"]["id"],
                disposition="HOLD",
                reason="等待真实材料",
                learning="区分样例与真实供应商材料",
                source_locator="manual:review",
                data_origin="REAL",
                evidence_ids=[demo_evidence["id"]],
                source_ids=[seeded["source"]["id"]],
            )
        assert origin.value.code == "RESEARCH_ORIGIN_CONFLICT"
        assert tx.list("research_conclusion", candidate_id=seeded["candidate"]["id"]) == []


def test_empty_rules_learning_and_requirement_feedback_is_confirmed_and_adopted(
    tmp_path: Path,
) -> None:
    store = Store(tmp_path / "adoption.sqlite3")
    with store.transaction(NOW) as tx:
        seeded = _seed_research(tx)
        conclusion = _conclude(tx)
        feedback = propose_research_feedback(
            tx,
            "analyst",
            conclusion["id"],
            before_rules=[],
            after_rules=[],
            before_required_evidence=["supplier_identity"],
            after_required_evidence=["supplier_identity", "left_right_sample_photos"],
            research_learning="询价前固定车型，并索取左右前排样品照片",
            reason="避免把单侧或不同车型图片当作适配依据",
        )
        with pytest.raises(DomainError) as empty_requirements:
            propose_research_feedback(
                tx,
                "analyst",
                conclusion["id"],
                before_rules=[],
                after_rules=[],
                before_required_evidence=["supplier_identity"],
                after_required_evidence=[],
                research_learning="不能清空全部研究材料要求",
                reason="invalid relaxation",
            )
        assert empty_requirements.value.code == "INVALID_REQUIRED_EVIDENCE"
        confirmed, revision = decide_feedback(tx, "owner", feedback["id"], confirm=True)
        assert confirmed["status"] == "CONFIRMED"
        assert revision is not None
        assert revision["rules"] == []
        assert revision["required_evidence"] == [
            "supplier_identity",
            "left_right_sample_photos",
        ]
        assert revision["parent_revision_id"] == seeded["criteria"]["id"]
        assert conclusion["criteria_snapshot"]["required_evidence"] == ["supplier_identity"]
        assert tx.get(seeded["candidate"]["id"])["business_status"] == "PREPARING"
        assert tx.list("decision", candidate_id=seeded["candidate"]["id"]) == []
        assert tx.list("outcome", candidate_id=seeded["candidate"]["id"]) == []

        adopted = create_project(
            tx,
            "owner",
            CreateProjectCommand(
                actor_id="owner",
                name="Next OEM research",
                channel="AMAZON",
                market="US",
                direction="vehicle accessory",
                goal="validate both front seats",
                analyst_id="analyst",
                decision_owner_id="owner",
                source_feedback_id=feedback["id"],
            ),
        )
        assert adopted["criteria"]["required_evidence"][-1] == "left_right_sample_photos"
        assert adopted["criteria"]["research_learning"] == feedback["research_learning"]
        assert adopted["criteria"]["source_feedback_id"] == feedback["id"]

        closure = get_research_closure(tx, seeded["candidate"]["id"])
        assert closure["closure"] == {
            "research_conclusion_count": 1,
            "confirmed_feedback_count": 1,
            "adopted_feedback_count": 1,
            "commercial_outcome_count": 0,
            "commercial_reviewed": False,
        }


def test_research_api_uses_version_and_idempotency_boundary(tmp_path: Path) -> None:
    database = tmp_path / "api.sqlite3"
    store = Store(database)
    with store.transaction(NOW) as tx:
        seeded = _seed_research(tx)
    client = TestClient(create_app(db_path=database))
    payload = {
        "actor_id": "owner",
        "expected_version": seeded["candidate"]["version"],
        "disposition": "HOLD",
        "reason": "等待双侧样品",
        "learning": "询价时提前固定车型",
        "source_locator": "supplier:quote-A",
        "data_origin": "REAL",
        "evidence_ids": ["research-evidence"],
        "source_ids": ["research-source"],
    }
    first = client.post(
        "/api/v1/candidates/research-candidate/research-conclusions",
        headers={"Idempotency-Key": "research-conclusion-1"},
        json=payload,
    )
    assert first.status_code == 200, first.text
    replay = client.post(
        "/api/v1/candidates/research-candidate/research-conclusions",
        headers={"Idempotency-Key": "research-conclusion-1"},
        json=payload,
    )
    assert replay.json() == first.json()
    stale = client.post(
        "/api/v1/candidates/research-candidate/research-conclusions",
        headers={"Idempotency-Key": "research-conclusion-stale"},
        json={**payload, "expected_version": 999},
    )
    assert stale.status_code == 409
    assert stale.json()["error_code"] == "VERSION_CONFLICT"
    research = client.get("/api/v1/candidates/research-candidate/research")
    assert research.status_code == 200
    assert research.json()["conclusions"][0]["data_origin"] == "REAL"
