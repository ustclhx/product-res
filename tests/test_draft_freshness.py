from datetime import timedelta
from pathlib import Path

from app.persistence.store import DEMO_NOW, RESERVED, Store
from app.pilot.context import RequestIdentity, WorkspaceMember, bind_request
from app.providers.assistant import NodeKind
from app.selection.live_assistant import persist_result, prepare, project_run
from tests.test_newapi import _evidence, _provider_result, _seed
from tests.test_pilot_auth import pilot  # noqa: F401


def test_projection_detects_revision_and_does_not_mutate_history(tmp_path: Path) -> None:
    store = Store(tmp_path / "fresh.sqlite3")
    with store.transaction(DEMO_NOW) as tx:
        project, _, candidate = _seed(tx)
        first = _evidence(tx, project["id"], candidate["id"], value="first")
        prepared = prepare(tx, "analyst", candidate["id"], NodeKind.EVALUATION_ORGANIZER)
        run = persist_result(tx, prepared, _provider_result(NodeKind.EVALUATION_ORGANIZER))[
            "node_run"
        ]
        assert project_run(tx, run)["is_stale"] is False
        _evidence(tx, project["id"], candidate["id"], value="revised", supersedes_id=first["id"])
        projected = project_run(tx, run)
        assert projected["is_stale"] is True
        assert any("证据" in reason for reason in projected["stale_reasons"])
        assert projected["current_input_hash"] != run["input_hash"]
        assert tx.get(run["id"], "node_run") == run
        assert run["is_stale"] is False


def test_optional_evidence_expiration_and_criteria_change(tmp_path: Path) -> None:
    store = Store(tmp_path / "expiry.sqlite3")
    with store.transaction(DEMO_NOW) as tx:
        project, criteria, candidate = _seed(tx)
        item = _evidence(tx, project["id"], candidate["id"], value="first")
        tx.add(
            "evidence",
            {
                **{k: v for k, v in item.items() if k not in RESERVED},
                "supersedes_id": item["id"],
                "valid_until": (DEMO_NOW + timedelta(hours=1)).isoformat(),
            },
            project_id=project["id"],
            candidate_id=candidate["id"],
        )
        prepared = prepare(tx, "analyst", candidate["id"], NodeKind.EVALUATION_ORGANIZER)
        run = persist_result(tx, prepared, _provider_result(NodeKind.EVALUATION_ORGANIZER))[
            "node_run"
        ]
        assert project_run(tx, run)["is_stale"] is False
    with store.transaction(DEMO_NOW + timedelta(hours=2)) as tx:
        assert any("到期" in r for r in project_run(tx, run)["stale_reasons"])
        new = tx.add(
            "criteria",
            {**{k: v for k, v in criteria.items() if k not in RESERVED}, "template_version": "2"},
            project_id=project["id"],
        )
        tx.update(project["id"], {"current_criteria_id": new["id"]})
        assert any("标准" in r for r in project_run(tx, run)["stale_reasons"])


def test_reader_does_not_impersonate_original_analyst(tmp_path: Path) -> None:
    store = Store(tmp_path / "reader.sqlite3")
    with store.transaction(DEMO_NOW) as tx:
        _, _, candidate = _seed(tx)
        prepared = prepare(tx, "analyst", candidate["id"], NodeKind.EVALUATION_ORGANIZER)
        run = persist_result(tx, prepared, _provider_result(NodeKind.EVALUATION_ORGANIZER))[
            "node_run"
        ]
    identity = RequestIdentity(
        user_id="owner",
        username="owner",
        display_name="Owner",
        workspace_id="test",
        workspace_name="Test",
        workspace_slug="test",
        role="decision",
        session_id="s",
        csrf_hash="",
        expires_at="",
        members=(WorkspaceMember("owner", "Owner", "decision"),),
    )
    with bind_request(identity, store), store.transaction(DEMO_NOW) as tx:
        assert project_run(tx, run)["is_stale"] is False
        broken = {**run, "prepared": None}
        assert project_run(tx, broken)["is_stale"] is True
        assert project_run(tx, broken)["stale_reasons"]


def test_returned_questions_and_unrelated_candidate_changes(tmp_path: Path) -> None:
    store = Store(tmp_path / "questions.sqlite3")
    with store.transaction(DEMO_NOW) as tx:
        project, _, candidate = _seed(tx)
        prepared = prepare(tx, "analyst", candidate["id"], NodeKind.EVALUATION_ORGANIZER)
        run = persist_result(tx, prepared, _provider_result(NodeKind.EVALUATION_ORGANIZER))[
            "node_run"
        ]
        tx.update(candidate["id"], {"title": "renamed without changing material"})
        assert project_run(tx, run)["is_stale"] is False
        tx.add(
            "decision",
            {"action": "RETURN", "questions": ["确认采购单价"]},
            project_id=project["id"],
            candidate_id=candidate["id"],
        )
        tx.update(candidate["id"], {"business_status": "RETURNED"})
        assert any("人审" in r for r in project_run(tx, run)["stale_reasons"])


def test_review_freshness_keeps_frozen_approval_and_selected_outcome(tmp_path: Path) -> None:
    from tests.test_lifecycle import seed
    from tests.test_outcome_live import _record

    store = Store(tmp_path / "review.sqlite3")
    with store.transaction(DEMO_NOW) as tx:
        seed(tx)
        tx.update("candidate-1", {"business_status": "OUTCOME_PENDING"})
        outcome, _ = _record(tx, origin="REAL")
        snapshot = prepare(tx, "analyst", "candidate-1", NodeKind.OUTCOME_REVIEW, outcome["id"])
        run = persist_result(tx, snapshot, _provider_result(NodeKind.OUTCOME_REVIEW))["node_run"]
        _evidence(tx, "project-1", "candidate-1", value="new current research")
        assert project_run(tx, run)["is_stale"] is False
        approval = tx.get("approval-1", "decision")
        new = tx.add(
            "decision",
            {k: v for k, v in approval.items() if k not in RESERVED},
            project_id="project-1",
            candidate_id="candidate-1",
        )
        tx.update("candidate-1", {"approval_id": new["id"]})
        assert project_run(tx, run)["is_stale"] is True


def test_candidate_get_projects_freshness_and_adoption_rejects_old_input(pilot) -> None:  # noqa: F811
    from app.pilot.worker import worker_identity
    from tests.test_pilot_auth import _headers, _login

    analyst_id = pilot["users"]["analyst"]["id"]
    workspace_id = pilot["workspaces"]["partner"].id
    store = pilot["control"].workspace_store(workspace_id)
    identity = worker_identity(pilot["control"], workspace_id, analyst_id)
    with bind_request(identity, store), store.transaction(DEMO_NOW) as tx:
        project, _, candidate = _seed(tx)
        tx.update(project["id"], {"analyst_id": analyst_id})
        snapshot = prepare(tx, analyst_id, candidate["id"], NodeKind.EVALUATION_ORGANIZER)
        run = persist_result(tx, snapshot, _provider_result(NodeKind.EVALUATION_ORGANIZER))[
            "node_run"
        ]
    owner, _, _ = _login(pilot, "owner")
    detail = owner.get(f"/api/v1/candidates/{candidate['id']}")
    assert detail.status_code == 200
    assert detail.json()["node_runs"][0]["is_stale"] is False
    with store.transaction(DEMO_NOW) as tx:
        _evidence(tx, project["id"], candidate["id"], value="changed")
    assert owner.get(f"/api/v1/candidates/{candidate['id']}").json()["node_runs"][0]["is_stale"]
    analyst, csrf, _ = _login(pilot)
    response = analyst.post(
        f"/api/v1/candidates/{candidate['id']}/evaluations",
        headers=_headers(csrf),
        json={
            "expected_version": candidate["version"],
            "assistant_run_id": run["id"],
            "dimensions": {
                k: {"summary": "manual review", "evidence_ids": []}
                for k in ("demand", "competition", "differentiation", "supply_cost", "risk")
            },
            "evidence_ids": [],
            "unknowns": [],
            "counterevidence": [],
            "assumptions": [],
            "forecast": {
                "metrics": {
                    k: None
                    for k in (
                        "revenue",
                        "procurement",
                        "platform",
                        "fulfillment",
                        "advertising",
                        "refunds",
                        "other",
                    )
                }
            },
            "assistant_versions": {},
        },
    )
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "ASSISTANT_STALE"
    outsider, _, _ = _login(pilot, workspace="internal")
    assert outsider.get(f"/api/v1/candidates/{candidate['id']}").status_code == 404


def test_new_project_analyst_can_adopt_fresh_predecessor_draft(pilot) -> None:  # noqa: F811
    from app.pilot.worker import worker_identity
    from fastapi.testclient import TestClient
    from tests.test_pilot_auth import ORIGIN, _headers

    control = pilot["control"]
    workspace_id = pilot["workspaces"]["partner"].id
    original = pilot["users"]["analyst"]["id"]
    successor = control.create_user("successor", "Successor", "successor-regression-password")
    control.add_member(workspace_id, "successor", "analyst")
    store = control.workspace_store(workspace_id)
    with bind_request(worker_identity(control, workspace_id, original), store):
        with store.transaction(DEMO_NOW) as tx:
            project, _, candidate = _seed(tx)
            tx.update(project["id"], {"analyst_id": original})
            prepared = prepare(tx, original, candidate["id"], NodeKind.EVALUATION_ORGANIZER)
            run = persist_result(tx, prepared, _provider_result(NodeKind.EVALUATION_ORGANIZER))[
                "node_run"
            ]
            tx.update(project["id"], {"analyst_id": successor["id"]})
    client = TestClient(pilot["app"])
    logged = client.post(
        "/api/v1/auth/login",
        headers={"Origin": ORIGIN},
        json={
            "username": "successor",
            "password": "successor-regression-password",
            "workspace_id": workspace_id,
        },
    )
    assert logged.status_code == 200
    assert (
        client.get(f"/api/v1/candidates/{candidate['id']}").json()["node_runs"][0]["is_stale"]
        is False
    )
    response = client.post(
        f"/api/v1/candidates/{candidate['id']}/evaluations",
        headers=_headers(logged.json()["csrf_token"], "successor-adopt"),
        json={
            "expected_version": candidate["version"],
            "assistant_run_id": run["id"],
            "dimensions": {
                key: {"summary": "successor reviewed", "evidence_ids": []}
                for key in ("demand", "competition", "differentiation", "supply_cost", "risk")
            },
            "evidence_ids": [],
            "unknowns": [],
            "counterevidence": [],
            "assumptions": [],
            "forecast": {
                "metrics": {
                    key: None
                    for key in (
                        "revenue",
                        "procurement",
                        "platform",
                        "fulfillment",
                        "advertising",
                        "refunds",
                        "other",
                    )
                }
            },
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["evaluation"]["assistant_versions"]["node_run_id"] == run["id"]
