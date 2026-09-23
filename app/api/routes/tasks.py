"""Validation-task HTTP routes."""

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Query, Request
from pydantic import Field, field_validator

from app.api.contracts import normalize_utc
from app.core import Command, execute
from app.persistence.store import Tx
from app.validation.service import conclude_validation, create_task, list_tasks, transition_task

router = APIRouter()


class CreateTaskCommand(Command):
    type: Literal["EVIDENCE", "QUOTE", "SAMPLE", "TEST"]
    question: str
    owner_id: str
    due_at: datetime
    completion_criteria: str
    expected_metrics: dict[str, str] = Field(default_factory=dict)
    field: str | None = None

    @field_validator("due_at", mode="before")
    @classmethod
    def parse_due_at(cls, value: object) -> object:
        if isinstance(value, str):
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value

    @field_validator("due_at")
    @classmethod
    def normalize_due_at(cls, value: datetime) -> datetime:
        return normalize_utc(value)


class TransitionTaskCommand(Command):
    state: Literal["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"]
    result: str | None = None
    evidence_ids: list[str] = Field(default_factory=list)
    target_met: bool | None = None
    reason: str | None = None


class ValidationConclusionCommand(Command):
    action: Literal["CONTINUE", "FOLLOW_UP", "STOP"]
    reason: str


@router.get("/tasks")
def get_tasks(
    request: Request,
    candidate_id: str | None = None,
    owner_id: str | None = None,
    state: str | None = None,
    overdue: bool | None = Query(default=None),
) -> dict[str, object]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return {
            "items": list_tasks(
                tx,
                candidate_id=candidate_id,
                owner_id=owner_id,
                state=state,
                overdue=overdue,
            )
        }


@router.post("/candidates/{candidate_id}/tasks")
def post_task(request: Request, candidate_id: str, command: CreateTaskCommand) -> dict[str, object]:
    def operation(tx: Tx, actor_id: str) -> dict[str, object]:
        item = create_task(
            tx,
            actor_id,
            candidate_id,
            task_type=command.type,
            question=command.question,
            owner_id=command.owner_id,
            due_at=command.due_at,
            completion_criteria=command.completion_criteria,
            expected_metrics=command.expected_metrics,
            field=command.field,
        )
        return {"item": item}

    return execute(request, command, candidate_id, "task.create", operation)


@router.post("/tasks/{task_id}/transitions")
def post_task_transition(
    request: Request, task_id: str, command: TransitionTaskCommand
) -> dict[str, object]:
    def operation(tx: Tx, actor_id: str) -> dict[str, object]:
        return {
            "item": transition_task(
                tx,
                actor_id,
                task_id,
                state=command.state,
                result=command.result,
                evidence_ids=command.evidence_ids,
                target_met=command.target_met,
                reason=command.reason,
            )
        }

    return execute(request, command, task_id, "task.transition", operation)


@router.post("/candidates/{candidate_id}/validation-conclusions")
def post_validation_conclusion(
    request: Request, candidate_id: str, command: ValidationConclusionCommand
) -> dict[str, object]:
    def operation(tx: Tx, actor_id: str) -> dict[str, object]:
        candidate, conclusion = conclude_validation(
            tx, actor_id, candidate_id, action=command.action, reason=command.reason
        )
        return {"candidate": candidate, "conclusion": conclusion}

    return execute(request, command, candidate_id, "validation.conclude", operation)
