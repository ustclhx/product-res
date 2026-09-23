from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from app.pilot.jobs import ExternalJobError
from app.pilot.services import PilotServices


def _job(provider: str) -> dict[str, Any]:
    return {
        "input_snapshot": {
            "provider": provider,
            "workspace_id": "workspace",
            "channel": "AMAZON" if provider == "dataforseo" else "DTC",
            "market": "US",
            "query": "camping lamp",
        }
    }


def _services(tmp_path: Path, provider: str, **overrides: Any) -> PilotServices:
    secret = tmp_path / f"{provider}.secret"
    secret.write_text("secret", encoding="utf-8")
    config: dict[str, Any] = {
        "secret_file": str(secret),
        "licensed": True,
        "request_limit": 1,
        "retention_days": 30,
        **overrides,
    }
    return PilotServices({"workspaces": {"workspace": {provider: config}}})


@pytest.mark.parametrize("provider", ["dataforseo", "serpapi"])
def test_market_timeout_is_passed_to_both_providers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, provider: str
) -> None:
    captured: list[float] = []

    class FakeProvider:
        def __init__(self, config: Any) -> None:
            captured.append(config.timeout_seconds)

        def discover(self, channel: str, market: str, query: str) -> dict[str, Any]:
            return {"provider": provider, "items": []}

    target = (
        "app.pilot.services.DataForSEOAmazonProvider"
        if provider == "dataforseo"
        else "app.pilot.services.SerpApiGoogleShoppingProvider"
    )
    monkeypatch.setattr(target, FakeProvider)

    result = _services(tmp_path, provider, timeout_seconds=45).runner(_job(provider))

    assert captured == [45.0]
    assert result["provider"] == provider


@pytest.mark.parametrize("provider", ["dataforseo", "serpapi"])
def test_market_timeout_defaults_to_thirty_seconds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, provider: str
) -> None:
    captured: list[float] = []

    class FakeProvider:
        def __init__(self, config: Any) -> None:
            captured.append(config.timeout_seconds)

        def discover(self, channel: str, market: str, query: str) -> dict[str, Any]:
            return {"provider": provider, "items": []}

    target = (
        "app.pilot.services.DataForSEOAmazonProvider"
        if provider == "dataforseo"
        else "app.pilot.services.SerpApiGoogleShoppingProvider"
    )
    monkeypatch.setattr(target, FakeProvider)

    _services(tmp_path, provider).runner(_job(provider))

    assert captured == [30.0]


@pytest.mark.parametrize(
    "value", [0, 121, 10**1000, float("nan"), float("inf"), -float("inf"), "30", True]
)
def test_invalid_market_timeout_is_rejected_before_provider_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: Any
) -> None:
    called = False

    class UnexpectedProviderCall:
        def __init__(self, config: Any) -> None:
            nonlocal called
            called = True

    monkeypatch.setattr("app.pilot.services.DataForSEOAmazonProvider", UnexpectedProviderCall)
    service = _services(tmp_path, "dataforseo", timeout_seconds=value)

    with pytest.raises(ExternalJobError, match="来源超时配置无效") as error:
        service.runner(_job("dataforseo"))

    assert error.value.code == "PROVIDER_CONFIG_INVALID"
    assert error.value.confirmed_not_sent is True
    assert called is False
