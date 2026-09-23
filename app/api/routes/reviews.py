"""Evaluation, simulated assistant, submission, and review routes."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.api.contracts import normalize_utc
from app.core import Command, execute
from app.providers.assistant import NodeKind
from app.selection.decisions import (
    decide_submission,
    decision_timeline,
    reopen_candidate,
    submit_evaluation,
)
from app.selection.evaluations import create_evaluation, run_assistant

router = APIRouter()


class DimensionInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    summary: str = Field(min_length=1, max_length=4000)
    evidence_ids: list[str] = Field(default_factory=list)


class ForecastMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revenue: str | None
    procurement: str | None
    platform: str | None
    fulfillment: str | None
    advertising: str | None
    refunds: str | None
    other: str | None

    @field_validator("*")
    @classmethod
    def nonnegative_decimal(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            parsed = Decimal(value)
        except InvalidOperation as exc:
            raise ValueError("forecast metrics must be decimal strings") from exc
        if not parsed.is_finite() or parsed < 0:
            raise ValueError("forecast metrics must be finite and non-negative")
        return value


class ForecastInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    window_start: datetime | None = None
    window_end: datetime | None = None
    revenue_basis: Literal["GROSS", "NET"] | None = None
    units: str | None = None
    metrics: ForecastMetrics

    @field_validator("window_start", "window_end")
    @classmethod
    def aware(cls, value: datetime | None) -> datetime | None:
        return normalize_utc(value) if value is not None else None

    @field_validator("units")
    @classmethod
    def nonnegative_units(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            parsed = Decimal(value)
        except InvalidOperation as exc:
            raise ValueError("units must be a decimal string") from exc
        if not parsed.is_finite() or parsed < 0:
            raise ValueError("units must be finite and non-negative")
        return value

    @model_validator(mode="after")
    def ordered_window(self) -> ForecastInput:
        if (
            self.window_start is not None
            and self.window_end is not None
            and self.window_end <= self.window_start
        ):
            raise ValueError("window_end must be later than window_start")
        return self


class EvaluationCommand(Command):
    dimensions: dict[str, DimensionInput]
    evidence_ids: list[str] = Field(default_factory=list)
    unknowns: list[str] = Field(default_factory=list)
    counterevidence: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    forecast: ForecastInput
    assistant_versions: dict[str, str] = Field(default_factory=dict)
    parent_revision_id: str | None = None
    assistant_run_id: str | None = None


class AssistantRunCommand(Command):
    node_kind: NodeKind
    fixture: Literal["default", "invalid_reference", "invalid_structure"] = "default"
    outcome_id: str | None = None


class SubmissionCommand(Command):
    evaluation_id: str | None = None


class DecisionCommand(Command):
    action: Literal["APPROVE", "RETURN", "WATCH", "REJECT"]
    reason: str = Field(min_length=1, max_length=4000)
    questions: list[str] = Field(default_factory=list)


class ReopenCommand(Command):
    reason: str = Field(min_length=1, max_length=4000)


@router.post("/candidates/{candidate_id}/assistant-runs")
def assistant_run(
    candidate_id: str, command: AssistantRunCommand, request: Request
) -> dict[str, Any]:
    if getattr(request.app.state, "settings", None) and request.app.state.settings.mode == "pilot":
        from app.api.routes.pilot import services

        if command.fixture != "default":
            from app.core import DomainError

            raise DomainError("SIMULATION_FORBIDDEN", "试点不运行模拟节点")
        provider_service = services(request)
        return execute(
            request,
            command,
            candidate_id,
            "assistant.live",
            lambda tx, actor: provider_service.enqueue_assistant(
                tx, actor, candidate_id, command.node_kind, command.outcome_id
            ),
        )
    return execute(
        request,
        command,
        candidate_id,
        f"assistant.{command.node_kind.value.lower()}",
        lambda tx, actor: run_assistant(
            tx,
            actor,
            candidate_id,
            node_kind=command.node_kind,
            fixture=command.fixture,
        ),
    )


@router.post("/candidates/{candidate_id}/evaluations")
def add_evaluation(
    candidate_id: str, command: EvaluationCommand, request: Request
) -> dict[str, Any]:
    def operation(tx: Any, actor: str) -> dict[str, Any]:
        versions = dict(command.assistant_versions)
        if tx.mode == "pilot" and versions and not command.assistant_run_id:
            from app.core import DomainError

            raise DomainError("ASSISTANT_RUN_REQUIRED", "模型来源必须关联本候选的有效整理记录")
        if command.assistant_run_id:
            from app.core import DomainError
            from app.selection.live_assistant import (
                PreparedAssistantRun,
                prepare,
                project_run,
            )

            run = tx.get(command.assistant_run_id, "node_run")
            if (
                run.get("candidate_id") != candidate_id
                or run.get("run_state") != "SUCCEEDED"
                or run.get("is_simulated") is not False
                or run.get("node_kind") != "EVALUATION_ORGANIZER"
                or run.get("is_stale")
                or not run.get("prepared")
            ):
                raise DomainError("ASSISTANT_RUN_INVALID", "整理记录不属于当前候选或未完成")
            prepared = PreparedAssistantRun.model_validate(run["prepared"])
            if (
                project_run(tx, run)["is_stale"]
                or prepare(
                    tx, actor, candidate_id, prepared.node_kind, prepared.outcome_id
                ).input_hash != prepared.input_hash
            ):
                raise DomainError("ASSISTANT_STALE", "证据或标准已变化，请重新整理", 409)
            versions = {
                "node_run_id": run["id"],
                "model_version": run["model_version"],
                "prompt_version": run["prompt_version"],
                "schema_version": run["schema_version"],
            }
        return create_evaluation(
            tx,
            actor,
            candidate_id,
            dimensions={
                name: dimension.model_dump(mode="json")
                for name, dimension in command.dimensions.items()
            },
            evidence_ids=command.evidence_ids,
            unknowns=command.unknowns,
            counterevidence=command.counterevidence,
            assumptions=command.assumptions,
            forecast=command.forecast.model_dump(mode="json"),
            assistant_versions=versions,
            parent_revision_id=command.parent_revision_id,
        )

    return execute(
        request,
        command,
        candidate_id,
        "evaluation.add",
        operation,
    )


@router.post("/candidates/{candidate_id}/submissions")
def submit(candidate_id: str, command: SubmissionCommand, request: Request) -> dict[str, Any]:
    return execute(
        request,
        command,
        candidate_id,
        "submission.create",
        lambda tx, actor: submit_evaluation(
            tx, actor, candidate_id, evaluation_id=command.evaluation_id
        ),
    )


@router.post("/candidates/{candidate_id}/decisions")
def decide(candidate_id: str, command: DecisionCommand, request: Request) -> dict[str, Any]:
    return execute(
        request,
        command,
        candidate_id,
        f"decision.{command.action.lower()}",
        lambda tx, actor: decide_submission(
            tx,
            actor,
            candidate_id,
            action=command.action,
            reason=command.reason,
            questions=command.questions,
        ),
    )


@router.post("/candidates/{candidate_id}/reopen")
def reopen(candidate_id: str, command: ReopenCommand, request: Request) -> dict[str, Any]:
    return execute(
        request,
        command,
        candidate_id,
        "decision.reopen",
        lambda tx, actor: reopen_candidate(tx, actor, candidate_id, reason=command.reason),
    )


@router.get("/candidates/{candidate_id}/decision-timeline")
def timeline(candidate_id: str, request: Request) -> dict[str, Any]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return {"items": decision_timeline(tx, candidate_id)}
