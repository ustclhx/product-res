"""Pure live-assistant snapshot preparation and immutable draft persistence."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core import DomainError, require_role
from app.evidence.screening import current_evidence, evaluate_screening
from app.outcomes.service import compare_outcome
from app.persistence.store import Tx
from app.providers.assistant import AssistantInput, NodeKind
from app.providers.newapi import ProviderResult


class PreparedAssistantRun(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    actor_id: str = Field(min_length=1)
    candidate_id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    workspace_id: str | None = None
    node_kind: NodeKind
    outcome_id: str | None = None
    input_snapshot: AssistantInput
    input_hash: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")

    @field_validator("node_kind", mode="before")
    @classmethod
    def restore_node_kind(cls, value: Any) -> Any:
        return NodeKind(value) if isinstance(value, str) else value


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _fingerprint(
    *,
    candidate_id: str,
    project_id: str,
    workspace_id: str | None,
    node_kind: NodeKind,
    outcome_id: str | None,
    input_snapshot: AssistantInput,
) -> str:
    payload = {
        "candidate_id": candidate_id,
        "project_id": project_id,
        "workspace_id": workspace_id,
        "node_kind": node_kind.value,
        "outcome_id": outcome_id,
        "input_snapshot": input_snapshot.model_dump(mode="json"),
    }
    return hashlib.sha256(_canonical(payload).encode()).hexdigest()


def _current_questions(tx: Tx, candidate: dict[str, Any]) -> list[str]:
    if candidate.get("business_status") != "RETURNED":
        return []
    latest_return = next(
        (
            decision
            for decision in reversed(tx.list("decision", candidate_id=str(candidate["id"])))
            if decision.get("action") == "RETURN"
        ),
        None,
    )
    if latest_return is None:
        return []
    return [str(value) for value in latest_return.get("questions", []) if str(value).strip()]


def _base(tx: Tx, actor: str, candidate_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    candidate = tx.get(candidate_id, "candidate")
    project = tx.get(str(candidate["project_id"]), "project")
    require_role(tx, project, actor, "analyst")
    return candidate, project


def prepare(
    tx: Tx,
    actor: str,
    candidate_id: str,
    node_kind: NodeKind,
    outcome_id: str | None = None,
) -> PreparedAssistantRun:
    """Freeze the exact material a job may send after its write transaction closes."""

    _base(tx, actor, candidate_id)
    return _prepare_input(tx, actor, candidate_id, node_kind, outcome_id)


def _prepare_input(
    tx: Tx,
    actor: str,
    candidate_id: str,
    node_kind: NodeKind,
    outcome_id: str | None = None,
) -> PreparedAssistantRun:
    """Build a read-only projection; callers enforce workspace/command access."""

    if not isinstance(node_kind, NodeKind):
        raise TypeError("node_kind must be a NodeKind")
    candidate = tx.get(candidate_id, "candidate")
    project = tx.get(str(candidate["project_id"]), "project")
    workspace_id = getattr(tx, "workspace_id", None)
    if workspace_id is not None:
        workspace_id = str(workspace_id)
    if node_kind is NodeKind.OUTCOME_REVIEW:
        snapshot, selected_outcome_id = _prepare_review(
            tx, candidate, project, outcome_id=outcome_id
        )
    else:
        if outcome_id is not None:
            raise DomainError("OUTCOME_NOT_ALLOWED", "outcome_id is only valid for outcome review")
        criteria_id = project.get("current_criteria_id")
        if not criteria_id:
            raise DomainError("CRITERIA_NOT_CONFIRMED", "项目尚无已确认标准")
        criteria = tx.get(str(criteria_id), "criteria")
        evidence = current_evidence(tx.list("evidence", candidate_id=candidate_id))
        screening = evaluate_screening(
            criteria,
            tx.list("evidence", candidate_id=candidate_id),
            tx.list("override", candidate_id=candidate_id),
            now=tx.now,
        )
        snapshot = AssistantInput(
            candidate_id=candidate_id,
            criteria_id=str(criteria["id"]),
            evidence=evidence,
            missing_fields=list(screening["missing_fields"]),
            context={
                "workspace_id": workspace_id,
                "project_id": str(project["id"]),
                "criteria": criteria,
                "current_questions": _current_questions(tx, candidate),
                "screening": screening,
                "citation_catalog": {"evidence": [str(item["id"]) for item in evidence]},
            },
        )
        selected_outcome_id = None
    input_hash = _fingerprint(
        candidate_id=candidate_id,
        project_id=str(project["id"]),
        workspace_id=workspace_id,
        node_kind=node_kind,
        outcome_id=selected_outcome_id,
        input_snapshot=snapshot,
    )
    return PreparedAssistantRun(
        actor_id=actor,
        candidate_id=candidate_id,
        project_id=str(project["id"]),
        workspace_id=workspace_id,
        node_kind=node_kind,
        outcome_id=selected_outcome_id,
        input_snapshot=snapshot,
        input_hash=input_hash,
    )


def _prepare_review(
    tx: Tx,
    candidate: dict[str, Any],
    project: dict[str, Any],
    *,
    outcome_id: str | None,
) -> tuple[AssistantInput, str]:
    if not outcome_id:
        raise DomainError("OUTCOME_REQUIRED", "outcome review requires a specified outcome")
    approval_id = candidate.get("approval_id")
    if not approval_id:
        raise DomainError("APPROVAL_REQUIRED", "candidate has no approved evaluation")
    approval = tx.get(str(approval_id), "decision")
    if approval.get("action") != "APPROVE" or approval.get("candidate_id") != candidate["id"]:
        raise DomainError("APPROVAL_MISMATCH", "candidate approval is invalid")
    approved_evaluation = tx.get(str(approval["evaluation_id"]), "evaluation")
    if approved_evaluation.get("candidate_id") != candidate["id"]:
        raise DomainError("APPROVAL_MISMATCH", "approved evaluation belongs to another candidate")
    outcome = tx.get(outcome_id, "outcome")
    if (
        outcome.get("candidate_id") != candidate["id"]
        or outcome.get("project_id") != project["id"]
        or outcome.get("approval_id") != approval["id"]
    ):
        raise DomainError("OUTCOME_MISMATCH", "outcome does not belong to this approval")
    evidence: list[dict[str, Any]] = []
    for evidence_id in approved_evaluation.get("evidence_ids", []):
        item = tx.get(str(evidence_id), "evidence")
        if item.get("candidate_id") != candidate["id"]:
            raise DomainError(
                "INVALID_EVIDENCE_REFERENCE", "approved evaluation has foreign evidence"
            )
        evidence.append(item)
    comparison = compare_outcome(tx, outcome_id)
    if (
        comparison.get("approval_id") != approval["id"]
        or comparison.get("evaluation_id") != approved_evaluation["id"]
    ):
        raise DomainError(
            "COMPARISON_MISMATCH", "comparison is not based on the approved evaluation"
        )
    comparison_id = hashlib.sha256(_canonical(comparison).encode()).hexdigest()
    snapshot = AssistantInput(
        candidate_id=str(candidate["id"]),
        criteria_id=str(approval["criteria_id"]),
        evidence=evidence,
        missing_fields=[],
        context={
            "workspace_id": getattr(tx, "workspace_id", None),
            "project_id": str(project["id"]),
            "approved_evaluation": approved_evaluation,
            "approval": approval,
            "outcome": outcome,
            "comparison": comparison,
            "comparison_id": comparison_id,
            "citation_catalog": {
                "evidence": [str(item["id"]) for item in evidence],
                "outcome": [outcome_id],
                "comparison": [comparison_id],
            },
        },
    )
    return snapshot, outcome_id


def current_fingerprint(tx: Tx, snapshot: PreparedAssistantRun) -> str:
    """Rebuild the same logical input from current state for job/adoption freshness checks."""

    current = prepare(
        tx,
        snapshot.actor_id,
        snapshot.candidate_id,
        snapshot.node_kind,
        outcome_id=snapshot.outcome_id,
    )
    return current.input_hash


def project_run(tx: Tx, run: dict[str, Any]) -> dict[str, Any]:
    """Return current freshness without updating immutable historical output.

    Reading material must not require impersonating the original analyst: a
    decision owner or contributor can inspect the same workspace's draft.
    Command paths still enforce their own role checks.
    """
    if run.get("is_simulated") is not False:
        return dict(run)
    reasons: list[str] = []
    latest_hash: str | None = None
    try:
        before = PreparedAssistantRun.model_validate(run.get("prepared"))
        if before.candidate_id != run.get("candidate_id"):
            raise ValueError("draft candidate mismatch")
        after = _prepare_input(
            tx, before.actor_id, before.candidate_id, before.node_kind, before.outcome_id
        )
        latest_hash = after.input_hash
        old = before.input_snapshot
        new = after.input_snapshot
        if old.criteria_id != new.criteria_id or old.context.get("criteria") != new.context.get(
            "criteria"
        ):
            reasons.append("项目标准已更新，请按当前标准重新整理")
        if old.evidence != new.evidence:
            reasons.append("证据已新增、修订或替代，请重新核对引用")
        if before.node_kind is not NodeKind.OUTCOME_REVIEW and run.get("created_at"):
            created_at = datetime.fromisoformat(str(run["created_at"]).replace("Z", "+00:00"))
            if any(
                item.get("valid_until")
                and created_at
                <= datetime.fromisoformat(str(item["valid_until"]).replace("Z", "+00:00"))
                < tx.now
                for item in old.evidence
            ):
                reasons.append("草稿引用的材料已到期，请补充有效材料后重新整理")
        if old.context.get("screening") != new.context.get("screening"):
            reasons.append("材料有效性或初筛依据已变化，可能有材料到期或覆盖规则变更")
        if old.context.get("current_questions") != new.context.get("current_questions"):
            reasons.append("人审问题已变化，请结合最新退回意见重新整理")
        if before.node_kind is NodeKind.OUTCOME_REVIEW:
            if old.context.get("approval") != new.context.get("approval"):
                reasons.append("批准依据已变化，请按对应批准轮次重新整理")
            if any(
                old.context.get(key) != new.context.get(key)
                for key in ("outcome", "comparison", "approved_evaluation")
            ):
                reasons.append("所选结果或批准评估的对照依据已变化")
        if latest_hash != before.input_hash and not reasons:
            reasons.append("整理依据已变化，请重新整理")
        if run.get("is_stale") and not reasons:
            reasons.append("该草稿生成时已失效，请使用当前材料重新整理")
    except (DomainError, ValueError, TypeError, KeyError):
        reasons.append("无法核验该草稿的原始依据，请重新整理")
    stale = bool(reasons)
    return {
        **run,
        "current_input_hash": latest_hash,
        "is_stale": stale,
        "stale_reasons": reasons,
        "adoption_status": "STALE" if stale else "PENDING_REVIEW",
    }


def persist_result(
    tx: Tx,
    snapshot: PreparedAssistantRun,
    provider_result: ProviderResult,
) -> dict[str, Any]:
    """Append a reviewable draft; never save an evaluation or mutate candidate state."""

    if provider_result.output.node_kind is not snapshot.node_kind:
        raise DomainError(
            "ASSISTANT_NODE_MISMATCH", "provider output node kind does not match input"
        )
    if provider_result.output.is_simulated:
        raise DomainError("ASSISTANT_PROVIDER_MISMATCH", "live result cannot be simulated")
    if provider_result.output.model_version != provider_result.provenance.model:
        raise DomainError("ASSISTANT_PROVIDER_MISMATCH", "output model does not match provenance")
    candidate = tx.get(snapshot.candidate_id, "candidate")
    if candidate.get("project_id") != snapshot.project_id:
        raise DomainError("ASSISTANT_INPUT_MISMATCH", "candidate project changed")
    latest_hash = current_fingerprint(tx, snapshot)
    is_stale = latest_hash != snapshot.input_hash
    output_data = provider_result.output.model_dump(mode="json")
    node_run = tx.add(
        "node_run",
        {
            "node_kind": snapshot.node_kind.value,
            "input_hash": snapshot.input_hash,
            "current_input_hash": latest_hash,
            "prepared": snapshot.model_dump(mode="json"),
            "run_state": "SUCCEEDED",
            "attempt_state": "SUCCEEDED",
            "actor_id": snapshot.actor_id,
            "provider": provider_result.provenance.provider,
            "model_version": provider_result.provenance.model,
            "prompt_version": provider_result.provenance.prompt_version,
            "schema_version": provider_result.provenance.schema_version,
            "request_id": provider_result.provenance.request_id,
            "elapsed_ms": provider_result.provenance.elapsed_ms,
            "usage": provider_result.usage.model_dump(mode="json"),
            "is_simulated": False,
            "is_stale": is_stale,
            "adoption_status": "STALE" if is_stale else "PENDING_REVIEW",
            "output": output_data,
        },
        project_id=snapshot.project_id,
        candidate_id=snapshot.candidate_id,
    )
    return {"node_run": node_run, "output": output_data}
