"""Focused validation for detailed quote and physical-test sourcing records."""

from __future__ import annotations

import socket
from copy import deepcopy

import pytest
from app.api.routes.sourcing import QuotePayload, RecordCommand
from app.sourcing.service import _record_view
from pydantic import ValidationError


def _quote() -> dict[str, object]:
    return {
        "supplier_name": "Offline Trim Factory",
        "supplier_channel": "OFFLINE",
        "supplier_contact": "Ms. Li, confirmed by phone",
        "product_url": None,
        "supplier_sku": "RAV4-2PC",
        "quote_basis": "SUPPLIER_CONFIRMED",
        "amount": "18.50",
        "currency": "USD",
        "price_unit": "set",
        "pieces_per_set": 2,
        "moq": 50,
        "moq_unit": "set",
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
                "amount": "16.25",
                "price_unit": "set",
            },
        ],
        "sample_moq": {"amount": 1, "unit": "set"},
        "stock_moq": {"amount": 20, "unit": "set"},
        "custom_moq": {"amount": 100, "unit": "set"},
        "shared_materials": [
            {"label": "September signed quote", "url": "https://files.example.com/quote.pdf"}
        ],
        "lead_time_days": 21,
        "trade_terms": "FOB Ningbo",
        "tax_shipping_note": "Freight excluded",
        "notes": "Offline supplier input",
    }


def test_detailed_offline_quote_keeps_primary_amount_and_moq() -> None:
    payload = QuotePayload.model_validate(_quote()).model_dump(mode="json")

    assert payload["amount"] == "18.50"
    assert payload["moq"] == 50
    assert payload["price_tiers"][1]["amount"] == "16.25"
    assert payload["sample_moq"] == {"amount": 1, "unit": "set"}
    assert payload["shared_materials"][0]["label"] == "September signed quote"


@pytest.mark.parametrize(
    "tiers",
    [
        [
            {
                "min_quantity": 10,
                "max_quantity": 20,
                "quantity_unit": "set",
                "amount": "2",
                "price_unit": "set",
            },
            {
                "min_quantity": 20,
                "max_quantity": 30,
                "quantity_unit": "set",
                "amount": "1",
                "price_unit": "set",
            },
        ],
        [
            {
                "min_quantity": 10,
                "max_quantity": 9,
                "quantity_unit": "piece",
                "amount": "1",
                "price_unit": "piece",
            }
        ],
        [
            {
                "min_quantity": 1,
                "max_quantity": None,
                "quantity_unit": "piece",
                "amount": "0",
                "price_unit": "piece",
            }
        ],
        [
            {
                "min_quantity": 20,
                "max_quantity": 30,
                "quantity_unit": "piece",
                "amount": "2",
                "price_unit": "piece",
            },
            {
                "min_quantity": 10,
                "max_quantity": 19,
                "quantity_unit": "piece",
                "amount": "3",
                "price_unit": "piece",
            },
        ],
    ],
)
def test_rejects_malformed_price_tiers(tiers: list[dict[str, object]]) -> None:
    data = _quote()
    data["price_tiers"] = tiers
    with pytest.raises(ValidationError):
        QuotePayload.model_validate(data)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("sample_moq", {"amount": 0, "unit": "piece"}),
        ("stock_moq", {"amount": -1, "unit": "piece"}),
        ("custom_moq", {"amount": 2.5, "unit": "piece"}),
    ],
)
def test_rejects_malformed_category_moq(field: str, value: object) -> None:
    data = _quote()
    data[field] = value
    with pytest.raises(ValidationError):
        QuotePayload.model_validate(data)


@pytest.mark.parametrize(
    "material",
    [
        {"label": "local file", "url": "file:///tmp/quote.pdf"},
        {"label": "loopback", "url": "http://127.0.0.1/quote.pdf"},
        {"label": "credentials", "url": "https://user:secret@example.com/quote.pdf"},
        {"label": "unsafe\nlabel", "url": "https://files.example.com/quote.pdf"},
        {"label": "", "url": "https://files.example.com/quote.pdf"},
    ],
)
def test_rejects_unsafe_shared_material_without_network(
    material: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        socket,
        "create_connection",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("no network expected")),
    )
    data = _quote()
    data["shared_materials"] = [material]
    with pytest.raises(ValidationError):
        QuotePayload.model_validate(data)


def _physical_command() -> dict[str, object]:
    return {
        "actor_id": "contributor",
        "expected_version": 1,
        "kind": "FITMENT",
        "source_locator": "shared:fitment-report",
        "observed_at": "2026-09-22T08:00:00Z",
        "verification": "VERIFIED",
        "verification_note": "Checked against photos and signed test sheet",
        "payload": {
            "brand": "Toyota",
            "model": "RAV4",
            "year": "2024",
            "trim": "LE",
            "seat_type": "factory cloth",
            "method": "PHYSICAL_TEST",
            "result": "PASS",
            "sample_ref": "SAMPLE-2026-09-22-A",
            "sample_target_consistent": True,
            "left_front_seat": {"result": "PASS", "details": "Mounts and adjustment clear"},
            "right_front_seat": {"result": "PASS", "details": "Mounts and adjustment clear"},
            "checks": "Both seats checked while parked",
        },
    }


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("payload", "sample_target_consistent"), False),
        (("payload", "left_front_seat"), None),
        (("payload", "left_front_seat", "result"), "FAIL"),
        (("payload", "right_front_seat", "result"), "NOT_TESTED"),
    ],
)
def test_verified_physical_pass_rejects_incomplete_or_failed_sides(
    path: tuple[str, ...], value: object
) -> None:
    data = deepcopy(_physical_command())
    target: dict[str, object] = data
    for key in path[:-1]:
        target = target[key]  # type: ignore[assignment]
    target[path[-1]] = value
    with pytest.raises(ValidationError):
        RecordCommand.model_validate(data)


def test_old_record_view_remains_readable() -> None:
    legacy = {
        "id": "legacy-fitment",
        "record_type": "FITMENT",
        "payload": {
            "method": "PHYSICAL_TEST",
            "result": "PASS",
            "sample_ref": "OLD-SAMPLE",
            "checks": "Legacy free-text check",
        },
    }

    view = _record_view(legacy)
    assert view["kind"] == "FITMENT"
    assert view["payload"]["checks"] == "Legacy free-text check"
    assert "left_front_seat" not in view["payload"]


def test_tier_ranges_cannot_mix_piece_and_set_quantities() -> None:
    payload = _quote()
    payload["price_tiers"][1]["quantity_unit"] = "piece"
    with pytest.raises(ValidationError, match="quantity units must match"):
        QuotePayload.model_validate(payload)
