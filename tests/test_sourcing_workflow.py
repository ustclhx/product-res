"""API contract tests for the structured sourcing evidence workbench.

These tests intentionally exercise the HTTP boundary rather than calling the
sourcing service directly.  The fixture uses the same isolated SQLite store
and demo clock as the other API integration tests, so a failed command can be
checked for both its response and its transactional effects.
"""

from __future__ import annotations

import socket
from pathlib import Path
from typing import Any

import pytest
from app.core import DomainError
from app.persistence.store import DEMO_NOW, Store
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient


def _app(store: Store) -> FastAPI:
    # Import lazily so this test file remains independent of the rest of the
    # route package while the sourcing endpoint is developed in parallel.
    from app.api.routes.sourcing import router as sourcing_router

    app = FastAPI()
    app.state.store = store
    app.state.clock = lambda: DEMO_NOW
    app.include_router(sourcing_router, prefix="/api/v1")

    @app.exception_handler(DomainError)
    async def domain_error(_request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content={
                "error_code": exc.code,
                "message": exc.message,
                "details": exc.details,
            },
        )

    return app


def _seed(store: Store) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Create a project with an unchanged formal standard and one candidate."""

    with store.transaction(DEMO_NOW) as tx:
        project = tx.add(
            "project",
            {
                "name": "Sourcing API test",
                "channel": "AMAZON",
                "market": "US",
                "direction": "vehicle accessories",
                "goal": "test structured sourcing",
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
                        "threshold": "100",
                        "unit": "units",
                        "currency": None,
                    }
                ],
                "required_evidence": ["procurement_cost", "moq"],
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
                "title": "OEM seat cover",
                "external_id": "OEM-TEST-1",
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


def _client(
    tmp_path: Path,
) -> tuple[TestClient, Store, dict[str, Any], dict[str, Any], dict[str, Any]]:
    store = Store(tmp_path / "sourcing.sqlite3")
    project, criteria, candidate = _seed(store)
    return TestClient(_app(store)), store, project, criteria, candidate


def _profile(version: int, *, actor_id: str = "analyst", stage: str = "RESEARCH") -> dict[str, Any]:
    return {
        "actor_id": actor_id,
        "expected_version": version,
        "product_type": "OEM",
        "stage": stage,
        "benchmark_candidate_id": None,
        "target_market": "US",
        "brand": "SeatCo",
        "model": "RAV4",
        "year": "2024",
        "trim": "XLE",
        "seat_type": "leather",
    }


def _quote(
    version: int,
    *,
    key: str = "quote-1",
    quote_basis: str = "SUPPLIER_CONFIRMED",
    verification: str = "VERIFIED",
    verification_note: str | None = "Confirmed by supplier invoice and chat on 2026-09-19",
    observed_at: str = "2026-09-19T07:00:00Z",
    valid_until: str | None = "2026-10-19T07:00:00Z",
    supersedes_record_id: str | None = None,
    amount: str = "12.50",
    price_unit: str = "set",
    pieces_per_set: int | None = 4,
    moq: int = 10,
    moq_unit: str = "set",
) -> tuple[str, dict[str, Any]]:
    return key, {
        "actor_id": "contributor",
        "expected_version": version,
        "kind": "QUOTE",
        "source_locator": "offline:supplier-acme/quote-2026-09-19",
        "observed_at": observed_at,
        "valid_until": valid_until,
        "verification": verification,
        "verification_note": verification_note,
        "supersedes_record_id": supersedes_record_id,
        "payload": {
            "kind": "QUOTE",
            "supplier_name": "Acme Trim Factory",
            "supplier_channel": "OFFLINE",
            "supplier_contact": "supplier@example.test",
            "product_url": None,
            "supplier_sku": "ACME-RAV4-SET",
            "quote_basis": quote_basis,
            "amount": amount,
            "currency": "USD",
            "price_unit": price_unit,
            "pieces_per_set": pieces_per_set,
            "moq": moq,
            "moq_unit": moq_unit,
            "lead_time_days": 14,
            "trade_terms": "FOB",
            "tax_shipping_note": "Shipping quoted separately",
            "notes": "Offline supplier confirmation",
        },
    }


def _post_record(
    client: TestClient,
    candidate_id: str,
    version: int,
    body: dict[str, Any],
    key: str,
) -> Any:
    return client.post(
        f"/api/v1/candidates/{candidate_id}/sourcing-records",
        headers={"Idempotency-Key": key},
        json=body,
    )


def _entities(store: Store, kind: str, candidate_id: str) -> list[dict[str, Any]]:
    with store.transaction(DEMO_NOW) as tx:
        return tx.list(kind, candidate_id=candidate_id)


def _error(response: Any, code: str | None = None) -> None:
    assert response.status_code in {400, 403, 409, 422}
    if code is not None:
        assert response.json()["error_code"] == code


def test_offline_confirmed_quote_preserves_set_and_moq_units(tmp_path: Path) -> None:
    client, store, _project, _criteria, candidate = _client(tmp_path)
    version = candidate["version"]

    profile_response = client.post(
        f"/api/v1/candidates/{candidate['id']}/sourcing-profile",
        headers={"Idempotency-Key": "profile-oem"},
        json=_profile(version),
    )
    assert profile_response.status_code == 200
    version = profile_response.json()["candidate"]["version"]

    key, body = _quote(version)
    response = _post_record(client, candidate["id"], version, body, key)
    assert response.status_code == 200
    result = response.json()
    record = result["record"]
    assert record["kind"] == "QUOTE"
    assert record["payload"]["price_unit"] == "set"
    assert record["payload"]["pieces_per_set"] == 4
    assert record["payload"]["moq_unit"] == "set"
    assert record["payload"]["moq"] == 10

    evidence = _entities(store, "evidence", candidate["id"])
    by_field = {item["field"]: item for item in evidence}
    assert by_field["procurement_cost"]["value"] == "12.50"
    assert by_field["procurement_cost"]["verification"] == "VERIFIED"
    assert by_field["procurement_cost"]["unit"] in {"per_set_4pcs", "set_4pcs"}
    assert by_field["moq"]["value"] == "10"
    assert by_field["moq"]["unit"] in {"set", "set_4pcs"}
    assert by_field["procurement_cost"]["sourcing_record_id"] == record["id"]
    assert by_field["moq"]["sourcing_record_id"] == record["id"]

    workbench = client.get(f"/api/v1/candidates/{candidate['id']}/sourcing")
    assert workbench.status_code == 200
    assert workbench.json()["tasks"] == []  # saving evidence does not create/complete tasks


def test_quote_details_do_not_promote_lowest_tier_or_category_moq(tmp_path: Path) -> None:
    client, store, _project, _criteria, candidate = _client(tmp_path)
    key, body = _quote(candidate["version"], amount="18.50", moq=50)
    body["payload"].update(
        {
            "price_tiers": [
                {
                    "min_quantity": 50,
                    "max_quantity": 99,
                    "quantity_unit": "set",
                    "amount": "18.50",
                    "price_unit": "set",
                },
                {
                    "min_quantity": 100,
                    "max_quantity": None,
                    "quantity_unit": "set",
                    "amount": "15.00",
                    "price_unit": "set",
                },
            ],
            "sample_moq": {"amount": 1, "unit": "set"},
            "stock_moq": {"amount": 20, "unit": "set"},
            "custom_moq": {"amount": 100, "unit": "set"},
            "shared_materials": [
                {
                    "label": "Signed September quote",
                    "url": "https://files.example.test/signed-quote.pdf",
                }
            ],
        }
    )

    response = _post_record(client, candidate["id"], candidate["version"], body, key)
    assert response.status_code == 200
    payload = response.json()["record"]["payload"]
    assert payload["price_tiers"][1]["amount"] == "15.00"
    assert payload["sample_moq"] == {"amount": 1, "unit": "set"}
    assert payload["shared_materials"][0]["label"] == "Signed September quote"

    fields = {item["field"]: item for item in _entities(store, "evidence", candidate["id"])}
    assert fields["procurement_cost"]["value"] == "18.50"
    assert fields["moq"]["value"] == "50"


def test_public_reference_never_becomes_canonical_cost(tmp_path: Path) -> None:
    client, store, _project, _criteria, candidate = _client(tmp_path)
    key, body = _quote(candidate["version"], key="public-reference", quote_basis="PUBLIC_REFERENCE")
    response = _post_record(client, candidate["id"], candidate["version"], body, key)
    assert response.status_code == 200

    evidence = _entities(store, "evidence", candidate["id"])
    fields = {item["field"]: item for item in evidence}
    assert "procurement_cost" not in fields
    assert fields["procurement_reference_price"]["value"] == "12.50"
    assert fields["procurement_reference_price"]["verification"] == "UNVERIFIED"
    assert fields["moq_reference"]["value"] == "10"
    assert fields["moq_reference"]["verification"] == "UNVERIFIED"

    # A later supplier-confirmed quote has its own canonical fields.  A
    # differing public reference must not make the formal quote conflict.
    version = response.json()["candidate"]["version"]
    profile_response = client.post(
        f"/api/v1/candidates/{candidate['id']}/sourcing-profile",
        headers={"Idempotency-Key": "public-reference-profile"},
        json=_profile(version),
    )
    assert profile_response.status_code == 200
    version = profile_response.json()["candidate"]["version"]
    key, formal = _quote(
        version,
        key="formal-after-reference",
        amount="9.00",
        quote_basis="SUPPLIER_CONFIRMED",
    )
    response = _post_record(client, candidate["id"], version, formal, key)
    assert response.status_code == 200
    requirements = client.get(f"/api/v1/candidates/{candidate['id']}/sourcing").json()[
        "requirements"
    ]
    by_field = {item["field"]: item for item in requirements}
    assert by_field["procurement_reference_price"]["status"] == "READY"
    assert by_field["procurement_cost"]["status"] == "READY"
    assert by_field["procurement_cost"]["status"] != "CONFLICT"


def test_target_estimate_and_desk_review_do_not_claim_actuals_or_fitment(tmp_path: Path) -> None:
    client, store, _project, _criteria, candidate = _client(tmp_path)
    price = {
        "actor_id": "contributor",
        "expected_version": candidate["version"],
        "kind": "PRICE",
        "source_locator": "fixture:target-estimate",
        "observed_at": "2026-09-19T07:00:00Z",
        "valid_until": None,
        "verification": "UNVERIFIED",
        "verification_note": None,
        "supersedes_record_id": None,
        "payload": {
            "kind": "PRICE",
            "price_basis": "TARGET_ESTIMATE",
            "amount": "29.00",
            "currency": "USD",
            "price_unit": "piece",
            "pieces_per_set": None,
            "notes": "Planning target only",
        },
    }
    result = _post_record(client, candidate["id"], candidate["version"], price, "target-price")
    assert result.status_code == 200
    version = result.json()["candidate"]["version"]
    actual = {
        **price,
        "expected_version": version,
        "verification": "VERIFIED",
        "verification_note": "Matched signed supplier offer",
        "payload": {
            **price["payload"],
            "price_basis": "ACTUAL_OFFER",
            "amount": "31.00",
        },
    }
    result = _post_record(client, candidate["id"], version, actual, "actual-price")
    assert result.status_code == 200
    actual_record = result.json()["record"]
    version = result.json()["candidate"]["version"]
    revised_target = {
        **actual,
        "expected_version": version,
        "source_locator": "fixture:revised-target-estimate",
        "verification": "UNVERIFIED",
        "verification_note": None,
        "supersedes_record_id": actual_record["id"],
        "payload": {
            **actual["payload"],
            "price_basis": "TARGET_ESTIMATE",
            "amount": "27.50",
        },
    }
    result = _post_record(client, candidate["id"], version, revised_target, "revised-target")
    assert result.status_code == 200
    version = result.json()["candidate"]["version"]
    fitment = {
        "actor_id": "contributor",
        "expected_version": version,
        "kind": "FITMENT",
        "source_locator": "fixture:desk-review",
        "observed_at": "2026-09-19T07:00:00Z",
        "valid_until": None,
        "verification": "VERIFIED",
        "verification_note": "Compared against manufacturer dimensions",
        "supersedes_record_id": None,
        "payload": {
            "kind": "FITMENT",
            "brand": "Toyota",
            "model": "RAV4",
            "year": "2024",
            "trim": "XLE",
            "seat_type": "leather",
            "method": "DESK_REVIEW",
            "result": "PASS",
            "sample_ref": None,
            "checks": "Dimensions and seat anchors reviewed",
            "notes": None,
        },
    }
    result = _post_record(client, candidate["id"], version, fitment, "desk-fitment")
    assert result.status_code == 200
    version = result.json()["candidate"]["version"]
    physical = {
        **fitment,
        "expected_version": version,
        "source_locator": "fixture:physical-fitment",
        "payload": {
            **fitment["payload"],
            "method": "PHYSICAL_TEST",
            "sample_ref": "sample-rav4-xle-001",
            "sample_target_consistent": True,
            "left_front_seat": {"result": "PASS", "details": "Secure and unobstructed"},
            "right_front_seat": {"result": "PASS", "details": "Secure and unobstructed"},
        },
    }
    result = _post_record(client, candidate["id"], version, physical, "physical-fitment")
    assert result.status_code == 200

    evidence = _entities(store, "evidence", candidate["id"])
    fields = {item["field"]: item for item in evidence}
    assert fields["target_price"]["value"] == "27.50"
    assert fields["target_price"]["epistemic_kind"] == "ESTIMATE"
    # The old canonical field remains as an explicit tombstone for audit
    # history, but cannot stay eligible after the basis-changing replacement.
    assert fields["price"]["value"] is None
    assert fields["price"]["verification"] == "UNVERIFIED"
    assert fields["fitment_desk_review"]["verification"] == "VERIFIED"
    assert fields["vehicle_fitment"]["value"] == "PASS"
    assert fields["fitment_desk_review"]["field"] != fields["vehicle_fitment"]["field"]


def test_verified_records_require_observed_time_and_proof_and_rollback(tmp_path: Path) -> None:
    client, store, _project, _criteria, candidate = _client(tmp_path)
    key, missing_note = _quote(candidate["version"], key="missing-proof", verification_note=None)
    response = _post_record(client, candidate["id"], candidate["version"], missing_note, key)
    _error(response)
    assert _entities(store, "sourcing_record", candidate["id"]) == []
    assert _entities(store, "evidence", candidate["id"]) == []

    key, missing_observed = _quote(candidate["version"], key="missing-observed")
    del missing_observed["observed_at"]
    response = _post_record(client, candidate["id"], candidate["version"], missing_observed, key)
    _error(response)
    assert _entities(store, "sourcing_record", candidate["id"]) == []

    key, invalid_number = _quote(candidate["version"], key="nan-amount", amount="NaN")
    response = _post_record(client, candidate["id"], candidate["version"], invalid_number, key)
    _error(response)
    assert _entities(store, "sourcing_record", candidate["id"]) == []


def test_idempotency_and_explicit_replacement_keep_history(tmp_path: Path) -> None:
    client, store, _project, _criteria, candidate = _client(tmp_path)
    key, first = _quote(candidate["version"], key="same-key")
    response = _post_record(client, candidate["id"], candidate["version"], first, key)
    assert response.status_code == 200
    first_record = response.json()["record"]
    version = response.json()["candidate"]["version"]

    replay = _post_record(client, candidate["id"], candidate["version"], first, key)
    assert replay.status_code == 200
    assert replay.json()["record"]["id"] == first_record["id"]
    assert len(_entities(store, "sourcing_record", candidate["id"])) == 1

    _key, conflicting_payload = _quote(version, key="same-key", amount="13.00")
    conflict = _post_record(client, candidate["id"], version, conflicting_payload, key)
    _error(conflict, "IDEMPOTENCY_CONFLICT")

    replacement_key, replacement = _quote(
        version,
        key="replacement",
        amount="13.00",
        supersedes_record_id=first_record["id"],
    )
    replaced = _post_record(client, candidate["id"], version, replacement, replacement_key)
    assert replaced.status_code == 200
    replacement_record = replaced.json()["record"]
    assert replacement_record["supersedes_record_id"] == first_record["id"]
    assert len(_entities(store, "sourcing_record", candidate["id"])) == 2

    stale_key, stale = _quote(
        replaced.json()["candidate"]["version"],
        key="stale-replacement",
        supersedes_record_id=first_record["id"],
    )
    stale_response = _post_record(
        client, candidate["id"], replaced.json()["candidate"]["version"], stale, stale_key
    )
    _error(stale_response, "SOURCING_REVISION_STALE")
    assert len(_entities(store, "sourcing_record", candidate["id"])) == 2


def test_profile_is_analyst_only_and_does_not_change_formal_criteria(tmp_path: Path) -> None:
    client, store, project, criteria, candidate = _client(tmp_path)
    denied = client.post(
        f"/api/v1/candidates/{candidate['id']}/sourcing-profile",
        headers={"Idempotency-Key": "profile-contributor"},
        json=_profile(candidate["version"], actor_id="contributor"),
    )
    _error(denied, "ROLE_NOT_ALLOWED")

    response = client.post(
        f"/api/v1/candidates/{candidate['id']}/sourcing-profile",
        headers={"Idempotency-Key": "profile-analyst"},
        json=_profile(candidate["version"], stage="RESEARCH"),
    )
    assert response.status_code == 200
    assert response.json()["profile"]["product_type"] == "OEM"
    assert response.json()["profile"]["stage"] == "RESEARCH"
    with store.transaction(DEMO_NOW) as tx:
        current_project = tx.get(project["id"], "project")
        current_criteria = tx.get(criteria["id"], "criteria")
    assert current_project["current_criteria_id"] == criteria["id"]
    assert current_criteria["version"] == criteria["version"]
    assert current_criteria["required_evidence"] == ["procurement_cost", "moq"]


def test_requirements_reflect_expired_and_conflicting_live_records(tmp_path: Path) -> None:
    client, _store, _project, _criteria, candidate = _client(tmp_path)
    key, expired = _quote(
        candidate["version"],
        key="expired-quote",
        observed_at="2026-09-18T07:00:00Z",
        valid_until="2026-09-19T07:00:00Z",
    )
    response = _post_record(client, candidate["id"], candidate["version"], expired, key)
    assert response.status_code == 200
    workbench = client.get(f"/api/v1/candidates/{candidate['id']}/sourcing")
    assert workbench.status_code == 200
    requirements = workbench.json()["requirements"]
    assert any(item["status"] == "EXPIRED" for item in requirements)

    version = response.json()["candidate"]["version"]
    _key, second = _quote(
        version,
        key="current-quote",
        amount="13.00",
        verification="UNVERIFIED",
        verification_note=None,
    )
    response = _post_record(client, candidate["id"], version, second, "current-quote")
    assert response.status_code == 200

    workbench = client.get(f"/api/v1/candidates/{candidate['id']}/sourcing")
    assert workbench.status_code == 200
    requirements = workbench.json()["requirements"]
    statuses = {item["field"]: item["status"] for item in requirements}
    assert statuses["procurement_cost"] == "CONFLICT"


def test_link_preview_is_allowlisted_and_never_fetches_remote_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _store, _project, _criteria, _candidate = _client(tmp_path)
    calls: list[Any] = []

    def no_network(*args: Any, **kwargs: Any) -> None:
        calls.append((args, kwargs))
        raise AssertionError("link preview must not perform network I/O")

    monkeypatch.setattr(socket, "create_connection", no_network)
    supported = client.get(
        "/api/v1/sourcing/link-preview",
        params={"url": "https://detail.1688.com/offer/123456789012.html"},
    )
    assert supported.status_code == 200
    payload = supported.json()
    assert payload["platform"] == "1688"
    assert payload["product_id"] == "123456789012"
    assert payload["connector_status"] == "AUTHORIZATION_REQUIRED"
    assert "title" not in payload or payload["title"] is None
    assert "price" not in payload or payload["price"] is None
    assert calls == []

    for url in (
        "http://127.0.0.1:9/secret",
        "https://evil.example/offer/123456789012.html",
        "javascript:alert(1)",
    ):
        rejected = client.get("/api/v1/sourcing/link-preview", params={"url": url})
        _error(rejected)
    assert calls == []


def test_vehicle_scope_change_withdraws_fitment_and_rejects_wrong_target(tmp_path: Path) -> None:
    client, store, _project, _criteria, candidate = _client(tmp_path)
    profile = client.post(
        f"/api/v1/candidates/{candidate['id']}/sourcing-profile",
        headers={"Idempotency-Key": "vehicle-profile"},
        json=_profile(candidate["version"]),
    ).json()
    body = {
        "actor_id": "contributor",
        "expected_version": profile["candidate"]["version"],
        "kind": "FITMENT",
        "source_locator": "fixture:physical-sample-1",
        "observed_at": "2026-09-19T07:00:00Z",
        "verification": "VERIFIED",
        "verification_note": "Tested sample on the stated vehicle and seats",
        "payload": {
            "brand": "SeatCo",
            "model": "Other model",
            "year": "2024",
            "trim": "XLE",
            "seat_type": "leather",
            "method": "PHYSICAL_TEST",
            "result": "PASS",
            "sample_ref": "TEST-SAMPLE-1",
            "sample_target_consistent": True,
            "left_front_seat": {"result": "PASS", "details": "Driver seat checks passed"},
            "right_front_seat": {"result": "PASS", "details": "Passenger checks passed"},
            "checks": "Fit and safety clearances",
        },
    }
    response = _post_record(client, candidate["id"], body["expected_version"], body, "wrong-target")
    assert response.status_code == 422
    body["payload"]["model"] = "RAV4"
    response = _post_record(client, candidate["id"], body["expected_version"], body, "right-target")
    assert response.status_code == 200
    fitment_id = response.json()["evidence"][0]["id"]
    next_profile = _profile(response.json()["candidate"]["version"])
    next_profile["seat_type"] = "cloth"
    response = client.post(
        f"/api/v1/candidates/{candidate['id']}/sourcing-profile",
        headers={"Idempotency-Key": "changed-seats"},
        json=next_profile,
    )
    assert response.status_code == 200
    with store.transaction(DEMO_NOW) as tx:
        from app.evidence.screening import current_evidence

        current = current_evidence(tx.list("evidence", candidate_id=candidate["id"]))
        fitment = next(item for item in current if item["field"] == "vehicle_fitment")
        assert fitment["value"] is None
        assert fitment["supersedes_id"] == fitment_id


def test_oem_reference_task_can_finish_without_promoting_reference_to_fact(tmp_path: Path) -> None:
    from app.validation.service import create_task, transition_task

    client, store, _project, _criteria, candidate = _client(tmp_path)
    profile = client.post(
        f"/api/v1/candidates/{candidate['id']}/sourcing-profile",
        headers={"Idempotency-Key": "reference-profile"},
        json=_profile(candidate["version"]),
    ).json()
    key, body = _quote(profile["candidate"]["version"], quote_basis="PUBLIC_REFERENCE")
    response = _post_record(client, candidate["id"], body["expected_version"], body, key)
    assert response.status_code == 200
    reference = next(
        item
        for item in response.json()["evidence"]
        if item["field"] == "procurement_reference_price"
    )
    with store.transaction(DEMO_NOW) as tx:
        from datetime import timedelta

        task = create_task(
            tx,
            "analyst",
            candidate["id"],
            task_type="EVIDENCE",
            question="Collect supplier reference",
            owner_id="contributor",
            due_at=DEMO_NOW + timedelta(days=1),
            completion_criteria="Source with price basis",
            field="procurement_reference_price",
        )
        transition_task(tx, "contributor", task["id"], state="IN_PROGRESS")
        finished = transition_task(
            tx,
            "contributor",
            task["id"],
            state="DONE",
            result="Reference recorded",
            evidence_ids=[reference["id"]],
            target_met=True,
        )
        assert finished["completion_basis"] == "RESEARCH_MATERIAL_ONLY"
        assert tx.get(reference["id"])["verification"] == "UNVERIFIED"
        assert not any(
            item["field"] == "procurement_cost"
            for item in tx.list("evidence", candidate_id=candidate["id"])
        )
