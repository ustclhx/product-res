"""Offline HTTP acceptance tests for the selection workflow prototype.

These tests intentionally use only the documented FastAPI surface.  They keep
the assertions on persisted business state (and immutable history), so a
passing test does not depend on a particular service implementation.
"""

# Long request payloads are kept visually close to the public API examples.
# ruff: noqa: E501

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from app.main import create_app
from fastapi.testclient import TestClient

DEMO_NOW = datetime(2026, 9, 20, 8, tzinfo=UTC)
API = "/api/v1"


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    return TestClient(
        create_app(db_path=tmp_path / "db", clock=lambda: DEMO_NOW),
        raise_server_exceptions=False,
    )


def command(
    client: TestClient,
    path: str,
    payload: dict[str, Any],
    key: str,
    *,
    actor: str = "analyst",
    expected_version: int | None = None,
):
    body = {**payload, "actor_id": actor}
    body.setdefault("expected_version", expected_version)
    return client.post(f"{API}{path}", json=body, headers={"Idempotency-Key": key})


def assert_error(response, code: str, status: int | None = None) -> dict[str, Any]:
    if status is not None:
        assert response.status_code == status, response.text
    assert response.status_code >= 400, response.text
    body = response.json()
    assert body.get("error_code") == code, body
    return body


def templates(client: TestClient) -> dict[str, dict[str, Any]]:
    response = client.get(f"{API}/project-templates")
    assert response.status_code == 200, response.text
    return {item["channel"]: item for item in response.json()["items"]}


def project_with_criteria(
    client: TestClient,
    channel: str,
    *,
    market: str = "US",
    suffix: str = "acceptance",
) -> tuple[dict[str, Any], dict[str, Any]]:
    template = templates(client)[channel]
    created = command(
        client,
        "/projects",
        {
            "name": f"{channel} {suffix}",
            "channel": channel,
            "market": market,
            "direction": "户外露营",
            "goal": "筛选可进入小批量验证的商品",
            "constraints": ["演示数据"],
            "analyst_id": "analyst",
            "decision_owner_id": "owner",
        },
        f"project-{channel}-{suffix}",
    )
    assert created.status_code == 200, created.text
    project = created.json()["project"]
    rules = [
        {key: rule[key] for key in ("field", "operator", "threshold", "unit", "currency")}
        for rule in template["rules"]
    ]
    confirmed = command(
        client,
        f"/projects/{project['id']}/criteria-revisions",
        {
            "template_id": template["id"],
            "template_version": template["version"],
            "rules": rules,
            "required_evidence": template["required_evidence"],
            "parent_revision_id": None,
        },
        f"criteria-{channel}-{suffix}",
        actor="owner",
        expected_version=project["version"],
    )
    assert confirmed.status_code == 200, confirmed.text
    return confirmed.json()["project"], confirmed.json()["criteria"]


def add_manual(
    client: TestClient,
    project: dict[str, Any],
    *,
    key: str,
    title: str = "手工候选",
    external_id: str = "MANUAL-1",
    sku: str | None = None,
) -> dict[str, Any]:
    response = command(
        client,
        f"/projects/{project['id']}/candidates",
        {
            "title": title,
            "external_id": external_id,
            "source_url": f"https://example.invalid/manual/{external_id}",
            "sku": sku,
        },
        key,
        expected_version=project["version"],
    )
    assert response.status_code == 200, response.text
    return response.json()["candidate"]


def add_evidence(
    client: TestClient,
    candidate: dict[str, Any],
    *,
    field: str,
    value: str,
    key: str,
    unit: str = "unit",
    currency: str | None = None,
    epistemic_kind: str = "FACT",
    verification: str = "VERIFIED",
    supersedes_id: str | None = None,
    actor: str = "contributor",
) -> dict[str, Any]:
    response = command(
        client,
        f"/candidates/{candidate['id']}/evidence",
        {
            "field": field,
            "value": value,
            "unit": unit,
            "currency": currency,
            "window": None,
            "source_locator": f"acceptance.csv:{key}",
            "observed_at": "2026-09-19T08:00:00Z",
            "valid_until": "2026-10-20T08:00:00Z",
            "epistemic_kind": epistemic_kind,
            "verification": verification,
            "supersedes_id": supersedes_id,
            "is_demo": True,
        },
        key,
        actor=actor,
        expected_version=candidate["version"],
    )
    assert response.status_code == 200, response.text
    candidate.update(response.json()["candidate"])
    return response.json()["evidence"]


def valid_dimensions(evidence_ids: list[str]) -> dict[str, dict[str, Any]]:
    return {
        name: {"summary": f"{name} has a reviewable basis", "evidence_ids": evidence_ids}
        for name in ("demand", "competition", "differentiation", "supply_cost", "risk")
    }


def valid_forecast() -> dict[str, Any]:
    return {
        "currency": "USD",
        "window_start": "2026-10-01T00:00:00Z",
        "window_end": "2026-12-31T00:00:00Z",
        "revenue_basis": "GROSS",
        "units": "100",
        "metrics": {
            "revenue": "10000",
            "procurement": "2500",
            "platform": "500",
            "fulfillment": "700",
            "advertising": "1000",
            "refunds": "100",
            "other": None,
        },
    }


def make_ready_candidate(
    client: TestClient, suffix: str = "ready"
) -> tuple[dict[str, Any], dict[str, Any]]:
    project, _criteria = project_with_criteria(client, "AMAZON", suffix=suffix)
    candidate = add_manual(client, project, key=f"candidate-{suffix}", sku=f"SKU-{suffix}")
    moq = add_evidence(client, candidate, field="moq", value="100", key=f"moq-{suffix}")
    cost = add_evidence(
        client,
        candidate,
        field="procurement_cost",
        value="20.00",
        unit="item",
        currency="USD",
        key=f"cost-{suffix}",
    )
    screened = command(
        client,
        f"/candidates/{candidate['id']}/screenings",
        {},
        f"screen-{suffix}",
        expected_version=candidate["version"],
    )
    assert screened.status_code == 200, screened.text
    candidate = screened.json()["candidate"]
    evaluation = command(
        client,
        f"/candidates/{candidate['id']}/evaluations",
        {
            "dimensions": valid_dimensions([moq["id"], cost["id"]]),
            "evidence_ids": [moq["id"], cost["id"]],
            "unknowns": ["竞争数据尚未覆盖全市场"],
            "counterevidence": [],
            "assumptions": ["演示预测"],
            "forecast": valid_forecast(),
            "assistant_versions": {"provider": "fixture", "schema": "v1"},
        },
        f"evaluation-{suffix}",
        expected_version=candidate["version"],
    )
    assert evaluation.status_code == 200, evaluation.text
    candidate = evaluation.json()["candidate"]
    return candidate, evaluation.json()["evaluation"]


def submit(client: TestClient, candidate: dict[str, Any], evaluation: dict[str, Any], key: str):
    response = command(
        client,
        f"/candidates/{candidate['id']}/submissions",
        {"evaluation_id": evaluation["id"]},
        key,
        expected_version=candidate["version"],
    )
    assert response.status_code == 200, response.text
    return response.json()


def approve(client: TestClient, candidate: dict[str, Any], key: str) -> dict[str, Any]:
    response = command(
        client,
        f"/candidates/{candidate['id']}/decisions",
        {"action": "APPROVE", "reason": "材料完整，进入验证", "questions": []},
        key,
        actor="owner",
        expected_version=candidate["version"],
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_three_channels_two_entry_paths_and_scoped_csv_dedup(client: TestClient) -> None:
    """Each channel supports discovery and CSV/manual intake without cross-scope merges."""

    discovered_ids: list[str] = []
    for channel in ("AMAZON", "EBAY", "DTC"):
        project, _ = project_with_criteria(client, channel, suffix="entry")
        discovery = command(
            client,
            f"/projects/{project['id']}/discovery",
            {"query": "户外露营"},
            f"discover-{channel}",
            expected_version=project["version"],
        )
        assert discovery.status_code == 200, discovery.text
        data = discovery.json()
        assert data["coverage"] == "COVERED"
        assert data["is_demo"] is True
        assert data["items"]
        selection = data["items"][0]
        discovered = command(
            client,
            f"/projects/{project['id']}/discovery/candidates",
            {
                "selection": {
                    key: selection[key]
                    for key in ("title", "external_id", "source_url", "source_ref")
                }
            },
            f"discovered-{channel}",
            expected_version=project["version"],
        )
        assert discovered.status_code == 200, discovered.text
        assert discovered.json()["candidate"]["is_demo"] is True
        discovered_ids.append(discovered.json()["candidate"]["id"])

        uncovered = command(
            client,
            f"/projects/{project['id']}/discovery",
            {"query": "未覆盖方向"},
            f"uncovered-{channel}",
            expected_version=project["version"],
        )
        assert uncovered.status_code == 200
        assert uncovered.json()["coverage"] == "NO_SAMPLE_COVERAGE"
        assert uncovered.json()["items"] == []

        content = (
            "title,external_id,source_url,sku\n"
            f"CSV {channel},CSV-{channel},https://example.invalid/csv/{channel},SKU-{channel}\n"
            ",BAD-1,https://example.invalid/csv/bad,BAD\n"
            f"Duplicate,CSV-{channel},https://example.invalid/csv/{channel}-other,SKU-DUP\n"
        )
        preview = client.post(
            f"{API}/candidate-imports/preview",
            json={"project_id": project["id"], "filename": "candidates.csv", "content": content},
        )
        assert preview.status_code == 200, preview.text
        preview_data = preview.json()
        assert preview_data["counts"] == {"valid": 1, "invalid": 1, "duplicate": 1, "total": 3}
        assert preview_data["rows"][1]["row_number"] == 3
        assert preview_data["rows"][1]["status"] == "INVALID"
        selected = [2]
        skipped = [3, 4]
        imported = command(
            client,
            "/candidate-imports/confirm",
            {
                "project_id": project["id"],
                "filename": "candidates.csv",
                "content": content,
                "mapping": preview_data["mapping"],
                "summary_hash": preview_data["summary_hash"],
                "selected_rows": selected,
                "skipped_rows": skipped,
            },
            f"csv-confirm-{channel}",
            expected_version=project["version"],
        )
        assert imported.status_code == 200, imported.text
        assert imported.json()["created_count"] == 1
        assert imported.json()["reused_count"] == 0
        assert imported.json()["skipped_rows"] == skipped

    templates_by_channel = templates(client)
    dtc_fields = {field["key"] for field in templates_by_channel["DTC"]["fields"]}
    assert "asin" not in dtc_fields and "fba" not in " ".join(sorted(dtc_fields)).lower()

    project, _ = project_with_criteria(client, "AMAZON", market="CA", suffix="scope")
    same_identity = add_manual(
        client,
        project,
        key="scope-ca",
        title="同标识不同市场",
        external_id="B0CAMP1001",
    )
    assert same_identity["id"]
    assert same_identity["id"] != discovered_ids[0]


def test_screening_quality_unknown_override_and_invalid_assistant_are_persisted(
    client: TestClient,
) -> None:
    project, _ = project_with_criteria(client, "AMAZON", suffix="screening")
    unknown = add_manual(client, project, key="candidate-unknown", external_id="UNKNOWN-1")
    missing = command(
        client,
        f"/candidates/{unknown['id']}/screenings",
        {},
        "screen-unknown",
        expected_version=unknown["version"],
    )
    assert missing.status_code == 200
    assert missing.json()["screening"]["status"] == "NEEDS_EVIDENCE"

    candidate = add_manual(client, project, key="candidate-quality", external_id="QUALITY-1")
    estimate = add_evidence(
        client,
        candidate,
        field="moq",
        value="500",
        key="estimated-moq",
        epistemic_kind="ESTIMATE",
    )
    estimated_screen = command(
        client,
        f"/candidates/{candidate['id']}/screenings",
        {},
        "screen-estimate",
        expected_version=candidate["version"],
    )
    assert estimated_screen.status_code == 200
    assert estimated_screen.json()["screening"]["status"] == "NEEDS_EVIDENCE"
    candidate = estimated_screen.json()["candidate"]
    add_evidence(
        client,
        candidate,
        field="moq",
        value="500",
        key="verified-moq",
        supersedes_id=estimate["id"],
    )
    add_evidence(
        client,
        candidate,
        field="procurement_cost",
        value="20.00",
        unit="item",
        currency="USD",
        key="quality-cost",
    )
    excluded = command(
        client,
        f"/candidates/{candidate['id']}/screenings",
        {},
        "screen-excluded",
        expected_version=candidate["version"],
    )
    assert excluded.status_code == 200
    assert excluded.json()["screening"]["status"] == "EXCLUDED"
    candidate = excluded.json()["candidate"]
    override = command(
        client,
        f"/candidates/{candidate['id']}/screening-overrides",
        {"reason": "供应商已书面承诺可拆单满足首批验证"},
        "screen-override",
        actor="owner",
        expected_version=candidate["version"],
    )
    assert override.status_code == 200, override.text
    assert override.json()["screening"]["status"] == "OVERRIDDEN"
    assert override.json()["candidate"]["screening_status"] == "OVERRIDDEN"

    invalid_ai = command(
        client,
        f"/candidates/{candidate['id']}/assistant-runs",
        {"node_kind": "EVALUATION_ORGANIZER", "fixture": "invalid_reference"},
        "assistant-invalid-reference",
        expected_version=override.json()["candidate"]["version"],
    )
    assert_error(invalid_ai, "ASSISTANT_OUTPUT_INVALID", 422)
    detail = client.get(f"{API}/candidates/{candidate['id']}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["node_runs"][-1]["run_state"] == "FAILED"
    assert detail.json()["candidate"]["business_status"] == "PREPARING"


def test_stale_approval_return_resubmit_and_idempotent_decision(client: TestClient) -> None:
    candidate, evaluation = make_ready_candidate(client, "stale")
    submit_expected_version = candidate["version"]
    first = submit(client, candidate, evaluation, "submit-stale")
    candidate = first["candidate"]
    assert candidate["business_status"] == "IN_REVIEW"
    retry = command(
        client,
        f"/candidates/{candidate['id']}/submissions",
        {"evaluation_id": evaluation["id"]},
        "submit-stale",
        expected_version=submit_expected_version,
    )
    assert retry.status_code == 200
    assert retry.json() == first

    changed = add_evidence(
        client,
        candidate,
        field="procurement_cost",
        value="21.00",
        unit="item",
        currency="USD",
        key="post-submit-evidence",
    )
    assert changed["id"]
    stale = command(
        client,
        f"/candidates/{candidate['id']}/decisions",
        {"action": "APPROVE", "reason": "尝试批准过期快照", "questions": []},
        "approve-stale",
        actor="owner",
        expected_version=candidate["version"],
    )
    assert_error(stale, "SUBMISSION_STALE", 409)
    detail = client.get(f"{API}/candidates/{candidate['id']}")
    assert detail.status_code == 200
    assert detail.json()["candidate"]["business_status"] == "RETURNED"
    timeline = client.get(f"{API}/candidates/{candidate['id']}/decision-timeline")
    assert timeline.status_code == 200
    assert any(item["kind"] == "submission_invalidation" for item in timeline.json()["items"])

    analyst_approval = command(
        client,
        f"/candidates/{candidate['id']}/decisions",
        {"action": "APPROVE", "reason": "越权", "questions": []},
        "analyst-approval",
        actor="analyst",
        expected_version=detail.json()["candidate"]["version"],
    )
    assert_error(analyst_approval, "ROLE_NOT_ALLOWED", 403)


def test_return_supplement_resubmit_approve_validation_and_stop(client: TestClient) -> None:
    candidate, evaluation = make_ready_candidate(client, "return")
    submitted = submit(client, candidate, evaluation, "submit-return")
    candidate = submitted["candidate"]
    returned = command(
        client,
        f"/candidates/{candidate['id']}/decisions",
        {"action": "RETURN", "reason": "请补充供应商报价", "questions": ["缺少近期报价"]},
        "decision-return",
        actor="owner",
        expected_version=candidate["version"],
    )
    assert returned.status_code == 200, returned.text
    candidate = returned.json()["candidate"]
    assert candidate["business_status"] == "RETURNED"
    prior_detail = client.get(f"{API}/candidates/{candidate['id']}").json()
    prior_cost = next(
        item for item in prior_detail["evidence"] if item["field"] == "procurement_cost"
    )
    supplement = add_evidence(
        client,
        candidate,
        field="procurement_cost",
        value="19.50",
        unit="item",
        currency="USD",
        key="supplement-return",
        supersedes_id=prior_cost["id"],
    )
    refreshed = client.get(f"{API}/candidates/{candidate['id']}").json()["candidate"]
    revised = command(
        client,
        f"/candidates/{candidate['id']}/evaluations",
        {
            "dimensions": valid_dimensions([supplement["id"]]),
            "evidence_ids": [supplement["id"]],
            "unknowns": [],
            "counterevidence": [],
            "assumptions": [],
            "forecast": valid_forecast(),
            "assistant_versions": {},
            "parent_revision_id": evaluation["id"],
        },
        "evaluation-return-revision",
        expected_version=refreshed["version"],
    )
    assert revised.status_code == 200, revised.text
    candidate = revised.json()["candidate"]
    # The prior valid MOQ evidence remains part of the current snapshot.
    revised_submission = submit(
        client, candidate, revised.json()["evaluation"], "submit-return-revised"
    )
    approved = approve(client, revised_submission["candidate"], "approve-return-revised")
    candidate = approved["candidate"]
    assert candidate["business_status"] == "VALIDATING"
    assert len(approved["obligation"]["id"]) > 0

    task_response = command(
        client,
        f"/candidates/{candidate['id']}/tasks",
        {
            "type": "TEST",
            "question": "验证小批量样品",
            "owner_id": "contributor",
            "due_at": "2026-09-25T08:00:00Z",
            "completion_criteria": "记录测试结论",
            "expected_metrics": {"target": "80"},
        },
        "task-test",
        expected_version=candidate["version"],
    )
    assert task_response.status_code == 200, task_response.text
    task = task_response.json()["item"]
    started = command(
        client,
        f"/tasks/{task['id']}/transitions",
        {"state": "IN_PROGRESS"},
        "task-start",
        actor="contributor",
        expected_version=task["version"],
    )
    assert started.status_code == 200, started.text
    task = started.json()["item"]
    missing_result = command(
        client,
        f"/tasks/{task['id']}/transitions",
        {
            "state": "DONE",
            "result": "未达到目标",
            "evidence_ids": [],
            "target_met": False,
            "reason": "目标未达成",
        },
        "task-done-without-evidence",
        actor="contributor",
        expected_version=task["version"],
    )
    assert_error(missing_result, "TASK_EVIDENCE_REQUIRED", 422)
    evidence = add_evidence(
        client,
        candidate,
        field="test_result",
        value="未达目标",
        key="task-result",
    )
    task_state = client.get(f"{API}/tasks").json()["items"]
    task = next(item for item in task_state if item["id"] == task["id"])
    done = command(
        client,
        f"/tasks/{task['id']}/transitions",
        {
            "state": "DONE",
            "result": "未达到目标",
            "evidence_ids": [evidence["id"]],
            "target_met": False,
            "reason": "目标未达成",
        },
        "task-done",
        actor="contributor",
        expected_version=task["version"],
    )
    assert done.status_code == 200, done.text
    conclusion = command(
        client,
        f"/candidates/{candidate['id']}/validation-conclusions",
        {"action": "STOP", "reason": "样品测试未达标，停止上市"},
        "validation-stop",
        actor="owner",
        expected_version=candidate["version"],
    )
    assert conclusion.status_code == 200, conclusion.text
    assert conclusion.json()["candidate"]["business_status"] == "OUTCOME_PENDING"


def test_outcome_comparison_feedback_csv_and_restart_reset_isolation(
    client: TestClient, tmp_path: Path
) -> None:
    candidate, evaluation = make_ready_candidate(client, "outcome")
    approved = approve(
        client,
        submit(client, candidate, evaluation, "submit-outcome")["candidate"],
        "approve-outcome",
    )
    candidate = approved["candidate"]
    follow_up = command(
        client,
        f"/candidates/{candidate['id']}/validation-conclusions",
        {"action": "FOLLOW_UP", "reason": "进入结果跟进窗口"},
        "validation-follow-up",
        actor="owner",
        expected_version=candidate["version"],
    )
    assert follow_up.status_code == 200, follow_up.text
    candidate = follow_up.json()["candidate"]
    approval_id = approved["decision"]["id"]
    outcome_payload = {
        "approval_id": approval_id,
        "status": "RECORDED",
        "window_start": "2026-09-01T00:00:00Z",
        "window_end": "2026-09-30T00:00:00Z",
        "currency": "USD",
        "units": "100",
        "revenue_basis": "NET",
        "metrics": {
            "revenue": "9000",
            "refunds": "100",
            "procurement": "2500",
            "platform": "450",
            "fulfillment": "650",
            "advertising": None,
            "other": "0",
        },
        "source_locator": "results.csv:2",
        "is_demo": True,
        "sku": "SKU-outcome",
    }
    outcome = command(
        client,
        f"/candidates/{candidate['id']}/outcomes",
        outcome_payload,
        "outcome-record",
        actor="contributor",
        expected_version=candidate["version"],
    )
    assert outcome.status_code == 200, outcome.text
    outcome_item = outcome.json()["item"]
    comparison = client.get(f"{API}/outcomes/{outcome_item['id']}/comparison")
    assert comparison.status_code == 200, comparison.text
    comparison_data = comparison.json()
    assert comparison_data.get("actual_contribution_per_unit") is None
    assert comparison_data.get("reasons")

    duplicate = command(
        client,
        f"/candidates/{candidate['id']}/outcomes",
        outcome_payload,
        "outcome-record-retry",
        actor="contributor",
        expected_version=outcome.json()["candidate"]["version"]
        if "candidate" in outcome.json()
        else candidate["version"],
    )
    assert duplicate.status_code in {200, 409}
    if duplicate.status_code == 200:
        assert duplicate.json()["duplicate"] is True

    review = command(
        client,
        f"/outcomes/{outcome_item['id']}/reviews",
        {"deviation_reasons": ["广告费用缺失"], "notes": "保持未知"},
        "outcome-review",
        actor="contributor",
        expected_version=outcome_item["version"],
    )
    assert review.status_code == 200, review.text
    detail = client.get(f"{API}/candidates/{candidate['id']}").json()
    before_rules = detail["criteria"]["rules"]
    after_rules = [
        {**rule, "threshold": "150"} if rule["field"] == "moq" else rule for rule in before_rules
    ]
    feedback = command(
        client,
        f"/outcomes/{outcome_item['id']}/feedback-proposals",
        {
            "before_rules": before_rules,
            "after_rules": after_rules,
            "reason": "测试结果建议降低下一轮起订量上限",
        },
        "feedback-propose",
        actor="owner",
        expected_version=outcome_item["version"],
    )
    assert feedback.status_code == 200, feedback.text
    feedback_item = feedback.json()["item"]
    before_project = client.get(f"{API}/projects/{candidate['project_id']}").json()["project"]
    confirmed = command(
        client,
        f"/feedback-proposals/{feedback_item['id']}/confirm",
        {},
        "feedback-confirm",
        actor="owner",
        expected_version=feedback_item["version"],
    )
    assert confirmed.status_code == 200, confirmed.text
    after_project = client.get(f"{API}/projects/{candidate['project_id']}").json()["project"]
    assert after_project["current_criteria_id"] == before_project["current_criteria_id"]
    assert confirmed.json()["item"]["new_criteria_id"]

    result_csv = (
        "sku,approval_id,status,window_start,window_end,currency,units,revenue_basis,revenue,refunds,procurement,platform,fulfillment,advertising,other,source_locator,is_demo\nSKU-outcome,"
        + approval_id
        + ",RECORDED,2026-09-01T00:00:00Z,2026-09-30T00:00:00Z,USD,100,NET,9000,100,2500,450,650,,0,results.csv:2,true\n"
    )
    csv_preview = command(
        client,
        "/outcome-imports/preview",
        {"csv_text": result_csv},
        "outcome-csv-preview",
        actor="analyst",
    )
    assert csv_preview.status_code == 200, csv_preview.text
    assert csv_preview.json()["rows"][0]["duplicate_outcome_id"] == outcome_item["id"]
    bad_confirm = command(
        client,
        "/outcome-imports/confirm",
        {
            "csv_text": result_csv,
            "content_hash": csv_preview.json()["content_hash"],
            "selected_rows": [2],
            "mappings": {},
        },
        "outcome-csv-confirm",
        actor="contributor",
    )
    assert bad_confirm.status_code == 200, bad_confirm.text
    assert bad_confirm.json()["duplicates"][0]["outcome_id"] == outcome_item["id"]

    # A second app instance on the same DB sees persisted business state; a new DB is isolated.
    shared_db = tmp_path / "shared.sqlite3"
    first_app = create_app(db_path=shared_db, clock=lambda: DEMO_NOW)
    first_client = TestClient(first_app, raise_server_exceptions=False)
    first_project, _ = project_with_criteria(first_client, "DTC", suffix="restart")
    restarted = TestClient(
        create_app(db_path=shared_db, clock=lambda: DEMO_NOW), raise_server_exceptions=False
    )
    assert any(
        item["id"] == first_project["id"]
        for item in restarted.get(f"{API}/projects").json()["items"]
    )
    isolated = TestClient(
        create_app(db_path=tmp_path / "isolated.sqlite3", clock=lambda: DEMO_NOW),
        raise_server_exceptions=False,
    )
    assert isolated.get(f"{API}/projects").json()["items"] == []


def test_demo_init_reset_requires_sample_version_and_isolates_workspace(tmp_path: Path) -> None:
    """Demo seed/reset is explicit and scoped to the selected SQLite workspace."""

    db_path = tmp_path / "demo.sqlite3"
    client = TestClient(
        create_app(db_path=db_path, clock=lambda: DEMO_NOW), raise_server_exceptions=False
    )
    before = client.get(f"{API}/demo")
    assert before.status_code == 200, before.text
    assert before.json()["initialized"] is False

    initialized = command(client, "/demo/init", {}, "demo-init", actor="owner")
    assert initialized.status_code == 200, initialized.text
    demo = client.get(f"{API}/demo").json()
    assert demo["initialized"] is True
    assert demo["sample_version"]
    assert client.get(f"{API}/projects").json()["items"]

    custom = command(
        client,
        "/projects",
        {
            "name": "仅当前工作区的手工项目",
            "channel": "DTC",
            "market": "US",
            "direction": "未覆盖方向",
            "goal": "验证重置隔离",
            "constraints": [],
            "analyst_id": "analyst",
            "decision_owner_id": "owner",
        },
        "demo-custom-project",
    )
    assert custom.status_code == 200, custom.text
    custom_id = custom.json()["project"]["id"]

    reset = command(
        client,
        "/demo/reset",
        {"sample_version": demo["sample_version"]},
        "demo-reset",
        actor="owner",
        expected_version=demo["version"],
    )
    assert reset.status_code == 200, reset.text
    projects_after_reset = client.get(f"{API}/projects").json()["items"]
    assert custom_id not in {item["id"] for item in projects_after_reset}
    assert projects_after_reset
    assert client.get(f"{API}/demo").json()["version"] == demo["version"] + 1

    isolated_db = tmp_path / "other.sqlite3"
    isolated = TestClient(
        create_app(db_path=isolated_db, clock=lambda: DEMO_NOW), raise_server_exceptions=False
    )
    assert isolated.get(f"{API}/demo").json()["initialized"] is False
    assert isolated.get(f"{API}/projects").json()["items"] == []
