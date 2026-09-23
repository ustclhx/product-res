from __future__ import annotations

from pathlib import Path
from typing import Any, cast

import pytest
from app.api.routes.intake import router as intake_router
from app.api.routes.projects import router as projects_router
from app.core import DomainError
from app.persistence.store import DEMO_NOW, Store
from app.selection.intake import (
    ConfirmCandidateImport,
    PreviewCandidateImport,
    confirm_candidate_import,
    preview_candidate_import,
)
from app.selection.projects import (
    ConfirmCriteriaCommand,
    CreateProjectCommand,
    confirm_criteria,
    create_project,
    list_templates,
    template_defaults,
)
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from pydantic import ValidationError


def _project_command(**changes: Any) -> CreateProjectCommand:
    values: dict[str, Any] = {
        "actor_id": "analyst",
        "name": "北美户外露营选品",
        "channel": "AMAZON",
        "market": "US",
        "direction": "户外露营",
        "goal": "筛选可进入小批量验证的商品",
        "constraints": ["首批采购预算 5000 USD"],
        "analyst_id": "analyst",
        "decision_owner_id": "owner",
    }
    values.update(changes)
    return CreateProjectCommand.model_validate(values)


def _confirmed_project(store: Store, **changes: Any) -> dict[str, Any]:
    with store.transaction(DEMO_NOW) as tx:
        project = create_project(tx, "analyst", _project_command(**changes))["project"]
        template_id = {
            "AMAZON": "amazon-camping-v1",
            "EBAY": "ebay-camping-v1",
            "DTC": "dtc-camping-v1",
        }[project["channel"]]
        defaults = template_defaults(template_id)
        result = confirm_criteria(
            tx,
            "owner",
            ConfirmCriteriaCommand(
                actor_id="owner",
                expected_version=project["version"],
                parent_revision_id=None,
                **defaults,
            ),
            project["id"],
        )
        return cast(dict[str, Any], result["project"])


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(tmp_path / "demo.sqlite3")


def _app(store: Store) -> FastAPI:
    app = FastAPI()
    app.state.store = store
    app.state.clock = lambda: DEMO_NOW
    app.include_router(projects_router, prefix="/api/v1")
    app.include_router(intake_router, prefix="/api/v1")

    @app.exception_handler(DomainError)
    async def domain_error(_request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content={"error_code": exc.code, "message": exc.message, "details": exc.details},
        )

    return app


def test_channel_templates_keep_cost_fields_separate() -> None:
    templates = {item["channel"]: item for item in list_templates()}
    assert set(templates) == {"AMAZON", "EBAY", "DTC"}
    dtc_fields = {field["key"] for field in templates["DTC"]["fields"]}
    amazon_fields = {field["key"] for field in templates["AMAZON"]["fields"]}
    ebay_fields = {field["key"] for field in templates["EBAY"]["fields"]}
    assert not {"asin", "amazon_fulfillment_cost"}.intersection(dtc_fields)
    assert "amazon_platform_fee" in amazon_fields
    assert "ebay_platform_fee" in ebay_fields
    assert all(rule["is_demo"] for item in templates.values() for rule in item["rules"])


def test_draft_without_owners_cannot_confirm_criteria(store: Store) -> None:
    with store.transaction(DEMO_NOW) as tx:
        project = create_project(
            tx,
            "analyst",
            _project_command(analyst_id=None, decision_owner_id=None),
        )["project"]
        defaults = template_defaults("amazon-camping-v1")
        with pytest.raises(DomainError) as error:
            confirm_criteria(
                tx,
                "owner",
                ConfirmCriteriaCommand(
                    actor_id="owner",
                    expected_version=project["version"],
                    parent_revision_id=None,
                    **defaults,
                ),
                project["id"],
            )
        assert error.value.code == "PROJECT_OWNERS_REQUIRED"


def test_confirm_criteria_allows_research_only_standard_but_requires_evidence(
    store: Store,
) -> None:
    with store.transaction(DEMO_NOW) as tx:
        project = create_project(tx, "analyst", _project_command())["project"]
        command = ConfirmCriteriaCommand(
            actor_id="owner",
            expected_version=project["version"],
            template_id="amazon-camping-v1",
            template_version="1.0.0",
            rules=[],
            required_evidence=["procurement_cost"],
            parent_revision_id=None,
        )
        result = confirm_criteria(tx, "owner", command, project["id"])
        assert result["criteria"]["rules"] == []
        assert result["criteria"]["required_evidence"] == ["procurement_cost"]

    with pytest.raises(ValidationError):
        ConfirmCriteriaCommand(
            actor_id="owner",
            expected_version=1,
            template_id="amazon-camping-v1",
            template_version="1.0.0",
            rules=[],
            required_evidence=[],
            parent_revision_id=None,
        )


def test_new_criteria_invalidates_in_review_submission_without_overwriting(
    store: Store,
) -> None:
    project = _confirmed_project(store)
    with store.transaction(DEMO_NOW) as tx:
        old_criteria_id = project["current_criteria_id"]
        candidate = tx.add(
            "candidate",
            {
                "title": "待复审露营灯",
                "external_id": "REVIEW-1",
                "source_url": None,
                "business_status": "PREPARING",
                "screening_status": "PASS",
                "current_evaluation_id": None,
                "current_submission_id": None,
                "approval_id": None,
                "sku": None,
                "market": "US",
                "is_demo": True,
            },
            project_id=project["id"],
        )
        submission = tx.add(
            "submission",
            {"criteria_id": old_criteria_id, "evaluation_id": "evaluation-fixture"},
            project_id=project["id"],
            candidate_id=candidate["id"],
        )
        tx.update(
            candidate["id"],
            {"business_status": "IN_REVIEW", "current_submission_id": submission["id"]},
        )
        defaults = template_defaults("amazon-camping-v1")
        rules = defaults["rules"]
        rules[0] = {**rules[0], "threshold": "150"}
        result = confirm_criteria(
            tx,
            "owner",
            ConfirmCriteriaCommand(
                actor_id="owner",
                expected_version=project["version"],
                parent_revision_id=old_criteria_id,
                **defaults,
            ),
            project["id"],
        )
        assert result["invalidated_submission_ids"] == [submission["id"]]
        assert tx.get(candidate["id"])["business_status"] == "RETURNED"
        assert tx.get(submission["id"], "submission")["criteria_id"] == old_criteria_id
        events = tx.list("submission_invalidation", candidate_id=candidate["id"])
        assert events[0]["new_criteria_id"] == result["criteria"]["id"]
        assert tx.activity(candidate["id"])[0]["actor_id"] == "system"


def test_discovery_requires_selection_and_is_idempotent(store: Store) -> None:
    project = _confirmed_project(store)
    client = TestClient(_app(store))
    base = {"actor_id": "analyst", "expected_version": project["version"]}
    response = client.post(
        f"/api/v1/projects/{project['id']}/discovery",
        headers={"Idempotency-Key": "discover-covered"},
        json={**base, "query": "camping"},
    )
    assert response.status_code == 200
    discovery = response.json()
    assert discovery["coverage"] == "COVERED"
    assert len(discovery["items"]) == 3
    with store.transaction(DEMO_NOW) as tx:
        assert tx.list("candidate", project_id=project["id"]) == []

    payload = {**base, "selection": discovery["items"][0]}
    first = client.post(
        f"/api/v1/projects/{project['id']}/discovery/candidates",
        headers={"Idempotency-Key": "add-discovered"},
        json=payload,
    )
    second = client.post(
        f"/api/v1/projects/{project['id']}/discovery/candidates",
        headers={"Idempotency-Key": "add-discovered"},
        json=payload,
    )
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    with store.transaction(DEMO_NOW) as tx:
        assert len(tx.list("candidate", project_id=project["id"])) == 1
        assert len(tx.list("source", project_id=project["id"])) == 1

    uncovered = client.post(
        f"/api/v1/projects/{project['id']}/discovery",
        headers={"Idempotency-Key": "discover-uncovered"},
        json={**base, "query": "厨房收纳"},
    )
    assert uncovered.json()["coverage"] == "NO_SAMPLE_COVERAGE"
    assert uncovered.json()["items"] == []


def test_csv_preview_confirm_explicit_skip_and_scoped_duplicate(store: Store) -> None:
    project = _confirmed_project(store)
    content = (
        "title,external_id,source_url,sku\n"
        "折叠露营桌,CAMP-CSV-1,https://example.invalid/items/table,TABLE-1\n"
        ",CAMP-CSV-BAD,https://example.invalid/items/bad,BAD-1\n"
    )
    request = PreviewCandidateImport(
        project_id=project["id"], filename="candidates.csv", content=content
    )
    with store.transaction(DEMO_NOW) as tx:
        preview = preview_candidate_import(tx, request)
        assert preview["counts"] == {"valid": 1, "invalid": 1, "duplicate": 0, "total": 2}
        command = ConfirmCandidateImport(
            actor_id="analyst",
            expected_version=project["version"],
            project_id=project["id"],
            filename="candidates.csv",
            content=content,
            mapping=preview["mapping"],
            summary_hash=preview["summary_hash"],
            selected_rows=[2],
            skipped_rows=[3],
        )
        confirmed = confirm_candidate_import(tx, "analyst", command)
        assert confirmed["created_count"] == 1
        first_candidate_id = confirmed["items"][0]["id"]

    with store.transaction(DEMO_NOW) as tx:
        duplicate_preview = preview_candidate_import(tx, request)
        assert duplicate_preview["rows"][0]["status"] == "DUPLICATE"
        duplicate = confirm_candidate_import(
            tx,
            "analyst",
            ConfirmCandidateImport(
                actor_id="analyst",
                expected_version=project["version"],
                project_id=project["id"],
                filename="candidates.csv",
                content=content,
                mapping=duplicate_preview["mapping"],
                summary_hash=duplicate_preview["summary_hash"],
                selected_rows=[2],
                skipped_rows=[3],
            ),
        )
        assert duplicate["reused_count"] == 1
        assert duplicate["items"][0]["id"] == first_candidate_id
        assert len(tx.list("source", candidate_id=first_candidate_id)) == 2

    other = _confirmed_project(store, name="另一个项目")
    other_request = request.model_copy(update={"project_id": other["id"]})
    with store.transaction(DEMO_NOW) as tx:
        other_preview = preview_candidate_import(tx, other_request)
        assert other_preview["rows"][0]["status"] == "VALID"


def test_confirmed_feedback_criteria_clones_to_new_project(store: Store) -> None:
    original = _confirmed_project(store)
    with store.transaction(DEMO_NOW) as tx:
        feedback = tx.add(
            "feedback",
            {
                "outcome_id": "outcome-fixture",
                "before_rules": [],
                "after_rules": [],
                "reason": "验证后收紧 MOQ",
                "status": "CONFIRMED",
                "new_criteria_id": original["current_criteria_id"],
            },
            project_id=original["id"],
        )
        result = create_project(
            tx,
            "owner",
            _project_command(
                actor_id="owner",
                name="采用复盘标准的新项目",
                source_feedback_id=feedback["id"],
            ),
        )
        assert result["criteria"]["parent_revision_id"] == original["current_criteria_id"]
        assert result["project"]["current_criteria_id"] == result["criteria"]["id"]
        assert tx.get(original["id"])["current_criteria_id"] == original["current_criteria_id"]


def test_csv_size_limit_and_criteria_role_are_enforced(store: Store) -> None:
    project = _confirmed_project(store)
    with store.transaction(DEMO_NOW) as tx:
        with pytest.raises(DomainError) as too_large:
            preview_candidate_import(
                tx,
                PreviewCandidateImport(
                    project_id=project["id"],
                    filename="large.csv",
                    content="x" * (2 * 1024 * 1024 + 1),
                ),
            )
        assert too_large.value.code == "CSV_TOO_LARGE"

        defaults = template_defaults("amazon-camping-v1")
        with pytest.raises(DomainError) as wrong_role:
            confirm_criteria(
                tx,
                "analyst",
                ConfirmCriteriaCommand(
                    actor_id="analyst",
                    expected_version=project["version"],
                    parent_revision_id=project["current_criteria_id"],
                    **defaults,
                ),
                project["id"],
            )
        assert wrong_role.value.code == "ROLE_NOT_ALLOWED"


def test_malformed_source_url_is_a_business_error() -> None:
    from app.selection.intake import _require_url

    for value in ("https://example.com:bad/item", "https://[broken/item", "https://:123/item"):
        with pytest.raises(DomainError, match="来源链接"):
            _require_url(value)
