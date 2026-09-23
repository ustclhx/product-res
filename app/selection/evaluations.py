"""Immutable candidate evaluation snapshots and bounded assistant execution."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from pydantic import ValidationError

from app.core import DomainError, require_role
from app.evidence.screening import current_evidence, evaluate_screening
from app.persistence.store import Tx
from app.providers.assistant import (
    AssistantInput,
    AssistantOutput,
    NodeAssistant,
    NodeKind,
    SimulatedNodeAssistant,
)
from app.runtime.errors import (
    ErrorFact,
    ExecutionFailure,
    RetryPolicy,
    decide_error_policy,
)
from app.runtime.state import NodeAttemptState, RunState

DIMENSION_NAMES = frozenset(
    {"demand", "competition", "differentiation", "supply_cost", "risk"}
)
FORECAST_METRICS = frozenset(
    {"revenue", "procurement", "platform", "fulfillment", "advertising", "refunds", "other"}
)


def _workspace(tx: Tx, candidate_id: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    candidate = tx.get(candidate_id, "candidate")
    project = tx.get(candidate["project_id"], "project")
    criteria_id = project.get("current_criteria_id")
    if not criteria_id:
        raise DomainError("CRITERIA_NOT_CONFIRMED", "项目尚无已确认标准")
    criteria = tx.get(str(criteria_id), "criteria")
    return candidate, project, criteria


def _screening_snapshot(
    tx: Tx, candidate: dict[str, Any], criteria: dict[str, Any]
) -> dict[str, Any]:
    return evaluate_screening(
        criteria,
        tx.list("evidence", candidate_id=candidate["id"]),
        tx.list("override", candidate_id=candidate["id"]),
        now=tx.now,
    )


def validate_evidence_references(
    candidate_id: str,
    evidence: list[dict[str, Any]],
    evidence_ids: list[str],
) -> None:
    owned = {item["id"] for item in evidence if item.get("candidate_id") == candidate_id}
    invalid = sorted(set(evidence_ids) - owned)
    if invalid:
        raise DomainError(
            "INVALID_EVIDENCE_REFERENCE",
            "评估引用了不存在或其他候选的证据",
            details={"evidence_ids": invalid},
        )


def _validate_dimensions(
    dimensions: dict[str, dict[str, Any]], evidence: list[dict[str, Any]], candidate_id: str
) -> list[str]:
    if set(dimensions) != DIMENSION_NAMES:
        raise DomainError(
            "INVALID_EVALUATION",
            "评估必须恰好包含需求、竞争、差异化、供应成本和风险五个维度",
            details={"required_dimensions": sorted(DIMENSION_NAMES)},
        )
    citations: list[str] = []
    for name, dimension in dimensions.items():
        if set(dimension) != {"summary", "evidence_ids"}:
            raise DomainError(
                "INVALID_EVALUATION",
                f"{name} 维度必须包含 summary 和 evidence_ids",
            )
        summary = dimension.get("summary")
        refs = dimension.get("evidence_ids")
        if not isinstance(summary, str) or not summary.strip() or not isinstance(refs, list):
            raise DomainError("INVALID_EVALUATION", f"{name} 维度结构无效")
        if not all(isinstance(item, str) for item in refs):
            raise DomainError("INVALID_EVALUATION", f"{name} 的证据引用必须是字符串")
        citations.extend(refs)
    validate_evidence_references(candidate_id, evidence, citations)
    return citations


def _validate_forecast(forecast: dict[str, Any]) -> None:
    expected = {
        "currency",
        "window_start",
        "window_end",
        "revenue_basis",
        "units",
        "metrics",
    }
    if set(forecast) != expected:
        raise DomainError("INVALID_FORECAST", "预测必须声明币种、窗口、收入口径、数量和指标")
    metrics = forecast.get("metrics")
    if not isinstance(metrics, dict) or set(metrics) != FORECAST_METRICS:
        raise DomainError(
            "INVALID_FORECAST",
            "预测指标字段不完整",
            details={"required_metrics": sorted(FORECAST_METRICS)},
        )
    for name, value in metrics.items():
        if value is None:
            continue
        if not isinstance(value, str):
            raise DomainError("INVALID_FORECAST", f"{name} 必须是十进制字符串或 null")
        try:
            parsed = Decimal(value)
        except InvalidOperation as exc:
            raise DomainError("INVALID_FORECAST", f"{name} 不是有效十进制数") from exc
        if not parsed.is_finite() or parsed < 0:
            raise DomainError("INVALID_FORECAST", f"{name} 必须是有限的非负十进制数")
    units = forecast.get("units")
    if units is not None:
        if not isinstance(units, str):
            raise DomainError("INVALID_FORECAST", "units 必须是十进制字符串或 null")
        try:
            parsed_units = Decimal(units)
        except InvalidOperation as exc:
            raise DomainError("INVALID_FORECAST", "units 不是有效十进制数") from exc
        if not parsed_units.is_finite() or parsed_units < 0:
            raise DomainError("INVALID_FORECAST", "units 必须是有限的非负十进制数")
    currency = forecast.get("currency")
    if currency is not None and (
        not isinstance(currency, str) or len(currency) != 3 or currency.upper() != currency
    ):
        raise DomainError("INVALID_FORECAST", "currency 必须是三个大写字母或 null")
    revenue_basis = forecast.get("revenue_basis")
    if revenue_basis not in {None, "GROSS", "NET"}:
        raise DomainError("INVALID_FORECAST", "revenue_basis 必须是 GROSS、NET 或 null")
    parsed_window: list[datetime | None] = []
    for name in ("window_start", "window_end"):
        value = forecast.get(name)
        if value is None:
            parsed_window.append(None)
            continue
        if isinstance(value, datetime):
            parsed_time = value
        elif isinstance(value, str):
            candidate = value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value
            try:
                parsed_time = datetime.fromisoformat(candidate)
            except ValueError as exc:
                raise DomainError("INVALID_FORECAST", f"{name} 不是有效时间") from exc
        else:
            raise DomainError("INVALID_FORECAST", f"{name} 必须是 UTC 时间或 null")
        if parsed_time.tzinfo is None or parsed_time.utcoffset() is None:
            raise DomainError("INVALID_FORECAST", f"{name} 必须包含时区")
        parsed_window.append(parsed_time.astimezone(UTC))
    start, end = parsed_window
    if start is not None and end is not None and end <= start:
        raise DomainError("INVALID_FORECAST", "window_end 必须晚于 window_start")


def evaluation_readiness(
    tx: Tx,
    candidate: dict[str, Any],
    criteria: dict[str, Any],
    evaluation: dict[str, Any],
) -> dict[str, Any]:
    screening = _screening_snapshot(tx, candidate, criteria)
    blockers: list[dict[str, Any]] = []
    if evaluation.get("criteria_id") != criteria["id"]:
        blockers.append({"code": "CRITERIA_CHANGED", "criteria_id": criteria["id"]})
    if evaluation.get("input_hash") != screening["input_hash"]:
        blockers.append({"code": "EVIDENCE_CHANGED", "input_hash": screening["input_hash"]})
    if screening["status"] == "EXCLUDED":
        blockers.append(
            {"code": "HARD_RULE_EXCLUDED", "rule_keys": screening["unresolved_failed_rule_keys"]}
        )
    if screening["missing_fields"]:
        blockers.append({"code": "EVIDENCE_REQUIRED", "fields": screening["missing_fields"]})
    return {"ready": not blockers, "blockers": blockers, "screening": screening}


def create_evaluation(
    tx: Tx,
    actor: str,
    candidate_id: str,
    *,
    dimensions: dict[str, dict[str, Any]],
    evidence_ids: list[str],
    unknowns: list[str],
    counterevidence: list[str],
    assumptions: list[str],
    forecast: dict[str, Any],
    assistant_versions: dict[str, str],
    parent_revision_id: str | None,
) -> dict[str, Any]:
    candidate, project, criteria = _workspace(tx, candidate_id)
    require_role(tx, project, actor, "analyst")
    evidence = tx.list("evidence", candidate_id=candidate_id)
    current = current_evidence(evidence)
    dimension_refs = _validate_dimensions(dimensions, current, candidate_id)
    validate_evidence_references(candidate_id, current, evidence_ids)
    _validate_forecast(forecast)
    if parent_revision_id is not None:
        parent = tx.get(parent_revision_id, "evaluation")
        if parent.get("candidate_id") != candidate_id:
            raise DomainError("INVALID_PARENT_REVISION", "人工修订只能引用同一候选的评估")
    screening = _screening_snapshot(tx, candidate, criteria)
    # Freeze the complete current screening input, including valid required evidence
    # that a narrative dimension did not cite explicitly.
    all_references = sorted(
        set(evidence_ids + dimension_refs + list(screening["evidence_ids"]))
    )
    evaluation = tx.add(
        "evaluation",
        {
            "criteria_id": criteria["id"],
            "evidence_ids": all_references,
            "input_hash": screening["input_hash"],
            "dimensions": dimensions,
            "unknowns": unknowns,
            "counterevidence": counterevidence,
            "assumptions": assumptions,
            "forecast": forecast,
            "assistant_versions": assistant_versions,
            "parent_revision_id": parent_revision_id,
            "created_by": actor,
        },
        project_id=project["id"],
        candidate_id=candidate_id,
    )
    candidate = tx.update(candidate_id, {"current_evaluation_id": evaluation["id"]})
    readiness = evaluation_readiness(tx, candidate, criteria, evaluation)
    return {"evaluation": evaluation, "candidate": candidate, "readiness": readiness}


def _assistant_input_hash(value: AssistantInput, node_kind: NodeKind) -> str:
    encoded = json.dumps(
        {"node_kind": node_kind.value, "input": value.model_dump(mode="json")},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(encoded.encode()).hexdigest()


def _record_failed_node(
    tx: Tx,
    *,
    candidate: dict[str, Any],
    project: dict[str, Any],
    actor: str,
    node_kind: NodeKind,
    input_hash: str,
    message: str,
) -> dict[str, Any]:
    failure = ExecutionFailure(
        facts=frozenset({ErrorFact.CONTENT_ANOMALY}),
        error_code="ASSISTANT.OUTPUT_INVALID",
        error_summary=message,
    )
    policy = decide_error_policy(
        failure,
        RetryPolicy(attempt_no=1, max_attempts=1),
    )
    return tx.add(
        "node_run",
        {
            "node_kind": node_kind.value,
            "input_hash": input_hash,
            "run_state": RunState.FAILED.value,
            "attempt_state": NodeAttemptState.FAILED.value,
            "actor_id": actor,
            "error_code": failure.error_code,
            "error_summary": failure.error_summary,
            "error_category": policy.category.value,
            "error_action": policy.action.value,
            "is_simulated": True,
        },
        project_id=project["id"],
        candidate_id=candidate["id"],
    )


def run_assistant(
    tx: Tx,
    actor: str,
    candidate_id: str,
    *,
    node_kind: NodeKind,
    fixture: str,
    assistant: NodeAssistant | None = None,
) -> dict[str, Any]:
    candidate, project, criteria = _workspace(tx, candidate_id)
    require_role(tx, project, actor, "analyst")
    evidence = tx.list("evidence", candidate_id=candidate_id)
    screening = _screening_snapshot(tx, candidate, criteria)
    snapshot = AssistantInput(
        candidate_id=candidate_id,
        criteria_id=criteria["id"],
        evidence=current_evidence(evidence),
        missing_fields=screening["missing_fields"],
        context={"screening_status": screening["status"]},
    )
    input_hash = _assistant_input_hash(snapshot, node_kind)
    provider = assistant or SimulatedNodeAssistant()
    try:
        raw_output = provider.run(node_kind, snapshot, fixture=fixture)
        output = AssistantOutput.model_validate(raw_output)
        cited = set(output.citations)
        for statement in output.statements:
            if statement.kind == "FACT":
                if not statement.evidence_ids:
                    raise ValueError("factual assistant statements require evidence citations")
                cited.update(statement.evidence_ids)
        validate_evidence_references(candidate_id, snapshot.evidence, sorted(cited))
    except (ValidationError, ValueError, DomainError) as exc:
        node_run = _record_failed_node(
            tx,
            candidate=candidate,
            project=project,
            actor=actor,
            node_kind=node_kind,
            input_hash=input_hash,
            message=str(exc),
        )
        raise DomainError(
            "ASSISTANT_OUTPUT_INVALID",
            "模拟 AI 输出结构或引用无效，未创建评估",
            details={"node_run_id": node_run["id"], "reason": str(exc)},
            commit=True,
        ) from exc
    output_data = output.model_dump(mode="json")
    node_run = tx.add(
        "node_run",
        {
            "node_kind": node_kind.value,
            "input_hash": input_hash,
            "run_state": RunState.SUCCEEDED.value,
            "attempt_state": NodeAttemptState.SUCCEEDED.value,
            "actor_id": actor,
            "provider": output.provider,
            "model_version": output.model_version,
            "prompt_version": output.prompt_version,
            "schema_version": output.schema_version,
            "is_simulated": output.is_simulated,
            "output": output_data,
        },
        project_id=project["id"],
        candidate_id=candidate_id,
    )
    return {"node_run": node_run, "output": output_data}
