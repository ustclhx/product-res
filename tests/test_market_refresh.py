from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from app.persistence.store import Store
from app.pilot.context import RequestIdentity, WorkspaceMember, bind_request
from app.pilot.services import PilotServices
from app.selection.market_intake import persist_discovery, select_item

NOW = datetime(2026, 9, 22, 8, tzinfo=UTC)


def _identity(workspace_id: str = "workspace-1") -> RequestIdentity:
    return RequestIdentity(
        user_id="analyst",
        username="analyst",
        display_name="Analyst",
        workspace_id=workspace_id,
        workspace_name="Workspace",
        workspace_slug="workspace",
        role="analyst",
        session_id="session",
        csrf_hash="",
        expires_at="",
        members=(WorkspaceMember("analyst", "Analyst", "analyst"),),
    )


def _project(tx: Any, name: str = "Market project") -> dict[str, Any]:
    return tx.add(
        "project",
        {
            "name": name,
            "channel": "AMAZON",
            "market": "US",
            "analyst_id": "analyst",
            "decision_owner_id": "owner",
            "current_criteria_id": "criteria-1",
        },
    )


def _services(secret: Path, *, limit: int = 2) -> PilotServices:
    secret.write_text("login:password", encoding="utf-8")
    return PilotServices(
        {
            "workspaces": {
                "workspace-1": {
                    "dataforseo": {
                        "secret_file": str(secret),
                        "licensed": True,
                        "request_limit": limit,
                        "retention_days": 30,
                        "timeout_seconds": 45,
                    }
                }
            }
        }
    )


def _result(value: str) -> dict[str, Any]:
    return {
        "coverage": "COVERED",
        "provider": "dataforseo_amazon",
        "channel": "AMAZON",
        "market": "US",
        "query": "seat organizer",
        "is_demo": False,
        "meta": {"request_id": f"request-{value}", "cost": 0.003, "raw_response_hash": value},
        "items": [
            {
                "external_id": "B012345678",
                "name": "Seat organizer",
                "source_url": "https://www.amazon.com/dp/B012345678",
                "stable_id": "dataforseo_amazon:us:B012345678",
                "offer_id": "dataforseo_amazon:us:offer:B012345678",
                "observations": [
                    {"field": "price", "value": value, "unit": "per_item", "currency": "USD"}
                ],
            }
        ],
    }


def test_history_reuse_does_not_reserve_request_and_refresh_does(tmp_path: Path) -> None:
    store = Store(tmp_path / "workspace.sqlite3", mode="pilot", workspace_id="workspace-1")
    services = _services(tmp_path / "secret")
    with bind_request(_identity(), store), store.transaction(NOW) as tx:
        project = _project(tx)
        first = services.enqueue_discovery(
            tx, "analyst", project["id"], "seat organizer", "dataforseo"
        )
        assert services.sources(tx)[0]["requests_remaining"] == 1

    with bind_request(_identity(), store), store.transaction(NOW + timedelta(minutes=1)) as tx:
        history = services.discovery_history(tx, project["id"], "dataforseo")
        assert [item["id"] for item in history] == [first["job"]["id"]]
        assert len(tx.list("job", project_id=project["id"])) == 1
        assert services.sources(tx)[0]["requests_remaining"] == 1
        second = services.enqueue_discovery(
            tx, "analyst", project["id"], "seat organizer", "dataforseo"
        )
        assert second["job"]["id"] != first["job"]["id"]
        assert services.sources(tx)[0]["requests_remaining"] == 0


def test_history_is_project_scoped_and_preserves_failure_without_reissue(tmp_path: Path) -> None:
    store = Store(tmp_path / "scoped.sqlite3", mode="pilot", workspace_id="workspace-1")
    services = _services(tmp_path / "secret", limit=3)
    with bind_request(_identity(), store), store.transaction(NOW) as tx:
        first_project = _project(tx, "First")
        second_project = _project(tx, "Second")
        failed = services.enqueue_discovery(
            tx, "analyst", first_project["id"], "seat organizer", "dataforseo"
        )["job"]
        tx.update(
            failed["id"],
            {
                "status": "FAILED",
                "last_error": {"code": "MARKET_AUTH", "message": "failed"},
            },
        )
        services.enqueue_discovery(
            tx, "analyst", second_project["id"], "other query", "dataforseo"
        )

    with bind_request(_identity(), store), store.transaction(NOW + timedelta(minutes=1)) as tx:
        history = services.discovery_history(tx, first_project["id"], "dataforseo")
        assert len(history) == 1
        assert history[0]["state"] == "FAILED"
        assert history[0]["recovery"]["kind"] == "PROVIDER_CHECK"
        assert len(tx.list("job")) == 2
        assert services.sources(tx)[0]["requests_remaining"] == 1


def test_refreshing_same_item_appends_a_new_observation(tmp_path: Path) -> None:
    store = Store(tmp_path / "observations.sqlite3", mode="pilot", workspace_id="workspace-1")
    with bind_request(_identity(), store), store.transaction(NOW) as tx:
        project = _project(tx)
        first = persist_discovery(tx, project["id"], _result("19.50"), retention_days=30)
        selected = select_item(
            tx, "analyst", project["id"], first["batch"]["id"], first["items"][0]["id"]
        )

    with bind_request(_identity(), store), store.transaction(NOW + timedelta(hours=1)) as tx:
        second = persist_discovery(tx, project["id"], _result("21.00"), retention_days=30)
        refreshed = select_item(
            tx, "analyst", project["id"], second["batch"]["id"], second["items"][0]["id"]
        )
        evidence = tx.list("evidence", candidate_id=selected["candidate"]["id"])
        assert refreshed["candidate"]["id"] == selected["candidate"]["id"]
        assert refreshed["reused"] is True
        assert len(tx.list("source", candidate_id=selected["candidate"]["id"])) == 2
        assert [item["value"] for item in evidence] == ["19.50", "21.00"]
        assert evidence[1]["supersedes_id"] == evidence[0]["id"]


def test_refresh_preserves_verified_head_and_advances_only_raw_chain(tmp_path: Path) -> None:
    store = Store(tmp_path / "verified.sqlite3", mode="pilot", workspace_id="workspace-1")
    with bind_request(_identity(), store), store.transaction(NOW) as tx:
        project = _project(tx)
        first = persist_discovery(tx, project["id"], _result("19.50"), retention_days=30)
        selected = select_item(
            tx, "analyst", project["id"], first["batch"]["id"], first["items"][0]["id"]
        )
        raw_first = tx.list("evidence", candidate_id=selected["candidate"]["id"])[0]
        verified = tx.add(
            "evidence",
            {
                "field": "price",
                "value": "19.50",
                "unit": "per_item",
                "currency": "USD",
                "window": None,
                "source_locator": "human-check",
                "observed_at": tx.now.isoformat(),
                "valid_until": None,
                "epistemic_kind": "FACT",
                "verification": "VERIFIED",
                "is_demo": False,
                "supersedes_id": raw_first["id"],
                "recorded_by": "analyst",
                "batch_id": raw_first["batch_id"],
                "item_id": raw_first["item_id"],
                "mapping_version": raw_first["mapping_version"],
                "observation_key": raw_first["observation_key"],
                "semantics": "人工核验",
            },
            project_id=project["id"],
            candidate_id=selected["candidate"]["id"],
        )

    raw_refresh_ids: list[str] = []
    for hours, value in ((1, "21.00"), (2, "22.00")):
        with (
            bind_request(_identity(), store),
            store.transaction(NOW + timedelta(hours=hours)) as tx,
        ):
            batch = persist_discovery(tx, project["id"], _result(value), retention_days=30)
            select_item(
                tx, "analyst", project["id"], batch["batch"]["id"], batch["items"][0]["id"]
            )
            raw_refresh_ids.append(
                tx.list("evidence", candidate_id=selected["candidate"]["id"])[-1]["id"]
            )

    with bind_request(_identity(), store), store.transaction(NOW + timedelta(hours=3)) as tx:
        evidence = tx.list("evidence", candidate_id=selected["candidate"]["id"])
        newest = tx.get(raw_refresh_ids[-1], "evidence")
        superseded = {item.get("supersedes_id") for item in evidence}
        assert verified["id"] not in superseded
        assert newest["supersedes_id"] == raw_refresh_ids[0]
        assert newest["verification"] == "UNVERIFIED"
