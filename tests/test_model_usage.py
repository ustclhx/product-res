from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from app.api.routes import pilot
from app.persistence.store import Store
from app.pilot import jobs
from app.pilot.services import PilotServices
from app.providers.assistant import AssistantInput, NodeKind
from app.providers.newapi import HTTPResponse, NewAPIAdapter, NewAPIConfig, NewAPIError
from fastapi import FastAPI
from fastapi.testclient import TestClient

NOW = datetime(2026, 9, 22, 8, tzinfo=UTC)


class StaticTransport:
    def __init__(self, response: HTTPResponse):
        self.response = response

    def request(self, *args: Any, **kwargs: Any) -> HTTPResponse:
        del args, kwargs
        return self.response


def _app(store: Store) -> FastAPI:
    app = FastAPI()
    app.state.settings = SimpleNamespace(mode="pilot")
    app.state.store = store
    app.state.clock = lambda: NOW
    app.state.pilot_services = PilotServices({})
    app.include_router(pilot.router, prefix="/api/v1")
    return app


def _seed(store: Store) -> tuple[str, str, str, str]:
    with store.transaction(NOW) as tx:
        first_project = tx.add("project", {"name": "first"})
        first_candidate = tx.add(
            "candidate", {"title": "one"}, project_id=first_project["id"]
        )
        second_project = tx.add("project", {"name": "second"})
        second_candidate = tx.add(
            "candidate", {"title": "two"}, project_id=second_project["id"]
        )
    return (
        str(first_project["id"]),
        str(first_candidate["id"]),
        str(second_project["id"]),
        str(second_candidate["id"]),
    )


def _enqueue(
    store: Store, project_id: str, candidate_id: str, *, model: str = "deepseek-v3"
) -> dict[str, Any]:
    with store.transaction(NOW) as tx:
        return jobs.enqueue(
            tx,
            "analyst",
            "assistant",
            {
                "provider": "newapi",
                "usage_context": {
                    "node_kind": "EVIDENCE_CHECKLIST",
                    "model": model,
                    "input_bytes": 123,
                    "max_output_tokens": 18_000,
                    "max_total_tokens": 200_000,
                },
            },
            project_id,
            candidate_id,
            max_attempts=2,
        )


def test_provider_validation_failure_keeps_usage_through_attempt_and_api(tmp_path: Path) -> None:
    store = Store(tmp_path / "usage.sqlite3", mode="pilot", workspace_id="workspace-1")
    project_id, candidate_id, _, _ = _seed(store)
    _enqueue(store, project_id, candidate_id)
    secret = tmp_path / "newapi.secret"
    secret.write_text("secret")
    response = HTTPResponse(
        status_code=200,
        headers={"x-request-id": "request-safe"},
        body=json.dumps(
            {
                "choices": [{"finish_reason": "stop", "message": {"content": "{"}}],
                "usage": {
                    "prompt_tokens": 11,
                    "completion_tokens": 4,
                    "total_tokens": 15,
                    "cost": "0.0012",
                    "currency": "USD",
                },
            }
        ).encode(),
    )
    adapter = NewAPIAdapter(
        NewAPIConfig(
            base_url="http://127.0.0.1:3000/v1",
            trusted_hosts=frozenset({"127.0.0.1"}),
            secret_file=secret,
            model="deepseek-v3",
            allow_http=True,
            max_output_tokens=18_000,
            max_total_tokens=200_000,
        ),
        StaticTransport(response),
    )

    def runner(_: dict[str, Any]) -> Any:
        try:
            return adapter.run(
                NodeKind.EVIDENCE_CHECKLIST,
                AssistantInput(candidate_id=candidate_id, criteria_id="criteria", evidence=[]),
            )
        except NewAPIError as exc:
            raise jobs.ExternalJobError(
                exc.code, "safe failure", diagnostic=exc.diagnostic
            ) from exc

    failed = jobs.process_one(store, runner, clock=lambda: NOW)
    assert failed is not None and failed["status"] == jobs.FAILED
    payload = TestClient(_app(store)).get(
        "/api/v1/pilot/model-usage", params={"candidate_id": candidate_id}
    ).json()
    assert payload["summary"] == {
        "receipt_count": 1,
        "unrecorded_attempt_count": 0,
        "usage_known_count": 1,
        "usage_partial_count": 0,
        "usage_unknown_count": 0,
        "input_tokens_known_sum": 11,
        "output_tokens_known_sum": 4,
        "total_tokens_known_sum": 15,
        "cost_by_currency": [{"currency": "USD", "cost": "0.0012"}],
    }
    item = payload["items"][0]
    assert item["outcome_status"] == "invalid_json"
    assert item["finish_reason"] == "stop"
    assert item["request_id"] == "request-safe"
    assert "content" not in repr(payload)
    assert "safe failure" not in repr(payload)


def test_retry_receipts_are_isolated_filtered_and_unknown_is_explicit(tmp_path: Path) -> None:
    store = Store(tmp_path / "retries.sqlite3", mode="pilot", workspace_id="workspace-1")
    first_project, first_candidate, second_project, second_candidate = _seed(store)
    first = _enqueue(store, first_project, first_candidate, model="=formula")

    jobs.process_one(
        store,
        lambda _: (_ for _ in ()).throw(
            jobs.ExternalJobError(
                "NEWAPI.SECRET_INVALID",
                "not sent",
                retryable=True,
                confirmed_not_sent=True,
            )
        ),
        clock=lambda: NOW,
    )
    jobs.process_one(
        store,
        lambda _: {
            "diagnostic": {
                "node_kind": "EVIDENCE_CHECKLIST",
                "model": "deepseek-v3",
                "input_bytes": 456,
                "input_tokens": 9,
                "output_tokens": None,
                "total_tokens": None,
                "elapsed_ms": 3,
                "max_output_tokens": 18_000,
                "max_total_tokens": 200_000,
            }
        },
        clock=lambda: NOW,
    )
    second = _enqueue(store, second_project, second_candidate)
    jobs.process_one(
        store,
        lambda _: (_ for _ in ()).throw(
            jobs.ExternalJobError("NEWAPI.NETWORK", "unknown", outcome_unknown=True)
        ),
        clock=lambda: NOW,
    )

    client = TestClient(_app(store))
    first_payload = client.get(
        "/api/v1/pilot/model-usage", params={"project_id": first_project}
    ).json()
    assert len(first_payload["items"]) == 2
    assert len({item["attempt_id"] for item in first_payload["items"]}) == 2
    assert {item["job_id"] for item in first_payload["items"]} == {first["id"]}
    assert first_payload["summary"]["usage_partial_count"] == 1
    assert first_payload["summary"]["usage_unknown_count"] == 1

    second_payload = client.get(
        "/api/v1/pilot/model-usage", params={"project_id": second_project}
    ).json()
    assert {item["job_id"] for item in second_payload["items"]} == {second["id"]}
    assert second_payload["items"][0]["outcome_status"] == "network_error"
    assert second_payload["summary"]["usage_unknown_count"] == 1

    exported = client.get(
        "/api/v1/pilot/model-usage/export", params={"project_id": first_project}
    )
    assert exported.content.startswith(b"\xef\xbb\xbf")
    assert "'=formula" in exported.text
