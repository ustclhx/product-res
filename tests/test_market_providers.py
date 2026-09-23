import json
from pathlib import Path

import pytest
from app.providers.market import (
    DataForSEOAmazonProvider,
    DataForSEOConfig,
    HttpResponse,
    ProviderError,
    SecretFile,
    SerpApiConfig,
    SerpApiGoogleShoppingProvider,
)


class FakeTransport:
    def __init__(self, body: dict, status: int = 200):
        self.body = body
        self.status = status
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return HttpResponse(self.status, {}, json.dumps(self.body).encode())


def secret(tmp_path: Path, value: str) -> SecretFile:
    path = tmp_path / "secret"
    path.write_text(value, encoding="utf-8")
    return SecretFile(path)


def test_amazon_normalizes_and_bounds_results(tmp_path):
    transport = FakeTransport(
        {
            "status_code": 20000,
            "tasks": [
                {
                    "id": "req-1",
                    "status_code": 20000,
                    "cost": 0.01,
                    "result_count": 1,
                    "result": [
                        {
                            "items": [
                                {
                                    "data_asin": "A1",
                                    "title": "Thing",
                                    "url": "https://www.amazon.com/dp/A1?tag=secret",
                                    "price_from": 12.5,
                                    "currency": "USD",
                                    "delivery_info": {},
                                }
                            ]
                        }
                    ],
                }
            ],
        }
    )
    provider = DataForSEOAmazonProvider(
        DataForSEOConfig(secret(tmp_path, "login:password")), transport
    )
    result = provider.discover("AMAZON", "US", "thing")
    assert result["is_demo"] is False
    assert result["items"][0]["external_id"] == "A1"
    assert result["items"][0]["source_url"] == "https://www.amazon.com/dp/A1"
    assert result["items"][0]["observations"][0]["currency"] == "USD"
    assert "password" not in json.dumps(result)
    assert '"depth": 10' in transport.calls[0][2]["body"].decode()


def test_serpapi_preserves_multiple_merchant_offers_and_unknown_delivery(tmp_path):
    transport = FakeTransport(
        {
            "search_metadata": {"id": "s1"},
            "shopping_results": [
                {
                    "product_id": "P1",
                    "title": "Thing",
                    "product_link": "https://www.google.com/shopping/product/P1",
                    "source": "Shop A",
                    "extracted_price": 10,
                },
                {
                    "product_id": "P1",
                    "title": "Thing",
                    "product_link": "https://www.google.com/shopping/product/P1",
                    "source": "Shop B",
                    "extracted_price": 12,
                    "delivery": "Free",
                },
            ],
        }
    )
    provider = SerpApiGoogleShoppingProvider(
        SerpApiConfig(secret(tmp_path, "api-secret")), transport
    )
    result = provider.discover("DTC", "US", "thing")
    assert len(result["items"]) == 2
    assert result["items"][0]["offerID"] != result["items"][1]["offerID"]
    assert all(obs["field"] != "delivery" for obs in result["items"][0]["observations"])
    assert "api-secret" not in json.dumps(result)
    assert "api_key=api-secret" in transport.calls[0][1]


@pytest.mark.parametrize("status,code", [(401, "auth"), (429, "quota"), (500, "unknown")])
def test_http_failures_are_classified_and_redacted(tmp_path, status, code):
    transport = FakeTransport({"message": "secret body"}, status)
    provider = SerpApiGoogleShoppingProvider(SerpApiConfig(secret(tmp_path, "secret")), transport)
    with pytest.raises(ProviderError) as caught:
        provider.discover("DTC", "US", "thing")
    assert caught.value.code == code
    assert "secret" not in str(caught.value)


def test_empty_and_unsupported_are_distinct(tmp_path):
    provider = SerpApiGoogleShoppingProvider(
        SerpApiConfig(secret(tmp_path, "secret")), FakeTransport({"shopping_results": []})
    )
    assert provider.discover("DTC", "US", "none")["coverage"] == "COVERED"
    assert provider.discover("DTC", "CA", "none")["coverage"] == "NO_COVERAGE"
    assert provider.discover("AMAZON", "US", "none")["coverage"] == "NO_COVERAGE"


def test_missing_identity_or_invalid_url_is_skipped_and_currency_stays_unknown(tmp_path):
    transport = FakeTransport(
        {
            "shopping_results": [
                {"title": "no id", "product_link": "javascript:alert(1)", "extracted_price": 2},
                {"title": "no url", "product_id": "P2", "extracted_price": 3},
                {
                    "title": "valid",
                    "product_id": "P3",
                    "product_link": "https://example.test/p3",
                    "extracted_price": 4,
                },
            ]
        }
    )
    provider = SerpApiGoogleShoppingProvider(SerpApiConfig(secret(tmp_path, "secret")), transport)
    result = provider.discover("DTC", "US", "thing")
    assert [item["external_id"] for item in result["items"]] == ["P3"]
    assert "currency" not in result["items"][0]["observations"][0]
    assert result["items"][0]["identity_strength"] == "EXACT"
