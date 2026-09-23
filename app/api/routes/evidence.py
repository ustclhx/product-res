"""Evidence revision, screening, and rule-override routes."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import Field, field_validator, model_validator

from app.api.contracts import normalize_utc
from app.core import Command, DomainError, execute, require_role
from app.evidence.screening import evaluate_screening
from app.persistence.store import Tx

router = APIRouter()


class AddEvidenceCommand(Command):
    field: str = Field(min_length=1, max_length=128)
    value: str | None = None
    unit: str = Field(min_length=1, max_length=64)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    window: str | None = Field(default=None, max_length=128)
    source_locator: str = Field(min_length=1, max_length=1024)
    observed_at: datetime
    valid_until: datetime | None = None
    epistemic_kind: Literal["FACT", "ESTIMATE", "ASSUMPTION"]
    verification: Literal["VERIFIED", "UNVERIFIED", "CONFLICT"]
    supersedes_id: str | None = None
    is_demo: bool = False
    verification_note: str | None = Field(default=None, max_length=2000)

    @field_validator("observed_at", "valid_until")
    @classmethod
    def aware(cls, value: datetime | None) -> datetime | None:
        return normalize_utc(value) if value is not None else None

    @model_validator(mode="after")
    def ordered(self) -> AddEvidenceCommand:
        if self.valid_until is not None and self.valid_until < self.observed_at:
            raise ValueError("valid_until cannot precede observed_at")
        return self


class ScreenCommand(Command):
    pass


class OverrideCommand(Command):
    reason: str = Field(min_length=1, max_length=2000)
    rule_keys: list[str] | None = None


def _context(tx: Tx, candidate_id: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    candidate = tx.get(candidate_id, "candidate")
    project = tx.get(candidate["project_id"], "project")
    criteria_id = project.get("current_criteria_id")
    if not criteria_id:
        raise DomainError("CRITERIA_NOT_CONFIRMED", "项目尚无已确认标准")
    return candidate, project, tx.get(str(criteria_id), "criteria")


def _add_screening(
    tx: Tx,
    *,
    actor: str,
    candidate: dict[str, Any],
    project: dict[str, Any],
    criteria: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    result = evaluate_screening(
        criteria,
        tx.list("evidence", candidate_id=candidate["id"]),
        tx.list("override", candidate_id=candidate["id"]),
        now=tx.now,
    )
    screening = tx.add(
        "screening",
        {**result, "created_by": actor},
        project_id=project["id"],
        candidate_id=candidate["id"],
    )
    candidate = tx.update(
        candidate["id"],
        {"screening_status": result["status"], "current_screening_id": screening["id"]},
    )
    return screening, candidate


@router.post("/candidates/{candidate_id}/evidence")
def add_evidence(
    candidate_id: str, command: AddEvidenceCommand, request: Request
) -> dict[str, Any]:
    def operation(tx: Tx, actor: str) -> dict[str, Any]:
        candidate, project, _ = _context(tx, candidate_id)
        require_role(tx, project, actor, "contributor")
        if tx.mode == "pilot" and command.is_demo:
            raise DomainError("DEMO_EVIDENCE_FORBIDDEN", "试点不能录入演示证据")
        if (
            tx.mode == "pilot"
            and command.verification == "VERIFIED"
            and not command.verification_note
        ):
            raise DomainError("VERIFICATION_NOTE_REQUIRED", "请说明核验依据")
        if command.field == "vehicle_fitment" and command.verification == "VERIFIED":
            raise DomainError(
                "STRUCTURED_FITMENT_REQUIRED",
                "已核验的车型适配请使用车型适配专用表单，记录样品及左右前排检查",
                422,
            )
        lineage: dict[str, Any] = {}
        if command.supersedes_id is not None:
            previous = tx.get(command.supersedes_id, "evidence")
            lineage = {
                key: previous[key]
                for key in ("batch_id", "item_id", "mapping_version", "observation_key")
                if key in previous
            }
            if (
                previous.get("candidate_id") != candidate_id
                or previous.get("field") != command.field
            ):
                raise DomainError(
                    "INVALID_SUPERSEDES",
                    "替代版本必须属于同一候选和字段",
                )
            existing_evidence = tx.list("evidence", candidate_id=candidate_id)
            if any(item.get("supersedes_id") == previous["id"] for item in existing_evidence):
                raise DomainError(
                    "EVIDENCE_REVISION_STALE",
                    "该证据已被新版本替代，请刷新后选择当前版本",
                    409,
                )
        new_evidence = tx.add(
            "evidence",
            {
                **lineage,
                "field": command.field,
                "value": command.value,
                "unit": command.unit,
                "currency": command.currency,
                "window": command.window,
                "source_locator": command.source_locator,
                "observed_at": command.observed_at.isoformat(),
                "valid_until": (
                    command.valid_until.isoformat() if command.valid_until is not None else None
                ),
                "epistemic_kind": command.epistemic_kind,
                "verification": command.verification,
                "supersedes_id": command.supersedes_id,
                "is_demo": command.is_demo,
                "recorded_by": actor,
                "verification_note": command.verification_note,
            },
            project_id=project["id"],
            candidate_id=candidate_id,
        )
        candidate = tx.update(candidate["id"], {"screening_status": "UNCHECKED"})
        return {"evidence": new_evidence, "candidate": candidate}

    return execute(request, command, candidate_id, "evidence.add", operation)


@router.post("/candidates/{candidate_id}/screenings")
def screen_candidate(candidate_id: str, command: ScreenCommand, request: Request) -> dict[str, Any]:
    def operation(tx: Tx, actor: str) -> dict[str, Any]:
        candidate, project, criteria = _context(tx, candidate_id)
        require_role(tx, project, actor, "analyst")
        screening, updated = _add_screening(
            tx,
            actor=actor,
            candidate=candidate,
            project=project,
            criteria=criteria,
        )
        return {"screening": screening, "candidate": updated}

    return execute(request, command, candidate_id, "screening.run", operation)


@router.post("/candidates/{candidate_id}/screening-overrides")
def override_screening(
    candidate_id: str, command: OverrideCommand, request: Request
) -> dict[str, Any]:
    def operation(tx: Tx, actor: str) -> dict[str, Any]:
        candidate, project, criteria = _context(tx, candidate_id)
        require_role(tx, project, actor, "decision")
        evidence = tx.list("evidence", candidate_id=candidate_id)
        existing = tx.list("override", candidate_id=candidate_id)
        before = evaluate_screening(criteria, evidence, existing, now=tx.now)
        failed = set(before["failed_rule_keys"])
        requested = set(command.rule_keys) if command.rule_keys is not None else failed
        if not requested:
            raise DomainError("NO_FAILED_RULE", "当前没有可恢复的规则失败")
        if not requested.issubset(failed):
            raise DomainError(
                "INVALID_OVERRIDE_RULE",
                "只能恢复当前实际失败的规则",
                details={"rule_keys": sorted(requested - failed)},
            )
        matching = {
            str(item.get("rule_key")): item
            for item in existing
            if item.get("criteria_id") == criteria["id"]
            and item.get("input_hash") == before["input_hash"]
        }
        added: list[dict[str, Any]] = []
        for rule_key in sorted(requested):
            current = matching.get(rule_key)
            if current is not None:
                added.append(current)
                continue
            added.append(
                tx.add(
                    "override",
                    {
                        "criteria_id": criteria["id"],
                        "input_hash": before["input_hash"],
                        "rule_key": rule_key,
                        "reason": command.reason,
                        "actor_id": actor,
                    },
                    project_id=project["id"],
                    candidate_id=candidate_id,
                )
            )
        screening, updated = _add_screening(
            tx,
            actor=actor,
            candidate=candidate,
            project=project,
            criteria=criteria,
        )
        return {"overrides": added, "screening": screening, "candidate": updated}

    return execute(request, command, candidate_id, "screening.override", operation)
