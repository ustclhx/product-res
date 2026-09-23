"""Canonical read-only work items derived from authoritative workflow entities."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

from app.persistence.store import Tx
from app.sourcing.service import build_workbench

ACTIVE_STATES = frozenset({"TODO", "IN_PROGRESS", "BLOCKED"})
OPEN_STATES = ACTIVE_STATES


def _datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _candidate_href(candidate_id: str, **query: str | int | None) -> str:
    parameters = {key: value for key, value in query.items() if value is not None}
    suffix = f"?{urlencode(parameters)}" if parameters else ""
    return f"/candidates/{candidate_id}{suffix}"


def _item(
    *,
    item_id: str,
    kind: str,
    title: str,
    project: dict[str, Any],
    owner_id: str | None,
    assignment_owner_id: str | None,
    state: str,
    reason: str,
    action_label: str,
    href: str,
    candidate: dict[str, Any] | None = None,
    due_at: Any = None,
    overdue: bool = False,
    task_id: str | None = None,
    field: str | None = None,
) -> dict[str, Any]:
    return {
        "id": item_id,
        "kind": kind,
        "title": title,
        "project_id": str(project["id"]),
        "project_name": str(project.get("name") or "未命名项目"),
        "candidate_id": str(candidate["id"]) if candidate is not None else None,
        "candidate_title": str(candidate.get("title") or "未命名候选")
        if candidate is not None
        else None,
        "owner_id": owner_id,
        "assignment_owner_id": assignment_owner_id,
        "state": state,
        "due_at": due_at,
        "overdue": overdue,
        "reason": reason,
        "action_label": action_label,
        "href": href,
        "task_id": task_id,
        "field": field,
    }


def _task_item(
    tx: Tx,
    project: dict[str, Any],
    candidate: dict[str, Any],
    task: dict[str, Any],
) -> dict[str, Any]:
    state = str(task.get("state") or "TODO")
    due_at = task.get("due_at")
    parsed_due = _datetime(due_at)
    overdue = state in ACTIVE_STATES and parsed_due is not None and parsed_due < tx.now
    if state == "DONE":
        reason = str(task.get("result") or "任务已完成")
    elif state == "CANCELLED":
        reason = str(task.get("reason") or "任务已取消")
    elif state == "BLOCKED":
        reason = str(task.get("reason") or "任务受阻，等待处理")
    else:
        reason = str(task.get("completion_criteria") or task.get("question") or "按要求完成任务")
    task_id = str(task["id"])
    candidate_id = str(candidate["id"])
    href = f"/tasks?{urlencode({'candidate_id': candidate_id, 'task_id': task_id})}"
    action_label = "更新任务" if state in ACTIVE_STATES else "查看任务记录"
    if state in ACTIVE_STATES and task.get("type") == "EVIDENCE" and task.get("field"):
        requirement = next(
            (
                item
                for item in build_workbench(tx, candidate_id)["requirements"]
                if item["field"] == task["field"]
            ),
            None,
        )
        if requirement is None or not requirement["ready_for_stage"]:
            href = _candidate_href(
                candidate_id,
                stage="evidence",
                field=str(task["field"]),
                task_id=task_id,
                mode="review" if requirement and requirement["status"] == "UNVERIFIED" else None,
            )
            action_label = (
                "核验资料" if requirement and requirement["status"] == "UNVERIFIED" else "补充资料"
            )
    return _item(
        item_id=f"task:{task_id}",
        kind="TASK",
        title=str(task.get("question") or "候选任务"),
        project=project,
        candidate=candidate,
        owner_id=str(task["owner_id"]) if task.get("owner_id") else None,
        assignment_owner_id=(
            str(project["analyst_id"])
            if not task.get("owner_id") and project.get("analyst_id")
            else None
        ),
        state=state,
        due_at=due_at,
        overdue=overdue,
        reason=reason,
        action_label=action_label,
        href=href,
        task_id=task_id,
        field=str(task["field"]) if task.get("field") else None,
    )


def _requirement_item(
    project: dict[str, Any], candidate: dict[str, Any], requirement: dict[str, Any]
) -> dict[str, Any]:
    field = str(requirement["field"])
    status = str(requirement["status"])
    unverified = status == "UNVERIFIED"
    query: dict[str, str | int | None] = {
        "stage": "evidence",
        "field": field,
        "mode": "review" if unverified else None,
    }
    reason = str(requirement["reason"])
    coordinator = project.get("analyst_id")
    if coordinator and not unverified:
        reason = f"{reason}；可直接补充或由分析负责人分配执行人"
    return _item(
        item_id=f"candidate:{candidate['id']}:evidence:{field}",
        kind="EVIDENCE",
        title=f"{'核验' if unverified else '补齐'}{requirement['label']}",
        project=project,
        candidate=candidate,
        owner_id=str(coordinator) if unverified and coordinator else None,
        assignment_owner_id=str(coordinator) if not unverified and coordinator else None,
        state="BLOCKED" if status == "CONFLICT" else "TODO",
        reason=reason,
        action_label="核验资料" if unverified else "补充资料",
        href=_candidate_href(str(candidate["id"]), **query),
        field=field,
    )


def _derived_candidate_items(
    tx: Tx, project: dict[str, Any], candidate: dict[str, Any]
) -> list[dict[str, Any]]:
    candidate_id = str(candidate["id"])
    conclusions = tx.list("research_conclusion", candidate_id=str(candidate["id"]))
    if conclusions and conclusions[-1].get("disposition") in {"STOP", "HOLD"}:
        proposed = [
            feedback
            for feedback in tx.list("feedback", candidate_id=candidate_id)
            if feedback.get("research_conclusion_id") == conclusions[-1]["id"]
            and feedback.get("status") == "PROPOSED"
        ]
        if proposed:
            return [
                _item(
                    item_id=f"candidate:{candidate_id}:feedback:{proposed[-1]['id']}",
                    kind="FEEDBACK",
                    title="确认研究复盘建议",
                    project=project,
                    candidate=candidate,
                    owner_id=(
                        str(project["decision_owner_id"])
                        if project.get("decision_owner_id")
                        else None
                    ),
                    assignment_owner_id=None,
                    state="TODO",
                    reason="研究已闭合，复盘建议等待决策负责人确认或驳回",
                    action_label="审阅建议",
                    href=_candidate_href(candidate_id, stage="research"),
                )
            ]
        return []

    status = str(candidate.get("business_status") or "PREPARING")
    gaps: list[dict[str, Any]] = []
    if status in {"PREPARING", "RETURNED"}:
        workbench = build_workbench(tx, candidate_id)
        unmet = [
            requirement
            for requirement in workbench["requirements"]
            if requirement["required_now"] and not requirement["ready_for_stage"]
        ]
        gaps = [requirement for requirement in unmet if not requirement["tasks"]]
        if unmet:
            return [_requirement_item(project, candidate, requirement) for requirement in gaps]

    if status in {"PREPARING", "RETURNED"}:
        current_evaluation = candidate.get("current_evaluation_id")
        return [
            _item(
                item_id=f"candidate:{candidate_id}:evaluation",
                kind="EVALUATION",
                title="准备并提交评估",
                project=project,
                candidate=candidate,
                owner_id=str(project["analyst_id"]) if project.get("analyst_id") else None,
                assignment_owner_id=None,
                state="TODO",
                reason=(
                    "已有评估草稿，需确认当前材料后提交"
                    if current_evaluation
                    else "当前阶段材料已齐，需整理评估并提交"
                ),
                action_label="继续评估",
                href=_candidate_href(candidate_id, stage="evaluation"),
            )
        ]
    if status == "IN_REVIEW":
        return [
            _item(
                item_id=f"candidate:{candidate_id}:decision",
                kind="DECISION",
                title="评审决定",
                project=project,
                candidate=candidate,
                owner_id=(
                    str(project["decision_owner_id"]) if project.get("decision_owner_id") else None
                ),
                assignment_owner_id=None,
                state="TODO",
                reason="评估已提交，等待决策负责人审阅",
                action_label="审阅并决定",
                href=_candidate_href(candidate_id, stage="review"),
            )
        ]
    if status == "VALIDATING":
        active_validation = [
            task
            for task in tx.list("task", candidate_id=candidate_id)
            if task.get("state") in ACTIVE_STATES
        ]
        if active_validation:
            return []
        return [
            _item(
                item_id=f"candidate:{candidate_id}:validation-conclusion",
                kind="VALIDATION_CONCLUSION",
                title="记录验证结论",
                project=project,
                candidate=candidate,
                owner_id=(
                    str(project["decision_owner_id"]) if project.get("decision_owner_id") else None
                ),
                assignment_owner_id=None,
                state="TODO",
                reason="验证任务已无待处理项，需由决策负责人记录结论",
                action_label="记录结论",
                href=f"/tasks?{urlencode({'candidate_id': candidate_id, 'conclusion': 1})}",
            )
        ]
    if status != "OUTCOME_PENDING":
        return []

    outcomes = tx.list("outcome", candidate_id=candidate_id)
    if not outcomes:
        return [
            _item(
                item_id=f"candidate:{candidate_id}:outcome",
                kind="OUTCOME",
                title="记录结果",
                project=project,
                candidate=candidate,
                owner_id=str(project["analyst_id"]) if project.get("analyst_id") else None,
                assignment_owner_id=None,
                state="TODO",
                reason="验证已结束，尚未记录经营结果或未上市原因",
                action_label="记录结果",
                href=f"/candidates/{candidate_id}/outcomes",
            )
        ]

    latest = outcomes[-1]
    reviews = [
        review
        for review in tx.list("outcome_review", candidate_id=candidate_id)
        if review.get("outcome_id") == latest["id"] and review.get("status") == "COMPLETED"
    ]
    if latest.get("status") == "RECORDED" and not reviews:
        return [
            _item(
                item_id=f"candidate:{candidate_id}:outcome-review:{latest['id']}",
                kind="OUTCOME_REVIEW",
                title="复核经营结果",
                project=project,
                candidate=candidate,
                owner_id=str(project["analyst_id"]) if project.get("analyst_id") else None,
                assignment_owner_id=None,
                state="TODO",
                reason="已有经营结果，需对照批准时的预测解释偏差",
                action_label="复核结果",
                href=f"/candidates/{candidate_id}/outcomes",
            )
        ]

    proposed_feedback = [
        feedback
        for feedback in tx.list("feedback", candidate_id=candidate_id)
        if feedback.get("outcome_id") == latest["id"] and feedback.get("status") == "PROPOSED"
    ]
    if proposed_feedback:
        return [
            _item(
                item_id=f"candidate:{candidate_id}:feedback:{proposed_feedback[-1]['id']}",
                kind="FEEDBACK",
                title="确认复盘建议",
                project=project,
                candidate=candidate,
                owner_id=(
                    str(project["decision_owner_id"]) if project.get("decision_owner_id") else None
                ),
                assignment_owner_id=None,
                state="TODO",
                reason="复盘建议等待决策负责人确认或驳回",
                action_label="审阅建议",
                href=f"/candidates/{candidate_id}/outcomes",
            )
        ]

    return [
        _item(
            item_id=f"candidate:{candidate_id}:outcome-finalize:{latest['id']}",
            kind="OUTCOME_FINALIZE",
            title="完成结果复盘",
            project=project,
            candidate=candidate,
            owner_id=(
                str(project["decision_owner_id"]) if project.get("decision_owner_id") else None
            ),
            assignment_owner_id=None,
            state="TODO",
            reason="结果资料已记录，等待决策负责人完成本轮复盘",
            action_label="完成复盘",
            href=f"/candidates/{candidate_id}/outcomes",
        )
    ]


def _priority(item: dict[str, Any]) -> tuple[int, str, int, str]:
    return (
        0 if item["overdue"] else 1 if item["state"] in OPEN_STATES else 2,
        str(item["due_at"] or "9999"),
        0 if item["kind"] in {"CRITERIA", "DECISION", "FEEDBACK"} else 1,
        str(item["id"]),
    )


def _updated_at(tx: Tx, project: dict[str, Any]) -> Any:
    row = tx.connection.execute(
        "SELECT MAX(created_at) AS updated_at FROM entities WHERE id=? OR project_id=?",
        (project["id"], project["id"]),
    ).fetchone()
    return row["updated_at"] if row and row["updated_at"] else project["created_at"]


def build_work_items(tx: Tx) -> dict[str, Any]:
    """Project the current workspace without writing state or invoking providers."""

    projects = tx.list("project")
    all_candidates = tx.list("candidate")
    candidates_by_project: dict[str, list[dict[str, Any]]] = {}
    for candidate in all_candidates:
        candidates_by_project.setdefault(str(candidate["project_id"]), []).append(candidate)

    items: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    for project in projects:
        project_id = str(project["id"])
        candidates = candidates_by_project.get(project_id, [])
        project_items: list[dict[str, Any]] = []
        if not project.get("current_criteria_id"):
            decision_owner = project.get("decision_owner_id")
            owners_ready = bool(project.get("analyst_id") and decision_owner)
            project_items.append(
                _item(
                    item_id=f"project:{project_id}:criteria",
                    kind="CRITERIA",
                    title="确认选品标准",
                    project=project,
                    owner_id=str(decision_owner) if decision_owner else None,
                    assignment_owner_id=(
                        str(project["analyst_id"])
                        if not decision_owner and project.get("analyst_id")
                        else None
                    ),
                    state="TODO",
                    reason=(
                        "项目标准尚未确认，确认后才能添加候选"
                        if owners_ready
                        else "确认标准前需先补齐分析人与决策负责人"
                    ),
                    action_label="确认标准" if owners_ready else "补齐负责人",
                    href=(
                        f"/projects/{project_id}?view=criteria"
                        if owners_ready
                        else f"/projects/{project_id}?view=settings"
                    ),
                )
            )
        elif not candidates:
            project_items.append(
                _item(
                    item_id=f"project:{project_id}:candidate-intake",
                    kind="CANDIDATE_INTAKE",
                    title="添加候选",
                    project=project,
                    owner_id=(str(project["analyst_id"]) if project.get("analyst_id") else None),
                    assignment_owner_id=None,
                    state="TODO",
                    reason="标准已确认，候选池仍为空",
                    action_label="添加候选",
                    href=f"/projects/{project_id}?intake=1",
                )
            )

        for candidate in candidates:
            tasks = tx.list("task", candidate_id=str(candidate["id"]))
            project_items.extend(_task_item(tx, project, candidate, task) for task in tasks)
            if project.get("current_criteria_id"):
                project_items.extend(_derived_candidate_items(tx, project, candidate))

        items.extend(project_items)
        open_items = sorted(
            [item for item in project_items if item["state"] in OPEN_STATES], key=_priority
        )
        next_action = open_items[0]["action_label"] if open_items else "查看项目"
        summaries.append(
            {
                "id": project_id,
                "name": str(project.get("name") or "未命名项目"),
                "channel": str(project.get("channel") or ""),
                "market": str(project.get("market") or ""),
                "direction": str(project.get("direction") or ""),
                "analyst_id": (str(project["analyst_id"]) if project.get("analyst_id") else None),
                "decision_owner_id": (
                    str(project["decision_owner_id"]) if project.get("decision_owner_id") else None
                ),
                "current_criteria_id": (
                    str(project["current_criteria_id"])
                    if project.get("current_criteria_id")
                    else None
                ),
                "candidate_count": len(candidates),
                "open_item_count": len(open_items),
                "next_action": next_action,
                "href": f"/projects/{project_id}",
                "updated_at": _updated_at(tx, project),
            }
        )
    items.sort(key=_priority)
    summaries.sort(key=lambda item: str(item["updated_at"]), reverse=True)
    return {"items": items, "projects": summaries, "clock": tx.now.isoformat()}
