from pathlib import Path

from app.main import create_app
from app.persistence.store import DEMO_NOW
from fastapi.testclient import TestClient


def test_generic_evidence_cannot_bypass_physical_checklist(tmp_path: Path) -> None:
    app = create_app(tmp_path / "boundary.sqlite3")
    with app.state.store.transaction(DEMO_NOW) as tx:
        project = tx.add("project", {"analyst_id": "analyst", "decision_owner_id": "owner"})
        criteria = tx.add(
            "criteria",
            {"rules": [], "required_evidence": ["vehicle_fitment"]},
            project_id=project["id"],
        )
        tx.update(project["id"], {"current_criteria_id": criteria["id"]})
        candidate = tx.add("candidate", {"title": "OEM"}, project_id=project["id"])
    payload = {
        "actor_id": "analyst",
        "expected_version": candidate["version"],
        "field": "vehicle_fitment",
        "value": "PASS",
        "unit": "test_result",
        "source_locator": "desk review only",
        "observed_at": "2026-09-16T00:00:00Z",
        "epistemic_kind": "FACT",
        "verification": "VERIFIED",
        "verification_note": "no sample",
    }
    with TestClient(app) as client:
        response = client.post(
            f"/api/v1/candidates/{candidate['id']}/evidence",
            json=payload,
            headers={"Idempotency-Key": "cannot-bypass-fitment"},
        )
    assert response.status_code == 422
    assert response.json()["error_code"] == "STRUCTURED_FITMENT_REQUIRED"
    with app.state.store.transaction(DEMO_NOW) as tx:
        assert tx.list("evidence", candidate_id=candidate["id"]) == []
