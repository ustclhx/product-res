"""Stable business values, intentionally independent of technical RunState."""

from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.api.contracts import normalize_utc


class Channel(StrEnum):
    AMAZON = "AMAZON"
    EBAY = "EBAY"
    DTC = "DTC"


class CandidateStatus(StrEnum):
    PREPARING = "PREPARING"
    IN_REVIEW = "IN_REVIEW"
    RETURNED = "RETURNED"
    VALIDATING = "VALIDATING"
    WATCHING = "WATCHING"
    REJECTED = "REJECTED"
    OUTCOME_PENDING = "OUTCOME_PENDING"
    REVIEWED = "REVIEWED"


class ScreeningStatus(StrEnum):
    UNCHECKED = "UNCHECKED"
    PASS = "PASS"
    NEEDS_EVIDENCE = "NEEDS_EVIDENCE"
    EXCLUDED = "EXCLUDED"
    OVERRIDDEN = "OVERRIDDEN"


class Money(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amount: Decimal = Field(allow_inf_nan=False)
    currency: str = Field(pattern=r"^[A-Z]{3}$")


class Window(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: datetime
    end: datetime

    @field_validator("start", "end")
    @classmethod
    def aware(cls, value: datetime) -> datetime:
        return normalize_utc(value)

    @model_validator(mode="after")
    def ordered(self) -> "Window":
        if self.end <= self.start:
            raise ValueError("观察窗口结束时间必须晚于开始时间")
        return self


class Repository(Protocol):
    def get(self, entity_id: str, kind: str | None = None) -> dict[str, Any]: ...
    def list(
        self, kind: str, *, project_id: str | None = None, candidate_id: str | None = None
    ) -> list[dict[str, Any]]: ...
