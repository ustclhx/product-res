"""Sourcing workbench, profile, structured record, and safe link-preview routes."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from ipaddress import ip_address
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.api.contracts import normalize_utc
from app.core import Command, execute
from app.sourcing import build_workbench, create_record, parse_source_link, update_profile

router = APIRouter(tags=["sourcing"])


class ProfileCommand(Command):
    product_type: Literal["OEM", "LISTED", "BENCHMARK"] = "LISTED"
    stage: Literal["RESEARCH", "SAMPLE", "LAUNCH"] = "RESEARCH"
    benchmark_candidate_id: str | None = Field(default=None, min_length=1)
    target_market: str | None = Field(default=None, max_length=128)
    brand: str | None = Field(default=None, max_length=128)
    model: str | None = Field(default=None, max_length=128)
    year: str | None = Field(default=None, max_length=32)
    trim: str | None = Field(default=None, max_length=128)
    seat_type: str | None = Field(default=None, max_length=128)


class _Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class PriceTier(_Payload):
    min_quantity: int = Field(ge=1, strict=True)
    max_quantity: int | None = Field(default=None, ge=1, strict=True)
    quantity_unit: Literal["piece", "set"]
    amount: str = Field(min_length=1, max_length=64, pattern=r"^\d+(?:\.\d+)?$")
    price_unit: Literal["piece", "set"]

    @model_validator(mode="after")
    def valid_range_and_price(self) -> PriceTier:
        _positive_decimal(self.amount)
        if self.max_quantity is not None and self.max_quantity < self.min_quantity:
            raise ValueError("tier max_quantity cannot be below min_quantity")
        return self


class MoqDetail(_Payload):
    amount: int = Field(ge=1, strict=True)
    unit: Literal["piece", "set"]


class SharedMaterial(_Payload):
    label: str = Field(min_length=1, max_length=256)
    url: str = Field(min_length=1, max_length=2048)

    @field_validator("label")
    @classmethod
    def safe_label(cls, value: str) -> str:
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("material label cannot contain control characters")
        return value

    @field_validator("url")
    @classmethod
    def shared_http_url(cls, value: str) -> str:
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("material URL cannot contain control characters")
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("material URL must be an HTTP(S) link")
        try:
            port = parsed.port
        except ValueError as exc:
            raise ValueError("material URL has an invalid port") from exc
        if port is not None and port <= 0:
            raise ValueError("material URL has an invalid port")
        if parsed.username or parsed.password:
            raise ValueError("material URL cannot contain credentials")
        host = parsed.hostname.rstrip(".").casefold()
        if host == "localhost" or host.endswith(".localhost"):
            raise ValueError("material URL cannot point to a local host")
        try:
            address = ip_address(host)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            raise ValueError("material URL cannot point to a local address")
        return value


class FrontSeatCheck(_Payload):
    result: Literal["PASS", "FAIL", "NOT_TESTED"]
    details: str = Field(min_length=1, max_length=2000)


class QuotePayload(_Payload):
    kind: Literal["QUOTE"] = "QUOTE"
    supplier_name: str = Field(min_length=1, max_length=256)
    supplier_channel: Literal["OFFLINE", "1688", "YIWUGO", "ALIBABA", "OTHER"]
    supplier_contact: str | None = Field(default=None, max_length=512)
    product_url: str | None = Field(default=None, max_length=2048)
    supplier_sku: str | None = Field(default=None, max_length=256)
    quote_basis: Literal["PUBLIC_REFERENCE", "SUPPLIER_CONFIRMED"]
    amount: str = Field(min_length=1, max_length=64, pattern=r"^\d+(?:\.\d+)?$")
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    price_unit: Literal["piece", "set"]
    pieces_per_set: int | None = Field(default=None, ge=1, strict=True)
    moq: int = Field(ge=1, strict=True)
    moq_unit: Literal["piece", "set"]
    price_tiers: list[PriceTier] = Field(default_factory=list, max_length=50)
    sample_moq: MoqDetail | None = None
    stock_moq: MoqDetail | None = None
    custom_moq: MoqDetail | None = None
    shared_materials: list[SharedMaterial] = Field(default_factory=list, max_length=20)
    lead_time_days: int | None = Field(default=None, ge=0, strict=True)
    trade_terms: str | None = Field(default=None, max_length=1000)
    tax_shipping_note: str | None = Field(default=None, max_length=2000)
    notes: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="after")
    def validate_units(self) -> QuotePayload:
        _positive_decimal(self.amount)
        if (self.price_unit == "set" or self.moq_unit == "set") and self.pieces_per_set is None:
            raise ValueError("set units require pieces_per_set")
        if (
            any(
                item.unit == "set"
                for item in (self.sample_moq, self.stock_moq, self.custom_moq)
                if item is not None
            )
            and self.pieces_per_set is None
        ):
            raise ValueError("set MOQ details require pieces_per_set")
        if (
            any(
                tier.quantity_unit == "set" or tier.price_unit == "set" for tier in self.price_tiers
            )
            and self.pieces_per_set is None
        ):
            raise ValueError("set price tiers require pieces_per_set")
        previous: PriceTier | None = None
        for tier in self.price_tiers:
            if previous is not None:
                if tier.quantity_unit != previous.quantity_unit:
                    raise ValueError("price tier quantity units must match for comparable ranges")
                if previous.max_quantity is None:
                    raise ValueError("an open-ended price tier must be last")
                if tier.min_quantity <= previous.max_quantity:
                    raise ValueError("price tiers must be ordered and non-overlapping")
            previous = tier
        return self


class FitmentPayload(_Payload):
    kind: Literal["FITMENT"] = "FITMENT"
    brand: str = Field(min_length=1, max_length=128)
    model: str = Field(min_length=1, max_length=128)
    year: str = Field(min_length=1, max_length=32)
    trim: str | None = Field(default=None, max_length=128)
    seat_type: str = Field(min_length=1, max_length=128)
    method: Literal["DESK_REVIEW", "PHYSICAL_TEST"]
    result: Literal["PENDING", "PASS", "FAIL"]
    sample_ref: str | None = Field(default=None, max_length=512)
    sample_target_consistent: bool | None = None
    left_front_seat: FrontSeatCheck | None = None
    right_front_seat: FrontSeatCheck | None = None
    checks: str = Field(min_length=1, max_length=4000)
    notes: str | None = Field(default=None, max_length=4000)


class PricePayload(_Payload):
    kind: Literal["PRICE"] = "PRICE"
    price_basis: Literal["ACTUAL_OFFER", "TARGET_ESTIMATE"]
    amount: str = Field(min_length=1, max_length=64, pattern=r"^\d+(?:\.\d+)?$")
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    price_unit: Literal["piece", "set"]
    pieces_per_set: int | None = Field(default=None, ge=1, strict=True)
    notes: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="after")
    def validate_units(self) -> PricePayload:
        _positive_decimal(self.amount)
        if self.price_unit == "set" and self.pieces_per_set is None:
            raise ValueError("set units require pieces_per_set")
        return self


RecordPayload = Annotated[QuotePayload | FitmentPayload | PricePayload, Field(discriminator="kind")]


def _positive_decimal(value: str) -> str:
    try:
        amount = Decimal(value)
    except Exception as exc:
        raise ValueError("amount must be a positive finite decimal string") from exc
    if not amount.is_finite() or amount <= 0:
        raise ValueError("amount must be a positive finite decimal string")
    return value


class RecordCommand(Command):
    kind: Literal["QUOTE", "FITMENT", "PRICE"]
    source_locator: str = Field(min_length=1, max_length=2048)
    observed_at: datetime
    valid_until: datetime | None = None
    verification: Literal["UNVERIFIED", "VERIFIED"] = "UNVERIFIED"
    verification_note: str | None = Field(default=None, max_length=2000)
    supersedes_record_id: str | None = None
    payload: RecordPayload

    @model_validator(mode="before")
    @classmethod
    def inject_payload_kind(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        kind = value.get("kind")
        payload = value.get("payload")
        if isinstance(payload, dict) and "kind" not in payload and kind is not None:
            return {**value, "payload": {**payload, "kind": kind}}
        return value

    @field_validator("observed_at", "valid_until")
    @classmethod
    def aware(cls, value: datetime | None) -> datetime | None:
        return normalize_utc(value) if value is not None else None

    @model_validator(mode="after")
    def consistent(self) -> RecordCommand:
        if self.kind != self.payload.kind:
            raise ValueError("kind must match payload.kind")
        if self.valid_until is not None and self.valid_until < self.observed_at:
            raise ValueError("valid_until cannot precede observed_at")
        if self.verification == "VERIFIED" and not self.verification_note:
            raise ValueError("verified records require verification_note")
        if (
            isinstance(self.payload, FitmentPayload)
            and self.payload.method == "PHYSICAL_TEST"
            and self.payload.result == "PASS"
            and self.verification == "VERIFIED"
        ):
            if not self.payload.sample_ref:
                raise ValueError("verified physical PASS requires sample_ref")
            if self.payload.sample_target_consistent is not True:
                raise ValueError("verified physical PASS requires a sample matching the target")
            for side in (self.payload.left_front_seat, self.payload.right_front_seat):
                if side is None or side.result != "PASS" or not side.details:
                    raise ValueError(
                        "verified physical PASS requires passing checks for both front seats"
                    )
        return self


@router.get("/candidates/{candidate_id}/sourcing")
def get_sourcing(candidate_id: str, request: Request) -> dict[str, Any]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return build_workbench(tx, candidate_id)


@router.post("/candidates/{candidate_id}/sourcing-profile")
def post_profile(candidate_id: str, command: ProfileCommand, request: Request) -> dict[str, Any]:
    profile = command.model_dump(exclude={"actor_id", "expected_version"}, mode="json")
    return execute(
        request,
        command,
        candidate_id,
        "sourcing.profile.update",
        lambda tx, actor: update_profile(tx, actor, candidate_id, profile),
    )


@router.post("/candidates/{candidate_id}/sourcing-records")
def post_record(candidate_id: str, command: RecordCommand, request: Request) -> dict[str, Any]:
    data = command.model_dump(exclude={"actor_id", "expected_version"}, mode="json")
    return execute(
        request,
        command,
        candidate_id,
        "sourcing.record.create",
        lambda tx, actor: create_record(tx, actor, candidate_id, data),
    )


@router.get("/sourcing/link-preview")
def link_preview(url: str = Query(min_length=1, max_length=2048)) -> dict[str, str]:
    return parse_source_link(url)
