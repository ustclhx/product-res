"""Deterministic validation-task and validation-conclusion rules."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from app.core import DomainError, require_role
from app.evidence import eligible_evidence_for_field
from app.persistence.store import Tx

TaskType = Literal["EVIDENCE", "QUOTE", "SAMPLE", "TEST"]
TaskState = Literal["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"]
ConclusionAction = Literal["CONTINUE", "FOLLOW_UP", "STOP"]

ACTORS = {"analyst", "owner", "contributor"}
ACTIVE_STATES = {"TODO", "IN_PROGRESS", "BLOCKED"}
TRANSITIONS: dict[str, set[str]] = {
    "TODO": {"IN_PROGRESS", "BLOCKED", "CANCELLED"},
    "IN_PROGRESS": {"BLOCKED", "DONE", "CANCELLED"},
    "BLOCKED": {"IN_PROGRESS", "DONE", "CANCELLED"},
    "DONE": set(),
    "CANCELLED": set(),
}


def _required(value: str | None, field: str) -> str:
    normalized = (value or "").strip()
    if not normalized:
        raise DomainError("VALIDATION_REQUIRED", f"{field} is required", details={"field": field})
    return normalized


def _datetime(value: object) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    else:
        raise DomainError("INVALID_TIMESTAMP", "timestamp is invalid")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise DomainError("INVALID_TIMESTAMP", "timestamp must include an explicit offset")
    return parsed.astimezone(UTC)


def _project_for_candidate(tx: Tx, candidate: dict[str, Any]) -> dict[str, Any]:
    return tx.get(str(candidate["project_id"]), "project")


def _approval(tx: Tx, candidate: dict[str, Any]) -> dict[str, Any]:
    approval_id = candidate.get("approval_id")
    if not approval_id:
        raise DomainError("APPROVAL_REQUIRED", "candidate has no approval", status=422)
    approval = tx.get(str(approval_id), "decision")
    if approval.get("action") != "APPROVE" or approval.get("candidate_id") != candidate["id"]:
        raise DomainError("APPROVAL_REQUIRED", "candidate approval is invalid", status=422)
    return approval


def create_task(
    tx: Tx,
    actor_id: str,
    candidate_id: str,
    *,
    task_type: TaskType,
    question: str,
    owner_id: str,
    due_at: datetime,
    completion_criteria: str,
    expected_metrics: dict[str, str] | None = None,
    field: str | None = None,
) -> dict[str, Any]:
    candidate = tx.get(candidate_id, "candidate")
    project = _project_for_candidate(tx, candidate)
    require_role(tx, project, actor_id, "contributor")
    from app.pilot.context import current_member_roles

    known_actors = current_member_roles() if tx.mode == "pilot" else ACTORS
    if owner_id not in known_actors:
        raise DomainError(
            "OWNER_NOT_FOUND",
            "任务负责人不属于当前工作区",
            details={"owner_id": owner_id},
        )
    due = _datetime(due_at)
    if due <= tx.now:
        raise DomainError("INVALID_DUE_AT", "due_at must be later than the current demo time")
    question = _required(question, "question")
    completion_criteria = _required(completion_criteria, "completion_criteria")
    approval_id: str | None = None
    if task_type == "EVIDENCE":
        field = _required(field, "field")
    else:
        approval = _approval(tx, candidate)
        if candidate.get("business_status") != "VALIDATING":
            raise DomainError(
                "INVALID_CANDIDATE_STATE", "validation tasks require a validating candidate"
            )
        if not expected_metrics:
            raise DomainError(
                "EXPECTED_METRICS_REQUIRED",
                "quote, sample, and test tasks require expected_metrics",
            )
        approval_id = str(approval["id"])
        field = None
    return tx.add(
        "task",
        {
            "type": task_type,
            "question": question,
            "owner_id": owner_id,
            "due_at": due.isoformat().replace("+00:00", "Z"),
            "completion_criteria": completion_criteria,
            "expected_metrics": expected_metrics or {},
            "approval_id": approval_id,
            "state": "TODO",
            "result": None,
            "evidence_ids": [],
            "target_met": None,
            "reason": None,
            "field": field,
        },
        project_id=str(candidate["project_id"]),
        candidate_id=candidate_id,
    )


def _valid_evidence(tx: Tx, task: dict[str, Any], evidence_ids: list[str]) -> list[dict[str, Any]]:
    if not evidence_ids:
        raise DomainError(
            "TASK_EVIDENCE_REQUIRED", "completion requires evidence or a result record"
        )
    evidence: list[dict[str, Any]] = []
    for evidence_id in evidence_ids:
        item = tx.get(evidence_id, "evidence")
        if item.get("candidate_id") != task.get("candidate_id"):
            raise DomainError(
                "INVALID_EVIDENCE_REFERENCE",
                "task evidence must belong to the same candidate",
                details={"evidence_id": evidence_id},
            )
        evidence.append(item)
    return evidence


def transition_task(
    tx: Tx,
    actor_id: str,
    task_id: str,
    *,
    state: TaskState,
    result: str | None = None,
    evidence_ids: list[str] | None = None,
    target_met: bool | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    task = tx.get(task_id, "task")
    candidate = tx.get(str(task["candidate_id"]), "candidate")
    project = _project_for_candidate(tx, candidate)
    require_role(tx, project, actor_id, "contributor")
    if actor_id not in {
        str(task["owner_id"]),
        str(project["analyst_id"]),
        str(project["decision_owner_id"]),
    }:
        raise DomainError(
            "ROLE_NOT_ALLOWED",
            "only the task owner or a project owner may update the task",
            status=403,
        )
    current = str(task["state"])
    if state not in TRANSITIONS.get(current, set()):
        raise DomainError(
            "INVALID_TASK_TRANSITION",
            f"cannot move task from {current} to {state}",
            details={"from": current, "to": state},
        )
    normalized_reason = (reason or "").strip() or None
    if state in {"BLOCKED", "CANCELLED"} and not normalized_reason:
        raise DomainError("TASK_REASON_REQUIRED", f"{state.lower()} task requires a reason")
    changes: dict[str, Any] = {"state": state, "reason": normalized_reason}
    if state == "DONE":
        normalized_result = _required(result, "result")
        refs = list(dict.fromkeys(evidence_ids or []))
        evidence = _valid_evidence(tx, task, refs)
        if target_met is None:
            raise DomainError("TARGET_RESULT_REQUIRED", "completion requires target_met")
        if not target_met and not normalized_reason:
            raise DomainError("TASK_REASON_REQUIRED", "a missed target requires a reason")
        if task["type"] == "EVIDENCE":
            selected = eligible_evidence_for_field(evidence, str(task.get("field")), now=tx.now)
            research_material_ready = False
            profile = candidate.get("sourcing_profile") or {}
            if (
                task.get("field")
                in {"procurement_reference_price", "moq_reference", "target_price"}
                and profile.get("product_type") == "OEM"
                and profile.get("stage") == "RESEARCH"
            ):
                from app.sourcing.service import build_workbench

                requirement = next(
                    item
                    for item in build_workbench(tx, candidate["id"])["requirements"]
                    if item["field"] == task["field"]
                )
                research_material_ready = requirement["ready_for_stage"] and any(
                    item["id"] in requirement["evidence_ids"] and item.get("value") is not None
                    for item in evidence
                )
                if research_material_ready:
                    changes["completion_basis"] = "RESEARCH_MATERIAL_ONLY"
            if selected is None and not research_material_ready:
                raise DomainError(
                    "EVIDENCE_REQUIRED",
                    "an evidence task needs current verified evidence for its field",
                    details={"field": task.get("field")},
                )
        changes.update(
            result=normalized_result,
            evidence_ids=refs,
            target_met=target_met,
            completed_at=tx.now.isoformat().replace("+00:00", "Z"),
        )
    return tx.update(task_id, changes)


def task_view(tx: Tx, task: dict[str, Any]) -> dict[str, Any]:
    due_at = _datetime(task["due_at"])
    return {**task, "overdue": task["state"] in ACTIVE_STATES and due_at < tx.now}


def list_tasks(
    tx: Tx,
    *,
    candidate_id: str | None = None,
    owner_id: str | None = None,
    state: str | None = None,
    overdue: bool | None = None,
) -> list[dict[str, Any]]:
    items = [task_view(tx, item) for item in tx.list("task", candidate_id=candidate_id)]
    if owner_id is not None:
        items = [item for item in items if item.get("owner_id") == owner_id]
    if state is not None:
        items = [item for item in items if item.get("state") == state]
    if overdue is not None:
        items = [item for item in items if item["overdue"] is overdue]
    return items


def conclude_validation(
    tx: Tx,
    actor_id: str,
    candidate_id: str,
    *,
    action: ConclusionAction,
    reason: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    candidate = tx.get(candidate_id, "candidate")
    project = _project_for_candidate(tx, candidate)
    require_role(tx, project, actor_id, "decision")
    if candidate.get("business_status") != "VALIDATING":
        raise DomainError("INVALID_CANDIDATE_STATE", "candidate is not in validation")
    approval = _approval(tx, candidate)
    conclusion = tx.add(
        "validation_conclusion",
        {
            "action": action,
            "reason": _required(reason, "reason"),
            "actor_id": actor_id,
            "approval_id": approval["id"],
            "task_ids": [item["id"] for item in tx.list("task", candidate_id=candidate_id)],
        },
        project_id=str(candidate["project_id"]),
        candidate_id=candidate_id,
    )
    if action == "CONTINUE":
        return candidate, conclusion
    candidate = tx.update(candidate_id, {"business_status": "OUTCOME_PENDING"})
    return candidate, conclusion
