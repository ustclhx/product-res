"""Bounded HTTP adapters for the pilot market data sources.

The adapters deliberately return plain dictionaries.  Persistence, quota
accounting, and discovery-batch ownership belong to the caller; this module
only performs one bounded upstream request and normalizes its evidence.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app.providers.http import request_with_deadline

MAX_RESULTS = 10
MAX_BODY_BYTES = 2_000_000


class ProviderError(RuntimeError):
    """Safe, typed provider failure; never includes a URL or upstream body."""

    def __init__(self, code: str, message: str, *, status_code: int | None = None):
        self.code = code
        self.status_code = status_code
        super().__init__(message)


@dataclass(frozen=True)
class SecretFile:
    path: Path

    def read(self) -> str:
        try:
            value = self.path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise ProviderError("auth", "provider credentials are unavailable") from exc
        if not value:
            raise ProviderError("auth", "provider credentials are unavailable")
        return value


@dataclass(frozen=True)
class DataForSEOConfig:
    credentials: SecretFile
    timeout_seconds: float = 20.0
    limit: int = MAX_RESULTS


@dataclass(frozen=True)
class SerpApiConfig:
    api_key: SecretFile
    timeout_seconds: float = 20.0
    limit: int = MAX_RESULTS


@dataclass(frozen=True)
class HttpResponse:
    status_code: int
    headers: Mapping[str, str]
    body: bytes


class HttpTransport(Protocol):
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
        max_bytes: int,
    ) -> HttpResponse: ...


class UrllibTransport:
    """Process-isolated urllib transport with one hard request deadline."""

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
        max_bytes: int,
    ) -> HttpResponse:
        try:
            response = request_with_deadline(
                method,
                url,
                headers=headers,
                body=body,
                timeout_seconds=timeout,
                max_response_bytes=max_bytes,
            )
            return HttpResponse(response.status_code, response.headers, response.body)
        except (TimeoutError, OSError) as exc:
            raise ProviderError("unknown", "provider request could not be completed") from exc


def _json_body(response: HttpResponse) -> dict[str, Any]:
    if len(response.body) > MAX_BODY_BYTES:
        raise ProviderError(
            "unknown", "provider response exceeded the size limit", status_code=response.status_code
        )
    try:
        value = json.loads(response.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProviderError(
            "unknown", "provider returned invalid JSON", status_code=response.status_code
        ) from exc
    if not isinstance(value, dict):
        raise ProviderError(
            "unknown", "provider returned an invalid response", status_code=response.status_code
        )
    return value


def _raise_http(status: int) -> None:
    if 300 <= status < 400:
        raise ProviderError(
            "unknown", "provider returned an unexpected redirect", status_code=status
        )
    if status in (401, 403):
        raise ProviderError("auth", "provider authentication was rejected", status_code=status)
    if status in (408, 425, 429):
        raise ProviderError("quota", "provider rate limit or quota was reached", status_code=status)
    if status >= 400:
        raise ProviderError("unknown", "provider request failed", status_code=status)


def _canonical_url(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    parts = urlsplit(value.strip())
    if parts.scheme.casefold() not in {"http", "https"} or not parts.netloc:
        return None
    tracking = {"ref", "tag", "psc", "qid", "sr", "crid", "sprefix", "dib_tag", "dib"}
    query = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if k.casefold() not in tracking
    ]
    return urlunsplit(
        (parts.scheme.casefold(), parts.netloc.casefold(), parts.path or "/", urlencode(query), "")
    )


def _item(
    *,
    provider: str,
    channel: str,
    market: str,
    external_id: Any,
    title: Any,
    source_url: Any,
    observations: list[dict[str, Any]],
    offer_key: Any = None,
    merchant: Any = None,
) -> dict[str, Any] | None:
    url = _canonical_url(source_url)
    raw_id = str(external_id).strip() if external_id not in (None, "") else None
    if url is None or (raw_id is None and url is None):
        return None
    stable = raw_id or url
    offer = str(offer_key).strip() if offer_key not in (None, "") else None
    if not offer:
        offer = (
            f"{merchant.strip()}|{stable}"
            if isinstance(merchant, str) and merchant.strip()
            else stable
        )
    namespace = f"{provider}:{market.casefold()}"
    return {
        "external_id": raw_id or stable,
        "name": str(title).strip() if title not in (None, "") else "Unknown product",
        "source_url": url,
        "stableID": f"{namespace}:{stable}",
        "offerID": f"{namespace}:offer:{offer}",
        "stable_id": f"{namespace}:{stable}",
        "offer_id": f"{namespace}:offer:{offer}",
        "identity_strength": "EXACT" if raw_id else "URL",
        "merchant": merchant,
        "observations": observations,
        "provider": provider,
        "channel": channel,
        "market": market,
        "is_demo": False,
    }


def _obs(
    field: str, value: Any, *, unit: str | None = None, currency: Any = None
) -> dict[str, Any]:
    result: dict[str, Any] = {"field": field, "value": value}
    if unit is not None:
        result["unit"] = unit
    if currency:
        result["currency"] = str(currency).upper()
    return result


class DataForSEOAmazonProvider:
    host = "https://api.dataforseo.com"
    endpoint = host + "/v3/merchant/amazon/products/live/advanced"

    def __init__(self, config: DataForSEOConfig, transport: HttpTransport | None = None):
        self.config = config
        self.transport = transport or UrllibTransport()

    def discover(self, channel: str, market: str, direction: str) -> dict[str, Any]:
        if str(channel).upper() != "AMAZON" or str(market).upper() != "US":
            return self._empty(channel, market, direction, "NO_COVERAGE")
        limit = max(1, min(int(self.config.limit), MAX_RESULTS))
        credential = self.config.credentials.read()
        encoded = base64.b64encode(credential.encode()).decode("ascii")
        payload = [
            {
                "language_code": "en_US",
                "location_code": 2840,
                "keyword": str(direction).strip(),
                "depth": limit,
            }
        ]
        started = time.monotonic()
        response = self.transport.request(
            "POST",
            self.endpoint,
            headers={"Authorization": f"Basic {encoded}", "Content-Type": "application/json"},
            body=json.dumps(payload).encode(),
            timeout=self.config.timeout_seconds,
            max_bytes=MAX_BODY_BYTES,
        )
        latency = round((time.monotonic() - started) * 1000)
        _raise_http(response.status_code)
        document = _json_body(response)
        return self.normalize_response(
            document,
            channel=channel,
            market=market,
            direction=direction,
            raw_response_hash=hashlib.sha256(response.body).hexdigest(),
            latency_ms=latency,
            limit=limit,
        )

    @classmethod
    def normalize_response(
        cls,
        document: dict[str, Any],
        *,
        channel: str,
        market: str,
        direction: str,
        raw_response_hash: str,
        latency_ms: int | None,
        cost: Any = None,
        limit: int = MAX_RESULTS,
    ) -> dict[str, Any]:
        """Normalize an already obtained DataForSEO response without provider I/O."""

        if document.get("status_code") not in (None, 20000):
            status_code = document.get("status_code")
            code = (
                "auth"
                if status_code in (40100, 40300)
                else "quota"
                if status_code in (40200, 40202, 40203, 40204)
                else "unknown"
            )
            raise ProviderError(code, "provider rejected the request")
        tasks = document.get("tasks")
        if not isinstance(tasks, list) or not tasks:
            raise ProviderError("unknown", "provider returned no task result")
        task = tasks[0]
        if not isinstance(task, dict) or task.get("status_code") not in (None, 20000):
            status_code = task.get("status_code") if isinstance(task, dict) else None
            code = (
                "auth"
                if status_code in (40100, 40300)
                else "quota"
                if status_code in (40200, 40202, 40203, 40204)
                else "unknown"
            )
            raise ProviderError(code, "provider task failed")
        results = task.get("result")
        if results is not None and not isinstance(results, list):
            raise ProviderError("unknown", "provider returned malformed task data")
        result = results[0] if results and isinstance(results[0], dict) else {}
        items: list[dict[str, Any]] = []
        bounded_limit = max(1, min(int(limit), MAX_RESULTS))
        for row in (result.get("items") or [])[:bounded_limit]:
            if not isinstance(row, dict):
                continue
            observations: list[dict[str, Any]] = []
            currency = row.get("currency")
            if row.get("price_from") is not None:
                observations.append(_obs("price", row["price_from"], currency=currency))
            if row.get("price_to") is not None:
                observations.append(_obs("price_max", row["price_to"], currency=currency))
            if row.get("bought_past_month") is not None:
                observations.append(
                    _obs("bought_past_month", row["bought_past_month"], unit="label")
                )
            if (
                row.get("rating")
                and isinstance(row["rating"], dict)
                and row["rating"].get("value") is not None
            ):
                observations.append(_obs("rating", row["rating"]["value"], unit="stars"))
            item = _item(
                provider="dataforseo_amazon",
                channel="AMAZON",
                market="US",
                external_id=row.get("data_asin") or row.get("asin"),
                title=row.get("title"),
                source_url=row.get("url"),
                observations=observations,
            )
            if item is not None:
                items.append(item)
        metadata = cls._metadata(
            document,
            task,
            latency_ms,
            raw_response_hash=raw_response_hash,
            cost=cost,
        )
        return {
            "coverage": "COVERED",
            "provider": "dataforseo_amazon",
            "channel": "AMAZON",
            "market": "US",
            "query": direction,
            "items": items,
            "is_demo": False,
            "meta": metadata,
        }

    def _empty(self, channel: str, market: str, query: str, coverage: str) -> dict[str, Any]:
        return {
            "coverage": coverage,
            "provider": "dataforseo_amazon",
            "channel": str(channel),
            "market": str(market),
            "query": query,
            "items": [],
            "is_demo": False,
            "meta": {"item_count": 0},
        }

    @staticmethod
    def _metadata(
        document: dict[str, Any],
        task: dict[str, Any],
        latency: int | None,
        *,
        raw_response_hash: str,
        cost: Any = None,
    ) -> dict[str, Any]:
        return {
            "request_id": task.get("id"),
            "cost": document.get("cost", task.get("cost")) if cost is None else cost,
            "latency_ms": latency,
            "item_count": task.get("result_count", 0),
            "raw_response_hash": raw_response_hash,
            "raw": {
                "status_code": document.get("status_code"),
                "tasks_count": document.get("tasks_count"),
                "tasks_error": document.get("tasks_error"),
            },
        }


class SerpApiGoogleShoppingProvider:
    host = "https://serpapi.com"
    endpoint = host + "/search.json"

    def __init__(self, config: SerpApiConfig, transport: HttpTransport | None = None):
        self.config = config
        self.transport = transport or UrllibTransport()

    def discover(self, channel: str, market: str, direction: str) -> dict[str, Any]:
        if str(channel).upper() != "DTC" or str(market).upper() != "US":
            return {
                "coverage": "NO_COVERAGE",
                "provider": "serpapi_google_shopping",
                "channel": str(channel),
                "market": str(market),
                "query": direction,
                "items": [],
                "is_demo": False,
                "meta": {"item_count": 0},
            }
        key = self.config.api_key.read()
        limit = max(1, min(int(self.config.limit), MAX_RESULTS))
        query = urlencode(
            {
                "engine": "google_shopping",
                "q": str(direction).strip(),
                "gl": "us",
                "hl": "en",
                "num": limit,
                "api_key": key,
            }
        )
        url = self.endpoint + "?" + query
        started = time.monotonic()
        response = self.transport.request(
            "GET",
            url,
            headers={"Accept": "application/json"},
            body=None,
            timeout=self.config.timeout_seconds,
            max_bytes=MAX_BODY_BYTES,
        )
        latency = round((time.monotonic() - started) * 1000)
        _raise_http(response.status_code)
        document = _json_body(response)
        if document.get("error"):
            message = str(document["error"]).casefold()
            raise ProviderError(
                "quota"
                if any(word in message for word in ("quota", "limit", "credit"))
                else "auth"
                if "key" in message or "auth" in message
                else "unknown",
                "provider rejected the request",
            )
        items: list[dict[str, Any]] = []
        for row in (document.get("shopping_results") or [])[:limit]:
            if not isinstance(row, dict):
                continue
            observations: list[dict[str, Any]] = []
            currency = row.get("currency") or row.get("currency_code")
            if row.get("extracted_price") is not None:
                observations.append(_obs("price", row["extracted_price"], currency=currency))
            elif row.get("price") is not None:
                observations.append(_obs("price", row["price"]))
            if row.get("delivery") is not None:
                observations.append(_obs("delivery", row["delivery"], unit="label"))
            for field, unit in (("rating", "stars"), ("reviews", "count")):
                if row.get(field) is not None:
                    observations.append(_obs(field, row[field], unit=unit))
            item = _item(
                provider="serpapi_google_shopping",
                channel="DTC",
                market="US",
                external_id=row.get("product_id"),
                title=row.get("title"),
                source_url=row.get("product_link") or row.get("link"),
                observations=observations,
                offer_key=row.get("offer_id"),
                merchant=row.get("source"),
            )
            if item is not None:
                items.append(item)
        return {
            "coverage": "COVERED",
            "provider": "serpapi_google_shopping",
            "channel": "DTC",
            "market": "US",
            "query": direction,
            "items": items,
            "is_demo": False,
            "meta": {
                "request_id": document.get("search_metadata", {}).get("id"),
                "cost": document.get("cost"),
                "latency_ms": latency,
                "item_count": len(items),
                "raw_response_hash": hashlib.sha256(response.body).hexdigest(),
                "raw": {
                    "search_metadata": {"id": document.get("search_metadata", {}).get("id")},
                    "error": None,
                },
            },
        }
