"""Submission validity, four human decisions, and traceable reopening."""

from __future__ import annotations

from typing import Any

from app.core import DomainError, require_role
from app.persistence.store import Tx
from app.selection.evaluations import _workspace, evaluation_readiness


def _next_timeline_sequence(tx: Tx, candidate_id: str) -> int:
    return 1 + sum(
        len(tx.list(kind, candidate_id=candidate_id))
        for kind in ("submission", "submission_invalidation", "decision", "reopen")
    )


def submit_evaluation(
    tx: Tx,
    actor: str,
    candidate_id: str,
    *,
    evaluation_id: str | None = None,
) -> dict[str, Any]:
    candidate, project, criteria = _workspace(tx, candidate_id)
    require_role(tx, project, actor, "analyst")
    if candidate.get("business_status") not in {"PREPARING", "RETURNED"}:
        raise DomainError("INVALID_STATE", "仅准备中或已退回的候选可提交")
    selected_id = evaluation_id or candidate.get("current_evaluation_id")
    if not selected_id:
        raise DomainError("EVALUATION_REQUIRED", "请先保存当前评估")
    evaluation = tx.get(str(selected_id), "evaluation")
    if evaluation.get("candidate_id") != candidate_id:
        raise DomainError("INVALID_EVALUATION", "提交的评估不属于当前候选")
    if candidate.get("current_evaluation_id") != evaluation["id"]:
        raise DomainError("INVALID_EVALUATION", "只能提交候选的当前评估版本")
    if candidate.get("business_status") == "RETURNED":
        latest_return = next(
            (
                item
                for item in reversed(tx.list("decision", candidate_id=candidate_id))
                if item.get("action") == "RETURN"
            ),
            None,
        )
        if latest_return is not None and latest_return.get("evaluation_id") == evaluation["id"]:
            raise DomainError(
                "NEW_EVALUATION_REQUIRED",
                "退回后必须保存新的评估版本再提交",
                details={
                    "returned_decision_id": latest_return["id"],
                    "returned_evaluation_id": evaluation["id"],
                    "questions": latest_return.get("questions", []),
                },
            )
    readiness = evaluation_readiness(tx, candidate, criteria, evaluation)
    if not readiness["ready"]:
        raise DomainError(
            "EVIDENCE_REQUIRED",
            "当前评估尚未满足提交条件",
            details={"blockers": readiness["blockers"]},
        )
    submission = tx.add(
        "submission",
        {
            "evaluation_id": evaluation["id"],
            "criteria_id": criteria["id"],
            "input_hash": readiness["screening"]["input_hash"],
            "actor_id": actor,
            "timeline_sequence": _next_timeline_sequence(tx, candidate_id),
        },
        project_id=project["id"],
        candidate_id=candidate_id,
    )
    candidate = tx.update(
        candidate_id,
        {"business_status": "IN_REVIEW", "current_submission_id": submission["id"]},
    )
    return {"submission": submission, "candidate": candidate}


def submission_staleness(
    tx: Tx,
    candidate: dict[str, Any],
    criteria: dict[str, Any],
    submission: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    evaluation = tx.get(str(submission["evaluation_id"]), "evaluation")
    readiness = evaluation_readiness(tx, candidate, criteria, evaluation)
    reasons: list[dict[str, Any]] = []
    if submission.get("criteria_id") != criteria["id"]:
        reasons.append({"code": "CRITERIA_CHANGED", "criteria_id": criteria["id"]})
    if submission.get("input_hash") != readiness["screening"]["input_hash"]:
        reasons.append(
            {"code": "EVIDENCE_CHANGED", "input_hash": readiness["screening"]["input_hash"]}
        )
    if candidate.get("current_evaluation_id") != evaluation["id"]:
        reasons.append(
            {"code": "EVALUATION_CHANGED", "evaluation_id": candidate.get("current_evaluation_id")}
        )
    reasons.extend(readiness["blockers"])
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for reason in reasons:
        marker = repr(sorted(reason.items()))
        if marker not in seen:
            seen.add(marker)
            unique.append(reason)
    return unique, evaluation


def _invalidate_submission(
    tx: Tx,
    *,
    actor: str,
    candidate: dict[str, Any],
    project: dict[str, Any],
    submission: dict[str, Any],
    reasons: list[dict[str, Any]],
) -> None:
    invalidation = tx.add(
        "submission_invalidation",
        {
            "submission_id": submission["id"],
            "evaluation_id": submission["evaluation_id"],
            "criteria_id": submission["criteria_id"],
            "actor_id": actor,
            "reasons": reasons,
            "timeline_sequence": _next_timeline_sequence(tx, candidate["id"]),
        },
        project_id=project["id"],
        candidate_id=candidate["id"],
    )
    updated = tx.update(
        candidate["id"],
        {"business_status": "RETURNED", "current_submission_id": None},
    )
    tx.audit(actor, "submission.invalidated", candidate["id"], {"event_id": invalidation["id"]})
    raise DomainError(
        "SUBMISSION_STALE",
        "提交后标准或证据已变化，请重新评估并提交",
        409,
        {
            "invalidation": invalidation,
            "candidate": updated,
            "reasons": reasons,
        },
        commit=True,
    )


def decide_submission(
    tx: Tx,
    actor: str,
    candidate_id: str,
    *,
    action: str,
    reason: str,
    questions: list[str],
) -> dict[str, Any]:
    candidate, project, criteria = _workspace(tx, candidate_id)
    require_role(tx, project, actor, "decision")
    if not reason.strip():
        raise DomainError("REASON_REQUIRED", "决定必须填写理由")
    if candidate.get("business_status") != "IN_REVIEW":
        raise DomainError("INVALID_STATE", "仅待评审候选可作出决定")
    submission_id = candidate.get("current_submission_id")
    if not submission_id:
        raise DomainError("SUBMISSION_REQUIRED", "当前候选没有有效提交")
    submission = tx.get(str(submission_id), "submission")
    reasons, evaluation = submission_staleness(tx, candidate, criteria, submission)
    if reasons:
        _invalidate_submission(
            tx,
            actor=actor,
            candidate=candidate,
            project=project,
            submission=submission,
            reasons=reasons,
        )
    if action not in {"APPROVE", "RETURN", "WATCH", "REJECT"}:
        raise DomainError("INVALID_DECISION", "未知决定类型")
    cleaned_questions = [item.strip() for item in questions if item.strip()]
    if action == "RETURN" and not cleaned_questions:
        raise DomainError("QUESTIONS_REQUIRED", "退回必须写明需补材料或问题")
    decision = tx.add(
        "decision",
        {
            "action": action,
            "reason": reason.strip(),
            "questions": cleaned_questions,
            "actor_id": actor,
            "evaluation_id": evaluation["id"],
            "criteria_id": criteria["id"],
            "submission_id": submission["id"],
            "timeline_sequence": _next_timeline_sequence(tx, candidate_id),
        },
        project_id=project["id"],
        candidate_id=candidate_id,
    )
    next_status = {
        "APPROVE": "VALIDATING",
        "RETURN": "RETURNED",
        "WATCH": "WATCHING",
        "REJECT": "REJECTED",
    }[action]
    changes: dict[str, Any] = {"business_status": next_status}
    if action == "APPROVE":
        changes["approval_id"] = decision["id"]
    elif action == "RETURN":
        changes["current_submission_id"] = None
    candidate = tx.update(candidate_id, changes)
    result: dict[str, Any] = {"decision": decision, "candidate": candidate}
    if action == "APPROVE":
        obligation = tx.add(
            "obligation",
            {"approval_id": decision["id"], "status": "PENDING"},
            project_id=project["id"],
            candidate_id=candidate_id,
        )
        result["obligation"] = obligation
    return result


def reopen_candidate(
    tx: Tx,
    actor: str,
    candidate_id: str,
    *,
    reason: str,
) -> dict[str, Any]:
    candidate, project, _ = _workspace(tx, candidate_id)
    require_role(tx, project, actor, "decision")
    if not reason.strip():
        raise DomainError("REASON_REQUIRED", "重新打开必须填写理由")
    previous_status = candidate.get("business_status")
    if previous_status not in {"WATCHING", "REJECTED"}:
        raise DomainError("INVALID_STATE", "仅观察中或已否决候选可重新打开")
    event = tx.add(
        "reopen",
        {
            "action": "REOPEN",
            "reason": reason.strip(),
            "actor_id": actor,
            "previous_status": previous_status,
            "previous_submission_id": candidate.get("current_submission_id"),
            "previous_evaluation_id": candidate.get("current_evaluation_id"),
            "timeline_sequence": _next_timeline_sequence(tx, candidate_id),
        },
        project_id=project["id"],
        candidate_id=candidate_id,
    )
    candidate = tx.update(
        candidate_id,
        {
            "business_status": "PREPARING",
            "current_submission_id": None,
            "current_evaluation_id": None,
        },
    )
    return {"reopen": event, "candidate": candidate}


def decision_timeline(tx: Tx, candidate_id: str) -> list[dict[str, Any]]:
    tx.get(candidate_id, "candidate")
    items = [
        *tx.list("submission", candidate_id=candidate_id),
        *tx.list("submission_invalidation", candidate_id=candidate_id),
        *tx.list("decision", candidate_id=candidate_id),
        *tx.list("reopen", candidate_id=candidate_id),
    ]
    return sorted(
        items,
        key=lambda item: (
            int(item.get("timeline_sequence", 0)),
            item["created_at"],
            item["id"],
        ),
    )
