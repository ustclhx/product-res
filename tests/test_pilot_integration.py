from __future__ import annotations

import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from app.core import DomainError
from app.main import create_app
from app.pilot.auth import ControlStore
from app.pilot.config import Settings
from app.pilot.jobs import ExternalJobError
from app.pilot.services import PilotServices
from app.pilot.worker import run_one
from app.providers.assistant import AssistantOutput, AssistantStatement, NodeKind
from app.providers.newapi import ProviderProvenance, ProviderResult, UsageRecord
from app.selection.market_intake import persist_discovery
from app.selection.projects import template_defaults
from fastapi.testclient import TestClient

NOW = datetime(2026, 9, 20, 8, tzinfo=UTC)


@pytest.fixture
def pilot(tmp_path: Path) -> dict[str, Any]:
    settings = Settings(
        mode="pilot",
        data_dir=tmp_path,
        public_url="http://localhost",
        demo_db_path=None,
        control_db_path=tmp_path / "control.sqlite3",
        workspaces_dir=tmp_path / "workspaces",
    )
    app = create_app(settings=settings)
    control: ControlStore = app.state.auth.control
    analyst = control.create_user("analyst", "Pilot Analyst", "correct horse battery staple")
    owner = control.create_user("owner", "Pilot Owner", "correct horse battery owner")
    first = control.init_workspace("partner", "Partner Workspace")
    second = control.init_workspace("internal", "Internal Workspace")
    for workspace in (first, second):
        control.add_member(workspace.id, analyst["username"], "analyst")
        control.add_member(workspace.id, owner["username"], "decision")

    market_secret = tmp_path / "market-secret"
    market_secret.write_text("market-secret-value", encoding="utf-8")
    newapi_secret = tmp_path / "newapi-secret"
    newapi_secret.write_text("newapi-secret-value", encoding="utf-8")
    configuration = {
        "workspaces": {
            workspace.id: {
                "dataforseo": {
                    "secret_file": str(market_secret),
                    "licensed": True,
                    "request_limit": 1,
                    "retention_days": 30,
                },
                "newapi": {
                    "secret_file": str(newapi_secret),
                    "request_limit": 4,
                    "model": "test-model",
                    "base_url": "http://localhost:19090",
                    "trusted_hosts": ["localhost"],
                },
            }
            for workspace in (first, second)
        }
    }
    app.state.pilot_services = PilotServices(configuration)
    return {
        "app": app,
        "analyst": analyst["id"],
        "owner": owner["id"],
        "partner": first.id,
        "internal": second.id,
        "control": control,
    }


def _login(
    harness: dict[str, Any], workspace_id: str, username: str = "analyst"
) -> tuple[TestClient, str]:
    client = TestClient(harness["app"])
    password = (
        "correct horse battery staple"
        if username == "analyst"
        else "correct horse battery owner"
    )
    response = client.post(
        "/api/v1/auth/login",
        headers={"Origin": "http://localhost"},
        json={"username": username, "password": password, "workspace_id": workspace_id},
    )
    assert response.status_code == 200, response.text
    return client, response.json()["csrf_token"]


def _write_headers(csrf: str, key: str) -> dict[str, str]:
    return {"Origin": "http://localhost", "X-CSRF-Token": csrf, "Idempotency-Key": key}


def _create_confirmed_project(
    harness: dict[str, Any], workspace_id: str, *, channel: str = "AMAZON"
) -> tuple[TestClient, str, dict[str, Any]]:
    analyst_client, analyst_csrf = _login(harness, workspace_id)
    project_response = analyst_client.post(
        "/api/v1/projects",
        headers=_write_headers(analyst_csrf, f"project-{workspace_id}-{channel}"),
        json={
            "actor_id": harness["analyst"],
            "name": f"{workspace_id} project",
            "channel": channel,
            "market": "US",
            "direction": "camping lamp",
            "goal": "validate bounded market evidence",
            "constraints": ["limited first order"],
            "analyst_id": harness["analyst"],
            "decision_owner_id": harness["owner"],
        },
    )
    assert project_response.status_code == 200, project_response.text
    project = project_response.json()["project"]

    owner_client, owner_csrf = _login(harness, workspace_id, "owner")
    defaults = template_defaults(
        {"AMAZON": "amazon-camping-v1", "DTC": "dtc-camping-v1"}[channel]
    )
    criteria_response = owner_client.post(
        f"/api/v1/projects/{project['id']}/criteria-revisions",
        headers=_write_headers(owner_csrf, f"criteria-{workspace_id}-{channel}"),
        json={
            **defaults,
            "actor_id": harness["owner"],
            "expected_version": project["version"],
            "parent_revision_id": None,
        },
    )
    assert criteria_response.status_code == 200, criteria_response.text
    return analyst_client, analyst_csrf, criteria_response.json()["project"]


def _market_result(*, channel: str = "AMAZON", is_demo: bool = False) -> dict[str, Any]:
    provider = "fake-dataforseo" if channel == "AMAZON" else "fake-serpapi"
    return {
        "coverage": "COVERED",
        "provider": provider,
        "channel": channel,
        "market": "US",
        "query": "camping lamp",
        "is_demo": is_demo,
        "meta": {"request_id": "fake-request-1", "latency_ms": 1, "raw_response_hash": "abc"},
        "items": [
            {
                "external_id": "FAKE-1",
                "name": "Fake market lamp",
                "source_url": "https://market.example/items/fake-1",
                "stable_id": f"{provider}:us:FAKE-1",
                "offer_id": f"{provider}:us:offer:FAKE-1",
                "observations": [
                    {"field": "price", "value": 19.5, "unit": "per_item", "currency": "USD"}
                ],
            },
            {
                "external_id": "FAKE-2",
                "name": "Second fake lamp",
                "source_url": "https://market.example/items/fake-2",
                "stable_id": f"{provider}:us:FAKE-2",
                "offer_id": f"{provider}:us:offer:FAKE-2",
                "observations": [],
            },
        ],
    }


def _run_worker(harness: dict[str, Any], workspace_id: str, runner: Any) -> dict[str, Any] | None:
    store = harness["control"].workspace_store(workspace_id)
    services = harness["app"].state.pilot_services
    services.runner = runner
    return run_one(harness["control"], store, services)


def test_pilot_discovery_uses_real_batch_and_deduplicates_selection(pilot: dict[str, Any]) -> None:
    client, csrf, project = _create_confirmed_project(pilot, pilot["partner"])
    queued = client.post(
        f"/api/v1/projects/{project['id']}/discovery",
        headers=_write_headers(csrf, "discovery-1"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": project["version"],
            "query": "camping lamp",
        },
    )
    assert queued.status_code == 200, queued.text
    job_id = queued.json()["job"]["id"]
    result = _run_worker(pilot, pilot["partner"], lambda _job: _market_result())
    assert result is not None and result["status"] == "SUCCEEDED"

    jobs = client.get("/api/v1/pilot/jobs", params={"project_id": project["id"]})
    assert jobs.status_code == 200
    assert jobs.json()["items"][0]["id"] == job_id
    batch = client.get(f"/api/v1/pilot/batches/{result['business_result']['batch']['id']}")
    assert batch.status_code == 200, batch.text
    item = batch.json()["items"][0]
    assert batch.json()["batch"]["is_demo"] is False

    first = client.post(
        f"/api/v1/projects/{project['id']}/discovery/candidates",
        headers=_write_headers(csrf, "select-1"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": project["version"],
            "batch_id": item["batch_id"],
            "item_id": item["id"],
        },
    )
    second = client.post(
        f"/api/v1/projects/{project['id']}/discovery/candidates",
        headers=_write_headers(csrf, "select-2"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": project["version"],
            "batch_id": item["batch_id"],
            "item_id": item["id"],
        },
    )
    assert first.status_code == second.status_code == 200
    assert first.json()["candidate"]["id"] == second.json()["candidate"]["id"]
    candidate = first.json()["candidate"]
    detail = client.get(f"/api/v1/candidates/{candidate['id']}").json()
    assert len(detail["sources"]) == 1
    assert len(detail["evidence"]) == 1
    assert detail["evidence"][0]["verification"] == "UNVERIFIED"


def test_pilot_rejects_tampered_or_demo_discovery_payloads(pilot: dict[str, Any]) -> None:
    client, csrf, project = _create_confirmed_project(pilot, pilot["partner"])
    queued = client.post(
        f"/api/v1/projects/{project['id']}/discovery",
        headers=_write_headers(csrf, "discovery-tamper"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": project["version"],
            "query": "lamp",
        },
    )
    assert queued.status_code == 200
    result = _run_worker(pilot, pilot["partner"], lambda _job: _market_result())
    assert result is not None
    batch_id = result["business_result"]["batch"]["id"]
    item_ids = result["business_result"]["batch"]["item_ids"]

    other_client, other_csrf, other_project = _create_confirmed_project(
        pilot, pilot["partner"], channel="DTC"
    )
    tampered = other_client.post(
        f"/api/v1/projects/{other_project['id']}/discovery/candidates",
        headers=_write_headers(other_csrf, "tampered-project"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": other_project["version"],
            "batch_id": batch_id,
            "item_id": item_ids[0],
        },
    )
    assert tampered.status_code == 422
    assert tampered.json()["error_code"] == "DISCOVERY_SELECTION_INVALID"

    demo_payload = client.post(
        f"/api/v1/projects/{project['id']}/discovery/candidates",
        headers=_write_headers(csrf, "fixture-selection"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": project["version"],
            "selection": {
                "title": "fixture",
                "external_id": "fixture-1",
                "source_url": "https://fixture.example/item",
                "source_ref": "fixture:1",
                "is_demo": True,
            },
        },
    )
    assert demo_payload.status_code == 422
    assert demo_payload.json()["error_code"] == "DISCOVERY_BATCH_REQUIRED"

    store = pilot["control"].workspace_store(pilot["partner"])
    with store.transaction(NOW) as tx:
        with pytest.raises(DomainError, match="真实来源不能返回演示数据"):
            persist_discovery(tx, project["id"], _market_result(is_demo=True), retention_days=30)


def test_pilot_workspace_store_keeps_same_external_ids_isolated(
    pilot: dict[str, Any],
) -> None:
    client, csrf, project = _create_confirmed_project(pilot, pilot["partner"])
    queued = client.post(
        f"/api/v1/projects/{project['id']}/discovery",
        headers=_write_headers(csrf, "workspace-isolation"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": project["version"],
            "query": "lamp",
        },
    )
    assert queued.status_code == 200
    result = _run_worker(pilot, pilot["partner"], lambda _job: _market_result())
    assert result is not None
    batch = result["business_result"]["batch"]
    selected = client.post(
        f"/api/v1/projects/{project['id']}/discovery/candidates",
        headers=_write_headers(csrf, "workspace-select"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": project["version"],
            "batch_id": batch["id"],
            "item_id": batch["item_ids"][0],
        },
    )
    assert selected.status_code == 200
    candidate_id = selected.json()["candidate"]["id"]

    internal, _ = _login(pilot, pilot["internal"])
    assert internal.get(f"/api/v1/projects/{project['id']}").status_code == 404
    assert internal.get(f"/api/v1/candidates/{candidate_id}").status_code == 404
    assert internal.get(f"/api/v1/pilot/batches/{batch['id']}").status_code == 404


def test_quota_reservation_survives_unknown_provider_result(pilot: dict[str, Any]) -> None:
    client, csrf, project = _create_confirmed_project(pilot, pilot["partner"])
    first = client.post(
        f"/api/v1/projects/{project['id']}/discovery",
        headers=_write_headers(csrf, "quota-first"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": project["version"],
            "query": "lamp",
        },
    )
    assert first.status_code == 200
    calls = 0

    def unknown(_job: dict[str, Any]) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        raise ExternalJobError(
            "PROVIDER_TIMEOUT", "authorization=top-secret gateway timeout", outcome_unknown=True
        )

    result = _run_worker(pilot, pilot["partner"], unknown)
    assert result is not None and result["status"] == "OUTCOME_UNKNOWN"
    assert calls == 1
    assert _run_worker(pilot, pilot["partner"], unknown) is None
    assert calls == 1
    second = client.post(
        f"/api/v1/projects/{project['id']}/discovery",
        headers=_write_headers(csrf, "quota-second"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": project["version"],
            "query": "lamp",
        },
    )
    assert second.status_code == 409
    assert second.json()["details"]["status"] == "QUOTA_EXHAUSTED"
    assert "top-secret" not in result["last_error"]["message"]


def test_slow_external_call_allows_write_and_stale_output_is_not_adopted(
    pilot: dict[str, Any],
) -> None:
    client, csrf, project = _create_confirmed_project(pilot, pilot["partner"])
    queued = client.post(
        f"/api/v1/projects/{project['id']}/discovery",
        headers=_write_headers(csrf, "slow-job"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": project["version"],
            "query": "lamp",
        },
    )
    assert queued.status_code == 200
    entered = threading.Event()
    release = threading.Event()
    result_box: list[dict[str, Any] | None] = []

    def slow(_job: dict[str, Any]) -> dict[str, Any]:
        entered.set()
        assert release.wait(timeout=3)
        return _market_result()

    worker = threading.Thread(
        target=lambda: result_box.append(_run_worker(pilot, pilot["partner"], slow)), daemon=True
    )
    worker.start()
    assert entered.wait(timeout=3)
    started = time.monotonic()
    with pilot["control"].workspace_store(pilot["partner"]).transaction(NOW) as tx:
        tx.add("source", {"provider": "slow-test"}, project_id=project["id"])
    assert time.monotonic() - started < 1.0

    # Change the project while the external call is in flight. The output remains historical.
    with pilot["control"].workspace_store(pilot["partner"]).transaction(NOW) as tx:
        changed = tx.update(project["id"], {"goal": "changed while provider was running"})
    assert changed["version"] != project["version"]
    release.set()
    worker.join(timeout=3)
    assert not worker.is_alive()
    assert result_box[0] is not None
    assert result_box[0]["status"] == "SUCCEEDED"
    assert result_box[0]["result_disposition"] == "STALE"
    assert result_box[0]["adoptable"] is False
    with pilot["control"].workspace_store(pilot["partner"]).transaction(NOW) as tx:
        assert tx.list("discovery_batch", project_id=project["id"]) == []


def test_pilot_newapi_draft_is_real_and_fixture_runs_are_forbidden(pilot: dict[str, Any]) -> None:
    client, csrf, project = _create_confirmed_project(pilot, pilot["partner"])
    queued = client.post(
        f"/api/v1/projects/{project['id']}/discovery",
        headers=_write_headers(csrf, "newapi-discovery"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": project["version"],
            "query": "lamp",
        },
    )
    assert queued.status_code == 200
    result = _run_worker(pilot, pilot["partner"], lambda _job: _market_result())
    assert result is not None
    batch = result["business_result"]["batch"]
    candidate_response = client.post(
        f"/api/v1/projects/{project['id']}/discovery/candidates",
        headers=_write_headers(csrf, "newapi-select"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": project["version"],
            "batch_id": batch["id"],
            "item_id": batch["item_ids"][0],
        },
    )
    assert candidate_response.status_code == 200, candidate_response.text
    candidate_id = candidate_response.json()["candidate"]["id"]
    forbidden = client.post(
        f"/api/v1/candidates/{candidate_id}/assistant-runs",
        headers=_write_headers(csrf, "assistant-fixture"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": candidate_response.json()["candidate"]["version"],
            "node_kind": NodeKind.EVIDENCE_CHECKLIST.value,
            "fixture": "invalid_reference",
        },
    )
    assert forbidden.status_code == 422, forbidden.text
    assert forbidden.json()["error_code"] == "SIMULATION_FORBIDDEN"
    queued_assistant = client.post(
        f"/api/v1/candidates/{candidate_id}/assistant-runs",
        headers=_write_headers(csrf, "assistant-live"),
        json={
            "actor_id": pilot["analyst"],
            "expected_version": candidate_response.json()["candidate"]["version"],
            "node_kind": NodeKind.EVIDENCE_CHECKLIST.value,
            "fixture": "default",
        },
    )
    assert queued_assistant.status_code == 200, queued_assistant.text
    job = queued_assistant.json()["job"]
    prepared = job
    with pilot["control"].workspace_store(pilot["partner"]).transaction(NOW) as tx:
        persisted = tx.get(job["id"], "job")
        prepared = persisted["input_snapshot"]["prepared"]
    statement_ids = [item["id"] for item in prepared["input_snapshot"]["evidence"]]
    output = AssistantOutput(
        node_kind=NodeKind.EVIDENCE_CHECKLIST,
        summary="A bounded live draft",
        dimensions={},
        statements=(
            [
                AssistantStatement(
                    text="A source observation is available.",
                    kind="FACT",
                    evidence_ids=statement_ids[:1],
                )
            ]
            if statement_ids
            else []
        ),
        citations=statement_ids[:1],
        unknowns=prepared["input_snapshot"]["missing_fields"],
        counterevidence=[],
        assumptions=[],
        recommendations=["verify supplier evidence"],
        provider="newapi-test",
        model_version="test-model",
        prompt_version="pilot-test-prompt",
        schema_version="pilot-test-schema",
        is_simulated=False,
    )
    provider_result = ProviderResult(
        output=output,
        provenance=ProviderProvenance(
            provider="newapi-test",
            model="test-model",
            request_id="request-1",
            elapsed_ms=1,
            prompt_version="pilot-test-prompt",
            schema_version="pilot-test-schema",
        ),
        usage=UsageRecord(total_tokens=1),
    )
    completed = _run_worker(
        pilot,
        pilot["partner"],
        lambda _job: provider_result.model_dump(mode="json"),
    )
    assert completed is not None and completed["status"] == "SUCCEEDED"
    assert completed["adoptable"] is True
    with pilot["control"].workspace_store(pilot["partner"]).transaction(NOW) as tx:
        runs = tx.list("node_run", candidate_id=candidate_id)
        assert len(runs) == 1
        assert runs[0]["is_simulated"] is False
