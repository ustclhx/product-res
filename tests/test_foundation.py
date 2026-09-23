import sqlite3
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from app.core import Command, DomainError, execute
from app.persistence.store import DEMO_NOW, Store
from app.selection.contracts import CandidateStatus, Money, Window
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from pydantic import ValidationError


def test_boundary_values() -> None:
    with pytest.raises(ValidationError):
        Money(amount="12")
    with pytest.raises(ValidationError):
        Window(start=datetime(2026, 1, 1), end=datetime(2026, 2, 1))
    with pytest.raises(ValueError):
        CandidateStatus("RUNNING")


def test_store_restarts_foreign_keys_and_immutability(tmp_path: Path) -> None:
    path = tmp_path / "demo.db"
    store = Store(path)
    with store.transaction() as tx:
        project = tx.add("project", {"name": "one"})
        criteria = tx.add("criteria", {"rules": []}, project_id=project["id"])
        with pytest.raises(ValueError):
            tx.update(criteria["id"], {"rules": ["bad"]})
    with Store(path).transaction() as tx:
        assert tx.get(project["id"])["name"] == "one"
    with pytest.raises(sqlite3.IntegrityError), store.transaction() as tx:
        tx.add("candidate", {"title": "bad"}, project_id="missing")
    with store.transaction() as tx:
        assert tx.list("candidate") == []
        tx.connection.execute("UPDATE schema_version SET version=99")
    with pytest.raises(RuntimeError, match="不兼容"):
        Store(path)


def test_command_receipt_retry_conflict_and_rollback() -> None:
    with TemporaryDirectory() as directory:
        app = FastAPI()
        app.state.store = Store(Path(directory) / "demo.db")
        app.state.clock = lambda: DEMO_NOW

        @app.post("/create")
        def create(request: Request, body: Command) -> dict:
            return execute(
                request, body, None, "CREATE", lambda tx, actor: tx.add("project", {"name": actor})
            )

        client = TestClient(app, raise_server_exceptions=True)
        headers = {"Idempotency-Key": "same"}
        first = client.post("/create", json={"actor_id": "analyst"}, headers=headers)
        second = client.post("/create", json={"actor_id": "analyst"}, headers=headers)
        assert first.json() == second.json()
        with pytest.raises(DomainError, match="不同内容"):
            client.post(
                "/create", json={"actor_id": "analyst", "expected_version": 1}, headers=headers
            )
        with app.state.store.transaction() as tx:
            assert len(tx.list("project")) == 1
        with pytest.raises(RuntimeError), app.state.store.transaction() as tx:
            tx.add("project", {"name": "rollback"})
            raise RuntimeError("failure")
        with app.state.store.transaction() as tx:
            assert len(tx.list("project")) == 1


def test_concurrent_stale_versions_and_transaction_events(tmp_path: Path) -> None:
    from concurrent.futures import ThreadPoolExecutor

    from app.main import create_app

    app = create_app(db_path=tmp_path / "concurrent.db")
    with app.state.store.transaction() as tx:
        item = tx.add("project", {"name": "original"})

    @app.post("/race")
    def race(request: Request, body: Command) -> dict:
        def operation(tx, actor):
            tx.audit(actor, "inside", item["id"])
            return tx.update(item["id"], {"name": actor})

        return execute(request, body, item["id"], "race", operation)

    def send(key: str) -> int:
        with TestClient(app) as client:
            return client.post(
                "/race",
                headers={"Idempotency-Key": key},
                json={"actor_id": "analyst", "expected_version": 1},
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(send, ["first", "second"])) == [200, 409]
    with app.state.store.transaction() as tx:
        assert tx.get(item["id"])["version"] == 2
        assert len(tx.activity(item["id"])) == 2  # one inner event plus one receipt audit
    with pytest.raises(RuntimeError), app.state.store.transaction() as tx:
        tx.audit("analyst", "must_rollback", item["id"])
        tx.add("source", {"value": "must rollback"}, project_id=item["id"])
        raise RuntimeError("simulated interrupted transaction")
    with Store(tmp_path / "concurrent.db").transaction() as tx:
        assert len(tx.activity(item["id"])) == 2
        assert not tx.list("source")


def test_durable_failure_replays_without_repeating_effects(tmp_path: Path) -> None:
    from app.main import create_app

    app = create_app(db_path=tmp_path / "failures.db")

    @app.post("/durable-failure")
    def failure(request: Request, body: Command) -> dict:
        def operation(tx, actor):
            run = tx.add("node_run", {"status": "FAILED"})
            raise DomainError(
                "INVALID_NODE", "无效输出", details={"node_run_id": run["id"]}, commit=True
            )

        return execute(request, body, None, "fail", operation)

    client = TestClient(app)
    payload = {"actor_id": "analyst"}
    first = client.post("/durable-failure", json=payload, headers={"Idempotency-Key": "retry"})
    second = client.post("/durable-failure", json=payload, headers={"Idempotency-Key": "retry"})
    assert first.status_code == second.status_code == 422
    assert first.json() == second.json()
    with app.state.store.transaction() as tx:
        assert len(tx.list("node_run")) == 1
        assert len(tx.activity()) == 1


def test_criteria_rejects_nonfinite_and_nonnumeric_ordering() -> None:
    from app.selection.projects import CriteriaRule

    for threshold in ("NaN", "Infinity", "unknown"):
        with pytest.raises(ValidationError):
            CriteriaRule(field="moq", operator="lte", threshold=threshold, unit="unit")
    assert CriteriaRule(field="category", operator="eq", threshold="outdoor", unit="text")
