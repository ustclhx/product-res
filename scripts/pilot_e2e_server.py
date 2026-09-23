"""Offline pilot runtime used by the browser acceptance test.

This is deliberately a test entrypoint.  It creates an isolated control store,
two workspace stores, and injects deterministic provider responses into the
process-local service object.  No provider environment variable is changed and
no external account or network is contacted.
"""

from __future__ import annotations

# Direct script execution adds the repository root before application imports.
# ruff: noqa: E402
import argparse
import signal
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any
from unittest.mock import patch

import uvicorn

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from app.main import create_app
from app.pilot.admin import bootstrap_admin
from app.pilot.auth import ControlStore
from app.pilot.config import Settings
from app.pilot.services import PilotServices
from app.pilot.worker import run_one
from app.providers.assistant import AssistantOutput, AssistantStatement, NodeKind
from app.providers.newapi import ProviderProvenance, ProviderResult, UsageRecord
from app.selection.live_assistant import PreparedAssistantRun

ANALYST_PASSWORD = "pilot-e2e-analyst-password"
OWNER_PASSWORD = "pilot-e2e-owner-password"
ADMIN_PASSWORD = "pilot-e2e-admin-password"


def _market_result(job: dict[str, Any]) -> dict[str, Any]:
    snapshot = job["input_snapshot"]
    provider = str(snapshot["provider"])
    channel = str(snapshot["channel"])
    query = str(snapshot["query"])
    return {
        "coverage": "COVERED",
        "provider": f"pilot-e2e-{provider}",
        "channel": channel,
        "market": "US",
        "query": query,
        "is_demo": False,
        "meta": {
            "request_id": "pilot-e2e-market-1",
            "latency_ms": 1,
            "raw_response_hash": "pilot-e2e-market-hash",
        },
        "items": [
            {
                "external_id": "PILOT-E2E-1",
                "name": "Pilot E2E camping lamp",
                "source_url": "https://pilot-e2e.example/items/1",
                "stable_id": f"pilot-e2e:{channel.lower()}:1",
                "offer_id": f"pilot-e2e:{channel.lower()}:offer:1",
                "observations": [
                    {"field": "price", "value": 29.99, "unit": "per_item", "currency": "USD"}
                ],
            }
        ],
    }


def _assistant_result(job: dict[str, Any]) -> dict[str, Any]:
    prepared = PreparedAssistantRun.model_validate(job["input_snapshot"]["prepared"])
    node_kind = prepared.node_kind
    evidence_ids = sorted(str(item["id"]) for item in prepared.input_snapshot.evidence)
    statement = (
        [
            AssistantStatement(
                text="The pilot source evidence is available for human review.",
                kind="FACT",
                evidence_ids=evidence_ids[:1],
            )
        ]
        if evidence_ids
        else []
    )
    dimensions: dict[str, dict[str, Any]] = {}
    if node_kind is NodeKind.EVALUATION_ORGANIZER:
        dimensions = {
            name: {
                "summary": "Pilot draft requires human review.",
                "evidence_ids": evidence_ids[:1],
            }
            for name in ("demand", "competition", "differentiation", "supply_cost", "risk")
        }
    output = AssistantOutput(
        node_kind=node_kind,
        summary="Pilot offline model draft; review before adoption.",
        dimensions=dimensions,
        statements=statement,
        citations=evidence_ids[:1],
        unknowns=list(prepared.input_snapshot.missing_fields),
        counterevidence=[],
        assumptions=["Offline controlled provider fixture"],
        recommendations=["Human review required before saving the evaluation"],
        provider="pilot-e2e-model",
        model_version="pilot-e2e-model-v1",
        prompt_version="pilot-e2e-prompt-v1",
        schema_version="pilot-e2e-schema-v1",
        is_simulated=False,
    )
    result = ProviderResult(
        output=output,
        provenance=ProviderProvenance(
            provider="pilot-e2e-model",
            model="pilot-e2e-model-v1",
            request_id="pilot-e2e-model-1",
            elapsed_ms=1,
            prompt_version="pilot-e2e-prompt-v1",
            schema_version="pilot-e2e-schema-v1",
        ),
        usage=UsageRecord(total_tokens=1),
    )
    return result.model_dump(mode="json")


class OfflinePilotServices(PilotServices):
    """Provider facade whose responses are deterministic and process-local."""

    def runner(self, job: dict[str, Any]) -> dict[str, Any]:
        if job["job_kind"] == "discovery":
            return _market_result(job)
        return _assistant_result(job)


def _seed(settings: Settings) -> tuple[Any, ControlStore]:
    app = create_app(settings=settings)
    control: ControlStore = app.state.auth.control
    analyst = control.create_user("analyst", "Pilot E2E Analyst", ANALYST_PASSWORD)
    owner = control.create_user("owner", "Pilot E2E Owner", OWNER_PASSWORD)
    partner = control.init_workspace("partner-e2e", "Partner E2E Workspace")
    internal = control.init_workspace("internal-e2e", "Internal E2E Workspace")
    for workspace in (partner, internal):
        control.add_member(workspace.id, analyst["username"], "analyst")
        control.add_member(workspace.id, owner["username"], "decision")

    # Exercise the server-owned bootstrap path while making its one-time
    # credential deterministic for this isolated browser fixture.  The
    # helper still creates the account and all-workspace contributor grants;
    # patching only its random password source avoids putting a generated
    # credential in a test artifact or external environment.
    with patch("app.pilot.admin.secrets.token_urlsafe", return_value=ADMIN_PASSWORD):
        bootstrap_admin(control, "admin", "Pilot E2E Administrator")

    # Files only satisfy the normal readiness checks; the overridden runner
    # never opens them and never contacts their configured base URLs.
    secret = settings.data_dir / "pilot-e2e-provider-secret"
    secret.write_text("offline-test-secret", encoding="utf-8")
    app.state.pilot_services = OfflinePilotServices(
        {
            "workspaces": {
                partner.id: {
                    "dataforseo": {
                        "secret_file": str(secret),
                        "licensed": True,
                        "request_limit": 3,
                        "retention_days": 30,
                    },
                    "newapi": {
                        "secret_file": str(secret),
                        "request_limit": 6,
                        "model": "pilot-e2e-model-v1",
                        "base_url": "http://127.0.0.1:9",
                        "trusted_hosts": ["127.0.0.1"],
                    },
                }
            }
        }
    )
    return app, control


def main() -> None:
    parser = argparse.ArgumentParser(description="Run an isolated offline pilot E2E API")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8003)
    args = parser.parse_args()

    data_dir = Path(tempfile.mkdtemp(prefix="product-res-pilot-e2e-"))
    settings = Settings(
        mode="pilot",
        data_dir=data_dir,
        public_url="http://127.0.0.1:5175",
        demo_db_path=None,
        control_db_path=data_dir / "control.sqlite3",
        workspaces_dir=data_dir / "workspaces",
    )
    app, control = _seed(settings)
    stop = threading.Event()

    def worker_loop() -> None:
        while not stop.is_set():
            for workspace in control.list_workspaces():
                try:
                    run_one(
                        control, control.workspace_store(workspace.id), app.state.pilot_services
                    )
                except Exception as exc:  # pragma: no cover - surfaced by the browser job state
                    print(f"pilot-e2e worker error: {exc}", flush=True)
            stop.wait(0.05)

    threading.Thread(target=worker_loop, name="pilot-e2e-worker", daemon=True).start()
    config = uvicorn.Config(app, host=args.host, port=args.port, log_level="warning")
    server = uvicorn.Server(config)
    signal.signal(signal.SIGTERM, lambda *_: setattr(server, "should_exit", True))
    signal.signal(signal.SIGINT, lambda *_: setattr(server, "should_exit", True))
    try:
        server.run()
    finally:
        stop.set()


if __name__ == "__main__":
    main()
