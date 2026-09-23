"""Deterministic offline market discovery provider for the demo workspace."""

from __future__ import annotations

import json
import unicodedata
from pathlib import Path
from typing import Any, Protocol

from app.selection.contracts import Channel

_FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "demo" / "candidates.json"


class MarketDataProvider(Protocol):
    def discover(self, channel: Channel | str, market: str, direction: str) -> dict[str, Any]: ...


def _normalized_direction(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).strip().casefold().split())


class FixtureMarketDataProvider:
    """Read checked-in samples only; this implementation performs no network I/O."""

    def __init__(self, fixture: Path = _FIXTURE):
        self.fixture = fixture

    def discover(self, channel: Channel | str, market: str, direction: str) -> dict[str, Any]:
        data = json.loads(self.fixture.read_text(encoding="utf-8"))
        aliases = {_normalized_direction(alias) for alias in data["directions"]}
        normalized = _normalized_direction(direction)
        covered = normalized in aliases
        channel_value = channel.value if isinstance(channel, Channel) else str(channel)
        items = data["channels"].get(channel_value, []) if covered else []
        return {
            "coverage": "COVERED" if covered else "NO_SAMPLE_COVERAGE",
            "query": direction,
            "channel": channel_value,
            "market": market,
            "provider": "fixture",
            "provider_version": data["version"],
            "is_demo": True,
            "items": [
                {
                    **item,
                    "channel": channel_value,
                    "market": market,
                    "is_demo": True,
                }
                for item in items
            ],
        }

    def get_item(self, channel: Channel | str, external_id: str) -> dict[str, Any] | None:
        data = json.loads(self.fixture.read_text(encoding="utf-8"))
        channel_value = channel.value if isinstance(channel, Channel) else str(channel)
        for item in data["channels"].get(channel_value, []):
            if item["external_id"] == external_id:
                return dict(item)
        return None
