"""Selection project drafts, channel templates, and immutable criteria revisions."""

from __future__ import annotations

import copy
import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import Field, model_validator

from app.api.contracts import APIModel
from app.core import ACTORS, Command, DomainError, require_role
from app.persistence.store import Tx
from app.pilot.context import current_identity, current_member_roles

Channel = Literal["AMAZON", "EBAY", "DTC"]
RuleOperator = Literal["lte", "gte", "eq"]

_TEMPLATE_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "demo" / "templates"
_CHANNEL_TEMPLATE = {
    "AMAZON": "amazon-camping-v1",
    "EBAY": "ebay-camping-v1",
    "DTC": "dtc-camping-v1",
}
_ACTOR_ROLES = {actor["id"]: actor["role"] for actor in ACTORS}
EvidenceField = Annotated[str, Field(min_length=1, max_length=100)]
Currency = Annotated[str, Field(pattern=r"^[A-Z]{3}$")]


class CriteriaRule(APIModel):
    field: str = Field(min_length=1, max_length=100)
    operator: RuleOperator
    threshold: str = Field(min_length=1, max_length=100)
    unit: str = Field(min_length=1, max_length=50)
    currency: Currency | None = None

    @model_validator(mode="after")
    def finite_threshold(self) -> CriteriaRule:
        try:
            number = Decimal(self.threshold)
        except InvalidOperation as exc:
            if self.operator == "eq":
                return self
            raise ValueError("数量比较规则必须使用有效数字阈值") from exc
        if not number.is_finite():
            raise ValueError("规则阈值必须是有限数值")
        return self


class CreateProjectCommand(Command):
    name: str = Field(min_length=1, max_length=200)
    channel: Channel
    market: str = Field(min_length=1, max_length=80)
    direction: str = Field(default="户外露营", min_length=1, max_length=200)
    goal: str = Field(min_length=1, max_length=2_000)
    constraints: list[str] = Field(default_factory=list, max_length=50)
    analyst_id: str | None = None
    decision_owner_id: str | None = None
    default_due_days: int = Field(default=7, ge=1, le=365)
    source_feedback_id: str | None = None


class UpdateProjectCommand(Command):
    analyst_id: str | None = None
    decision_owner_id: str | None = None
    default_due_days: int | None = Field(default=None, ge=1, le=365)

    @model_validator(mode="after")
    def _has_change(self) -> UpdateProjectCommand:
        if not self.model_fields_set.intersection(
            {"analyst_id", "decision_owner_id", "default_due_days"}
        ):
            raise ValueError("at least one owner or deadline field must be supplied")
        return self


class ConfirmCriteriaCommand(Command):
    template_id: str = Field(min_length=1, max_length=100)
    template_version: str = Field(min_length=1, max_length=50)
    # A first-pass research standard may intentionally have no hard gates;
    # required_evidence remains mandatory so the project still has a concrete
    # evidence collection scope.
    rules: list[CriteriaRule] = Field(max_length=100)
    required_evidence: list[EvidenceField] = Field(min_length=1, max_length=100)
    parent_revision_id: str | None = None


def _load_templates() -> list[dict[str, Any]]:
    templates: list[dict[str, Any]] = []
    for path in sorted(_TEMPLATE_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise RuntimeError(f"invalid project template: {path}")
        templates.append(data)
    return templates


def list_templates() -> list[dict[str, Any]]:
    """Return fresh dictionaries so callers cannot mutate process-global state."""

    return copy.deepcopy(_load_templates())


def get_template(template_id: str) -> dict[str, Any]:
    for template in _load_templates():
        if template["id"] == template_id:
            return template
    raise DomainError("TEMPLATE_NOT_FOUND", "未找到指定的渠道模板", 404)


def _validate_actor_reference(actor_id: str | None, field: str) -> None:
    identity = current_identity()
    actor_roles = current_member_roles() if identity is not None else _ACTOR_ROLES
    if actor_id is not None and actor_id not in actor_roles:
        raise DomainError(
            "ACTOR_NOT_FOUND", "负责人不存在", 422, {"field": field, "actor_id": actor_id}
        )
    required_role = {"analyst_id": "analyst", "decision_owner_id": "decision"}.get(field)
    if actor_id is not None and required_role and actor_roles[actor_id] != required_role:
        raise DomainError(
            "ROLE_ASSIGNMENT_INVALID",
            "负责人角色与项目职责不匹配",
            422,
            {"field": field, "actor_id": actor_id, "required_role": required_role},
        )


def _criteria_payload_from_template(template: dict[str, Any]) -> dict[str, Any]:
    return {
        "rules": [
            {
                "field": rule["field"],
                "operator": rule["operator"],
                "threshold": rule["threshold"],
                "unit": rule["unit"],
                "currency": rule.get("currency"),
            }
            for rule in template["rules"]
        ],
        "required_evidence": list(template["required_evidence"]),
        "template_id": template["id"],
        "template_version": template["version"],
    }


def create_project(tx: Tx, actor_id: str, command: CreateProjectCommand) -> dict[str, Any]:
    """Save a draft; owners are deliberately optional until criteria confirmation."""

    _validate_actor_reference(command.analyst_id, "analyst_id")
    _validate_actor_reference(command.decision_owner_id, "decision_owner_id")

    source_criteria: dict[str, Any] | None = None
    if command.source_feedback_id is not None:
        feedback = tx.get(command.source_feedback_id, "feedback")
        if feedback.get("status") != "CONFIRMED" or not feedback.get("new_criteria_id"):
            raise DomainError("FEEDBACK_NOT_CONFIRMED", "只有已确认的复盘标准可用于新项目", 422)
        if command.decision_owner_id != actor_id:
            raise DomainError("ROLE_NOT_ALLOWED", "应用下一轮标准需要新项目决策负责人确认", 403)
        source_criteria = tx.get(str(feedback["new_criteria_id"]), "criteria")
        source_project = tx.get(str(source_criteria["project_id"]), "project")
        if source_project["channel"] != command.channel:
            raise DomainError(
                "CRITERIA_CHANNEL_MISMATCH",
                "复盘标准与新项目渠道不一致",
                422,
                {"source_channel": source_project["channel"], "channel": command.channel},
            )

    project = tx.add(
        "project",
        {
            "name": command.name.strip(),
            "channel": command.channel,
            "market": command.market.strip(),
            "direction": command.direction.strip(),
            "goal": command.goal.strip(),
            "constraints": [item.strip() for item in command.constraints if item.strip()],
            "analyst_id": command.analyst_id,
            "decision_owner_id": command.decision_owner_id,
            "default_due_days": command.default_due_days,
            "current_criteria_id": None,
            "source_feedback_id": command.source_feedback_id,
        },
    )

    criteria: dict[str, Any] | None = None
    if source_criteria is not None:
        criteria = tx.add(
            "criteria",
            {
                "rules": source_criteria["rules"],
                "required_evidence": source_criteria["required_evidence"],
                "template_id": source_criteria["template_id"],
                "template_version": source_criteria["template_version"],
                "research_learning": source_criteria.get("research_learning"),
                "confirmed_by": actor_id,
                "confirmed_at": tx.now,
                "parent_revision_id": source_criteria["id"],
                "source_feedback_id": command.source_feedback_id,
            },
            project_id=project["id"],
        )
        project = tx.update(project["id"], {"current_criteria_id": criteria["id"]})
    return {"project": project, "criteria": criteria}


def update_project(
    tx: Tx, actor_id: str, command: UpdateProjectCommand, project_id: str
) -> dict[str, Any]:
    project = tx.get(project_id, "project")
    if project.get("decision_owner_id"):
        require_role(tx, project, actor_id, "decision")
    elif project.get("analyst_id"):
        require_role(tx, project, actor_id, "analyst")
    elif command.analyst_id != actor_id:
        raise DomainError("ROLE_NOT_ALLOWED", "无负责人草稿只能由接任分析人更新", 403)

    changes: dict[str, Any] = {}
    if "analyst_id" in command.model_fields_set:
        _validate_actor_reference(command.analyst_id, "analyst_id")
        changes["analyst_id"] = command.analyst_id
    if "decision_owner_id" in command.model_fields_set:
        _validate_actor_reference(command.decision_owner_id, "decision_owner_id")
        changes["decision_owner_id"] = command.decision_owner_id
    if command.default_due_days is not None:
        changes["default_due_days"] = command.default_due_days
    return {"project": tx.update(project_id, changes)}


def confirm_criteria(
    tx: Tx, actor_id: str, command: ConfirmCriteriaCommand, project_id: str
) -> dict[str, Any]:
    project = tx.get(project_id, "project")
    if not project.get("analyst_id") or not project.get("decision_owner_id"):
        missing = [field for field in ("analyst_id", "decision_owner_id") if not project.get(field)]
        raise DomainError(
            "PROJECT_OWNERS_REQUIRED",
            "确认标准前需指定分析人与决策负责人",
            422,
            {"missing": missing},
        )
    require_role(tx, project, actor_id, "decision")
    template = get_template(command.template_id)
    expected_template = _CHANNEL_TEMPLATE[str(project["channel"])]
    if template["id"] != expected_template or template["channel"] != project["channel"]:
        raise DomainError("TEMPLATE_CHANNEL_MISMATCH", "模板与项目渠道不一致", 422)
    if command.template_version != template["version"]:
        raise DomainError("TEMPLATE_VERSION_MISMATCH", "模板版本已变化，请刷新后重试", 409)
    current_criteria_id = project.get("current_criteria_id")
    if command.parent_revision_id != current_criteria_id:
        raise DomainError(
            "CRITERIA_PARENT_CONFLICT",
            "标准父版本与项目当前版本不一致",
            409,
            {"current_criteria_id": current_criteria_id},
        )

    criteria = tx.add(
        "criteria",
        {
            "rules": [rule.model_dump(mode="json") for rule in command.rules],
            "required_evidence": list(dict.fromkeys(command.required_evidence)),
            "template_id": command.template_id,
            "template_version": command.template_version,
            "confirmed_by": actor_id,
            "confirmed_at": tx.now,
            "parent_revision_id": current_criteria_id,
        },
        project_id=project_id,
    )
    project = tx.update(project_id, {"current_criteria_id": criteria["id"]})

    invalidated: list[str] = []
    for candidate in tx.list("candidate", project_id=project_id):
        submission_id = candidate.get("current_submission_id")
        if candidate.get("business_status") != "IN_REVIEW" or not submission_id:
            continue
        tx.add(
            "submission_invalidation",
            {
                "submission_id": submission_id,
                "previous_criteria_id": current_criteria_id,
                "new_criteria_id": criteria["id"],
                "reason": "项目确认了新标准，需要重新评估并提交",
                "actor_id": "system",
                "invalidated_at": tx.now,
            },
            project_id=project_id,
            candidate_id=candidate["id"],
        )
        tx.update(candidate["id"], {"business_status": "RETURNED"})
        tx.audit(
            "system",
            "submission.invalidated",
            candidate["id"],
            {
                "submission_id": submission_id,
                "previous_criteria_id": current_criteria_id,
                "new_criteria_id": criteria["id"],
            },
        )
        invalidated.append(str(submission_id))

    return {
        "project": project,
        "criteria": criteria,
        "invalidated_submission_ids": invalidated,
    }


def list_projects(tx: Tx) -> list[dict[str, Any]]:
    return tx.list("project")


def get_project_detail(tx: Tx, project_id: str) -> dict[str, Any]:
    project = tx.get(project_id, "project")
    return {
        "project": project,
        "criteria_versions": tx.list("criteria", project_id=project_id),
        "candidates": tx.list("candidate", project_id=project_id),
    }


def template_defaults(template_id: str) -> dict[str, Any]:
    """Expose the persisted shape for tests and UI form initialization."""

    return _criteria_payload_from_template(get_template(template_id))
