from __future__ import annotations

from pathlib import Path
from typing import Any

from app.main import create_app
from app.persistence.store import DEMO_NOW, Store, Tx
from app.workflow import build_work_items
from fastapi.testclient import TestClient


def _project(tx: Tx, project_id: str, *, criteria: bool = True) -> dict[str, Any]:
    project = tx.add(
        "project",
        {
            "name": f"Project {project_id}",
            "channel": "AMAZON",
            "market": "US",
            "direction": "seat covers",
            "analyst_id": "analyst",
            "decision_owner_id": "owner",
            "current_criteria_id": None,
        },
        entity_id=project_id,
    )
    if not criteria:
        return project
    revision = tx.add(
        "criteria",
        {
            "rules": [],
            "required_evidence": ["procurement_cost"],
            "template_id": "amazon-demo",
            "template_version": "1",
            "confirmed_by": "owner",
            "confirmed_at": tx.now.isoformat(),
            "parent_revision_id": None,
        },
        entity_id=f"criteria-{project_id}",
        project_id=project_id,
    )
    return tx.update(project_id, {"current_criteria_id": revision["id"]})


def _candidate(
    tx: Tx,
    project_id: str,
    candidate_id: str,
    *,
    status: str = "PREPARING",
    profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return tx.add(
        "candidate",
        {
            "title": f"Candidate {candidate_id}",
            "business_status": status,
            "screening_status": "UNCHECKED",
            "current_evaluation_id": None,
            "current_submission_id": None,
            "approval_id": None,
            "sourcing_profile": profile,
        },
        entity_id=candidate_id,
        project_id=project_id,
    )


def _evidence(
    tx: Tx,
    project_id: str,
    candidate_id: str,
    *,
    verification: str,
    entity_id: str,
) -> dict[str, Any]:
    return tx.add(
        "evidence",
        {
            "field": "procurement_cost",
            "value": "12.50",
            "unit": "per_item",
            "currency": "USD",
            "window": None,
            "source_locator": "fixture:quote",
            "observed_at": tx.now.isoformat(),
            "valid_until": "2026-10-20T08:00:00+00:00",
            "epistemic_kind": "FACT",
            "verification": verification,
            "verification_note": None,
            "recorded_by": "contributor",
            "supersedes_id": None,
            "is_demo": True,
        },
        entity_id=entity_id,
        project_id=project_id,
        candidate_id=candidate_id,
    )


def _task(
    tx: Tx,
    project_id: str,
    candidate_id: str,
    *,
    task_id: str,
    state: str,
    field: str = "procurement_cost",
) -> dict[str, Any]:
    return tx.add(
        "task",
        {
            "type": "EVIDENCE",
            "question": f"Collect {field}",
            "owner_id": "contributor",
            "due_at": "2026-09-19T08:00:00Z",
            "completion_criteria": "Verified material",
            "expected_metrics": {},
            "approval_id": None,
            "state": state,
            "result": "done" if state == "DONE" else None,
            "evidence_ids": [],
            "target_met": True if state == "DONE" else None,
            "reason": None,
            "field": field,
        },
        entity_id=task_id,
        project_id=project_id,
        candidate_id=candidate_id,
    )


def test_project_setup_and_candidate_intake_are_stable(tmp_path: Path) -> None:
    store = Store(tmp_path / "work.sqlite3")
    with store.transaction(DEMO_NOW) as tx:
        draft = _project(tx, "draft", criteria=False)
        ready = _project(tx, "ready")
        first = build_work_items(tx)
        second = build_work_items(tx)

    assert first == second
    by_id = {item["id"]: item for item in first["items"]}
    assert by_id[f"project:{draft['id']}:criteria"] == {
        "id": "project:draft:criteria",
        "kind": "CRITERIA",
        "title": "确认选品标准",
        "project_id": "draft",
        "project_name": "Project draft",
        "candidate_id": None,
        "candidate_title": None,
        "owner_id": "owner",
        "assignment_owner_id": None,
        "state": "TODO",
        "due_at": None,
        "overdue": False,
        "reason": "项目标准尚未确认，确认后才能添加候选",
        "action_label": "确认标准",
        "href": "/projects/draft?view=criteria",
        "task_id": None,
        "field": None,
    }
    assert by_id[f"project:{ready['id']}:candidate-intake"]["href"] == ("/projects/ready?intake=1")
    summaries = {item["id"]: item for item in first["projects"]}
    assert summaries["draft"]["open_item_count"] == 1
    assert summaries["ready"]["candidate_count"] == 0
    assert summaries["ready"]["next_action"] == "添加候选"


def test_current_requirements_distinguish_unverified_and_only_required_oem_fields(
    tmp_path: Path,
) -> None:
    store = Store(tmp_path / "requirements.sqlite3")
    with store.transaction(DEMO_NOW) as tx:
        project = _project(tx, "research")
        listed = _candidate(tx, project["id"], "listed")
        _evidence(
            tx,
            project["id"],
            listed["id"],
            verification="UNVERIFIED",
            entity_id="unverified-cost",
        )
        oem = _candidate(
            tx,
            project["id"],
            "oem",
            profile={"product_type": "OEM", "stage": "RESEARCH"},
        )
        result = build_work_items(tx)

    listed_item = next(
        item
        for item in result["items"]
        if item["candidate_id"] == listed["id"] and item["field"] == "procurement_cost"
    )
    assert listed_item["owner_id"] == "analyst"
    assert listed_item["assignment_owner_id"] is None
    assert "mode=review" in listed_item["href"]
    assert "assign=1" not in listed_item["href"]
    oem_fields = {item["field"] for item in result["items"] if item["candidate_id"] == oem["id"]}
    assert oem_fields == {
        "procurement_reference_price",
        "moq_reference",
        "target_price",
        "fitment_desk_review",
    }


def test_active_task_replaces_gap_but_closed_task_is_history_not_completion(
    tmp_path: Path,
) -> None:
    store = Store(tmp_path / "tasks.sqlite3")
    with store.transaction(DEMO_NOW) as tx:
        project = _project(tx, "tasks")
        active = _candidate(tx, project["id"], "active")
        closed = _candidate(tx, project["id"], "closed")
        _evidence(
            tx,
            project["id"],
            active["id"],
            verification="UNVERIFIED",
            entity_id="active-unverified-cost",
        )
        _task(tx, project["id"], active["id"], task_id="active-task", state="TODO")
        _task(tx, project["id"], closed["id"], task_id="closed-task", state="DONE")
        result = build_work_items(tx)

    active_items = [item for item in result["items"] if item["candidate_id"] == active["id"]]
    assert [item["id"] for item in active_items] == ["task:active-task"]
    assert active_items[0]["overdue"] is True
    assert (
        active_items[0]["href"]
        == "/candidates/active?stage=evidence&field=procurement_cost"
        "&task_id=active-task&mode=review"
    )

    closed_items = [item for item in result["items"] if item["candidate_id"] == closed["id"]]
    assert {item["id"] for item in closed_items} == {
        "task:closed-task",
        "candidate:closed:evidence:procurement_cost",
    }
    assert next(item for item in closed_items if item["task_id"])["state"] == "DONE"
    derived = next(
        item for item in closed_items if item["field"] == "procurement_cost" and not item["task_id"]
    )
    assert derived["state"] == "TODO"


def test_stage_items_and_research_closure_do_not_create_commercial_work(tmp_path: Path) -> None:
    store = Store(tmp_path / "stages.sqlite3")
    with store.transaction(DEMO_NOW) as tx:
        project = _project(tx, "stages")
        review = _candidate(tx, project["id"], "review", status="IN_REVIEW")
        validating = _candidate(tx, project["id"], "validating", status="VALIDATING")
        outcome = _candidate(tx, project["id"], "outcome", status="OUTCOME_PENDING")
        stopped = _candidate(
            tx,
            project["id"],
            "stopped",
            profile={"product_type": "OEM", "stage": "RESEARCH"},
        )
        tx.add(
            "research_conclusion",
            {"disposition": "STOP"},
            entity_id="research-stop",
            project_id=project["id"],
            candidate_id=stopped["id"],
        )
        result = build_work_items(tx)

    by_candidate = {
        candidate_id: [item for item in result["items"] if item["candidate_id"] == candidate_id]
        for candidate_id in (review["id"], validating["id"], outcome["id"], stopped["id"])
    }
    assert [item["kind"] for item in by_candidate[review["id"]]] == ["DECISION"]
    assert [item["kind"] for item in by_candidate[validating["id"]]] == ["VALIDATION_CONCLUSION"]
    assert by_candidate[validating["id"]][0]["href"] == (
        "/tasks?candidate_id=validating&conclusion=1"
    )
    assert [item["kind"] for item in by_candidate[outcome["id"]]] == ["OUTCOME"]
    assert by_candidate[stopped["id"]] == []


def test_outcome_review_feedback_and_finalize_are_current_stage_items(tmp_path: Path) -> None:
    store = Store(tmp_path / "outcome-stages.sqlite3")
    with store.transaction(DEMO_NOW) as tx:
        project = _project(tx, "outcome-stages")
        candidate = _candidate(tx, project["id"], "outcome-candidate", status="OUTCOME_PENDING")
        outcome = tx.add(
            "outcome",
            {"status": "RECORDED"},
            entity_id="outcome-record",
            project_id=project["id"],
            candidate_id=candidate["id"],
        )
        assert [item["kind"] for item in build_work_items(tx)["items"]] == ["OUTCOME_REVIEW"]

        tx.add(
            "outcome_review",
            {"outcome_id": outcome["id"], "status": "COMPLETED"},
            project_id=project["id"],
            candidate_id=candidate["id"],
        )
        feedback = tx.add(
            "feedback",
            {
                "outcome_id": outcome["id"],
                "research_conclusion_id": None,
                "status": "PROPOSED",
            },
            entity_id="feedback-proposal",
            project_id=project["id"],
            candidate_id=candidate["id"],
        )
        assert [item["kind"] for item in build_work_items(tx)["items"]] == ["FEEDBACK"]

        tx.update(feedback["id"], {"status": "CONFIRMED"})
        assert [item["kind"] for item in build_work_items(tx)["items"]] == ["OUTCOME_FINALIZE"]


def test_get_work_items_is_read_only_and_exposes_complete_contract(tmp_path: Path) -> None:
    database = tmp_path / "api.sqlite3"
    store = Store(database)
    with store.transaction(DEMO_NOW) as tx:
        project = _project(tx, "api")
        _candidate(tx, project["id"], "api-candidate")
        before_entities = tx.connection.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
        before_audit = tx.connection.execute("SELECT COUNT(*) FROM audit").fetchone()[0]

    client = TestClient(create_app(db_path=database, clock=lambda: DEMO_NOW))
    response = client.get("/api/v1/work-items")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["clock"] == DEMO_NOW.isoformat()
    assert payload["items"]
    assert set(payload["items"][0]) == {
        "id",
        "kind",
        "title",
        "project_id",
        "project_name",
        "candidate_id",
        "candidate_title",
        "owner_id",
        "assignment_owner_id",
        "state",
        "due_at",
        "overdue",
        "reason",
        "action_label",
        "href",
        "task_id",
        "field",
    }
    with store.transaction(DEMO_NOW) as tx:
        after_entities = tx.connection.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
        assert after_entities == before_entities
        assert tx.connection.execute("SELECT COUNT(*) FROM audit").fetchone()[0] == before_audit


def test_oem_reference_material_does_not_create_false_gaps(tmp_path: Path) -> None:
    store = Store(tmp_path / "oem-ready.sqlite3")
    with store.transaction(DEMO_NOW) as tx:
        project = _project(tx, "oem-ready")
        candidate = _candidate(
            tx,
            project["id"],
            "oem-ready-candidate",
            profile={"product_type": "OEM", "stage": "RESEARCH"},
        )
        for field in (
            "procurement_reference_price",
            "moq_reference",
            "target_price",
            "fitment_desk_review",
        ):
            tx.add(
                "evidence",
                {
                    "field": field,
                    "value": "12" if field != "fitment_desk_review" else "PASS",
                    "unit": "unit",
                    "currency": None,
                    "epistemic_kind": "FACT" if field == "fitment_desk_review" else "ESTIMATE",
                    "verification": "VERIFIED" if field == "fitment_desk_review" else "UNVERIFIED",
                    "observed_at": tx.now.isoformat(),
                    "valid_until": None,
                    "supersedes_id": None,
                },
                project_id=project["id"],
                candidate_id=candidate["id"],
            )
        items = build_work_items(tx)["items"]
    assert [item["kind"] for item in items] == ["EVALUATION"]
