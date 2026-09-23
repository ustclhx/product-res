"""Strict transport contracts shared by the versioned HTTP API.

The APIModel, UTCModel, and UTC normalization approach is adapted from
``d2market.app.api.contracts`` (source project, inspected 2026-09-20).  This
scaffold intentionally keeps only the dependency-free boundary primitives;
pagination, cursors, and domain contracts remain future work.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, get_args, get_origin

from pydantic import BaseModel, ConfigDict, field_serializer, model_validator


def normalize_utc(value: datetime) -> datetime:
    """Reject naive datetimes and normalize aware values to UTC."""

    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("datetime must include an explicit UTC offset")
    return value.astimezone(UTC)


def _parse_datetime(value: Any) -> Any:
    if isinstance(value, str):
        candidate = value.strip()
        if candidate.endswith(("Z", "z")):
            candidate = candidate[:-1] + "+00:00"
        try:
            return datetime.fromisoformat(candidate)
        except ValueError:
            return value
    return value


def _coerce_transport_value(value: Any, annotation: Any) -> Any:
    origin = get_origin(annotation)
    args = get_args(annotation)
    if annotation is datetime:
        return _parse_datetime(value)
    if origin in (list, tuple, set, frozenset) and args and isinstance(value, (list, tuple)):
        return type(value)(_coerce_transport_value(item, args[0]) for item in value)
    if origin is not None and args and type(None) in args:
        for candidate in args:
            if candidate is not type(None):
                coerced = _coerce_transport_value(value, candidate)
                if coerced is not value:
                    return coerced
    return value


def _normalize_nested(value: Any) -> Any:
    if isinstance(value, datetime):
        return normalize_utc(value)
    if isinstance(value, list):
        return [_normalize_nested(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_normalize_nested(item) for item in value)
    if isinstance(value, dict):
        return {key: _normalize_nested(item) for key, item in value.items()}
    return value


def _utc_json(value: Any) -> Any:
    if isinstance(value, datetime):
        return normalize_utc(value).isoformat().replace("+00:00", "Z")
    if isinstance(value, list):
        return [_utc_json(item) for item in value]
    if isinstance(value, tuple):
        return [_utc_json(item) for item in value]
    if isinstance(value, dict):
        return {key: _utc_json(item) for key, item in value.items()}
    return value


class APIModel(BaseModel):
    """Strict JSON model used at the HTTP boundary."""

    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


class UTCModel(APIModel):
    """Strict model with explicit-offset datetime validation and UTC output."""

    @model_validator(mode="before")
    @classmethod
    def _parse_iso_datetime_values(cls, value: Any) -> Any:
        if not isinstance(value, Mapping):
            return value
        fields = cls.model_fields
        return {
            key: _coerce_transport_value(item, fields[key].annotation) if key in fields else item
            for key, item in value.items()
        }

    @model_validator(mode="after")
    def _normalize_datetimes(self) -> UTCModel:
        for name, value in self.__dict__.items():
            if isinstance(value, datetime):
                object.__setattr__(self, name, normalize_utc(value))
            else:
                object.__setattr__(self, name, _normalize_nested(value))
        return self

    @field_serializer("*", when_used="json")
    def _serialize_utc(self, value: Any) -> Any:
        return _utc_json(value)
