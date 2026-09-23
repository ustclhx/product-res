from datetime import UTC, datetime

import pytest
from app.api.contracts import APIModel, UTCModel, normalize_utc
from pydantic import ValidationError


class StrictPayload(APIModel):
    value: int


class TimestampPayload(UTCModel):
    observed_at: datetime


def test_api_model_forbids_extra_and_coercion() -> None:
    with pytest.raises(ValidationError):
        StrictPayload(value="3")
    with pytest.raises(ValidationError):
        StrictPayload(value=3, extra=True)


def test_utc_model_normalizes_and_serializes_zulu_time() -> None:
    payload = TimestampPayload(observed_at="2026-09-20T12:00:00+08:00")

    assert payload.observed_at == datetime(2026, 9, 20, 4, tzinfo=UTC)
    assert payload.model_dump(mode="json") == {"observed_at": "2026-09-20T04:00:00Z"}


def test_normalize_utc_rejects_naive_datetime() -> None:
    with pytest.raises(ValueError, match="explicit UTC offset"):
        normalize_utc(datetime(2026, 9, 20))
