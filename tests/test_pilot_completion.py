import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from app.api.routes.pilot import pilot_progress
from app.persistence.store import Store
from app.pilot.auth import ControlStore
from app.pilot.services import PilotServices
from fastapi import Request


def test_incompatible_control_schema_is_not_modified(tmp_path: Path) -> None:
    path = tmp_path / "control.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE control_schema_version(version INTEGER PRIMARY KEY)")
        db.execute("INSERT INTO control_schema_version VALUES(99)")
    with pytest.raises(RuntimeError, match="incompatible"):
        ControlStore(path, tmp_path / "workspaces")
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT version FROM control_schema_version").fetchall() == [(99,)]
        assert db.execute("SELECT name FROM sqlite_master WHERE name='users'").fetchall() == []


def test_pilot_completion_requires_adopted_model_and_closed_real_window(tmp_path: Path) -> None:
    now = datetime(2026, 9, 20, tzinfo=UTC)
    store = Store(tmp_path / "pilot.sqlite3", mode="pilot", workspace_id="pilot")
    with store.transaction(now) as tx:
        project = tx.add("project", {"name": "Pilot"})
        cid = tx.add("candidate", {"title": "Candidate"}, project_id=project["id"])["id"]
        evidence = tx.add("evidence", {"verification": "VERIFIED"}, candidate_id=cid)
        run = tx.add(
            "node_run", {"run_state": "SUCCEEDED", "is_simulated": False}, candidate_id=cid
        )
        evaluation = tx.add(
            "evaluation",
            {"evidence_ids": [evidence["id"]], "assistant_versions": {}},
            candidate_id=cid,
        )
        approval = tx.add("decision", {"evaluation_id": evaluation["id"]}, candidate_id=cid)
        tx.update(cid, {"approval_id": approval["id"]})
        tx.add("source", {"batch_id": "batch"}, candidate_id=cid)
        tx.add("validation_conclusion", {"approval_id": approval["id"]}, candidate_id=cid)
        outcome = tx.add(
            "outcome",
            {
                "approval_id": approval["id"],
                "data_origin": "REAL",
                "status": "RECORDED",
                "window_end": "2026-09-21T00:00:00Z",
            },
            candidate_id=cid,
        )
        feedback = tx.add(
            "feedback", {"status": "CONFIRMED", "outcome_id": outcome["id"]}, candidate_id=cid
        )
        tx.add("project", {"source_feedback_id": feedback["id"]})
    state = SimpleNamespace(
        settings=SimpleNamespace(mode="pilot"),
        store=store,
        clock=lambda: now,
        pilot_services=PilotServices({}),
    )
    request = cast(Request, cast(Any, SimpleNamespace(app=SimpleNamespace(state=state))))
    result = pilot_progress(request)
    assert result["completed_count"] == 0
    assert result["items"][0]["stages"]["model_draft"] is False
    assert result["items"][0]["stages"]["real_outcome"] is False
    with store.transaction(now) as tx:
        adopted = tx.add(
            "evaluation",
            {"evidence_ids": [evidence["id"]], "assistant_versions": {"node_run_id": run["id"]}},
            candidate_id=cid,
        )
        approved = tx.add("decision", {"evaluation_id": adopted["id"]}, candidate_id=cid)
        tx.update(cid, {"approval_id": approved["id"]})
        tx.add("validation_conclusion", {"approval_id": approved["id"]}, candidate_id=cid)
        actual = tx.add(
            "outcome",
            {
                "approval_id": approved["id"],
                "data_origin": "REAL",
                "status": "NOT_LAUNCHED",
                "reason": "Supplier unavailable",
            },
            candidate_id=cid,
        )
        confirmed = tx.add(
            "feedback", {"status": "CONFIRMED", "outcome_id": actual["id"]}, candidate_id=cid
        )
        tx.add("project", {"source_feedback_id": confirmed["id"]})
    assert pilot_progress(request)["completed_count"] == 1
