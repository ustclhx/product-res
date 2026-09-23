from app.main import create_app
from fastapi.testclient import TestClient


def test_health_is_demo_service_contract() -> None:
    response = TestClient(create_app()).get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "product-res", "mode": "demo"}
