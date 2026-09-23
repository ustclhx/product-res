"""Outcome intake, comparison, review, and feedback routes."""

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import Field, field_validator

from app.api.contracts import normalize_utc
from app.core import Command, execute
from app.outcomes.service import (
    compare_outcome,
    confirm_csv,
    create_research_conclusion,
    create_review,
    decide_feedback,
    finalize_review,
    get_research_closure,
    preview_csv,
    propose_feedback,
    propose_research_feedback,
    record_outcome,
)
from app.persistence.store import Tx

router = APIRouter()


class OutcomeCommand(Command):
    approval_id: str | None = None
    status: Literal["RECORDED", "NOT_LAUNCHED"]
    window_start: datetime | None = None
    window_end: datetime | None = None
    currency: str | None = None
    units: str | None = None
    revenue_basis: Literal["GROSS", "NET"] | None = None
    metrics: dict[str, str | None] = Field(default_factory=dict)
    source_locator: str
    # ``data_origin`` is optional for old demo clients; old records are treated as DEMO.
    data_origin: Literal["REAL", "TEST", "DEMO"] | None = None
    is_demo: bool = False
    reason: str | None = None
    sku: str | None = None
    listing_id: str | None = None
    test_id: str | None = None
    source_revision: str | None = None

    @field_validator("window_start", "window_end", mode="before")
    @classmethod
    def parse_window(cls, value: object) -> object:
        if isinstance(value, str):
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value

    @field_validator("window_start", "window_end")
    @classmethod
    def normalize_window(cls, value: datetime | None) -> datetime | None:
        return normalize_utc(value) if value is not None else None


class CSVPreviewCommand(Command):
    csv_text: str
    mappings: dict[str, dict[str, str]] = Field(default_factory=dict)


class CSVConfirmCommand(CSVPreviewCommand):
    content_hash: str
    selected_rows: list[int]


class ReviewCommand(Command):
    deviation_reasons: list[str]
    notes: str


class FeedbackCommand(Command):
    before_rules: list[dict[str, Any]]
    after_rules: list[dict[str, Any]]
    reason: str
    before_required_evidence: list[str] | None = None
    after_required_evidence: list[str] | None = None
    research_learning: str | None = None


class ResearchConclusionCommand(Command):
    disposition: Literal["STOP", "HOLD"]
    reason: str = Field(min_length=1, max_length=4_000)
    learning: str = Field(min_length=1, max_length=4_000)
    source_locator: str = Field(min_length=1, max_length=2_000)
    data_origin: Literal["REAL", "TEST", "DEMO"]
    evidence_ids: list[str] = Field(min_length=1, max_length=100)
    source_ids: list[str] = Field(default_factory=list, max_length=100)


class RejectFeedbackCommand(Command):
    reason: str


@router.post("/candidates/{candidate_id}/outcomes")
def post_outcome(request: Request, candidate_id: str, command: OutcomeCommand) -> dict[str, object]:
    def operation(tx: Tx, actor_id: str) -> dict[str, object]:
        item, duplicate = record_outcome(
            tx,
            actor_id,
            candidate_id,
            approval_id=command.approval_id,
            status=command.status,
            window_start=command.window_start,
            window_end=command.window_end,
            currency=command.currency,
            units=command.units,
            revenue_basis=command.revenue_basis,
            metrics=command.metrics,
            source_locator=command.source_locator,
            is_demo=command.is_demo,
            data_origin=command.data_origin,
            reason=command.reason,
            sku=command.sku,
            listing_id=command.listing_id,
            test_id=command.test_id,
            source_revision=command.source_revision,
        )
        return {"item": item, "duplicate": duplicate}

    return execute(request, command, candidate_id, "outcome.record", operation)


@router.post("/outcome-imports/preview")
def post_outcome_preview(request: Request, command: CSVPreviewCommand) -> dict[str, object]:
    def operation(tx: Tx, actor_id: str) -> dict[str, object]:
        del actor_id
        return preview_csv(tx, command.csv_text, command.mappings)

    return execute(request, command, None, "outcome.csv.preview", operation)


@router.post("/outcome-imports/confirm")
def post_outcome_confirm(request: Request, command: CSVConfirmCommand) -> dict[str, object]:
    def operation(tx: Tx, actor_id: str) -> dict[str, object]:
        return confirm_csv(
            tx,
            actor_id,
            command.csv_text,
            command.content_hash,
            command.selected_rows,
            command.mappings,
        )

    return execute(request, command, None, "outcome.csv.confirm", operation)


@router.get("/outcomes/{outcome_id}/comparison")
def get_outcome_comparison(request: Request, outcome_id: str) -> dict[str, object]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return compare_outcome(tx, outcome_id)


@router.post("/outcomes/{outcome_id}/reviews")
def post_outcome_review(
    request: Request, outcome_id: str, command: ReviewCommand
) -> dict[str, object]:
    def operation(tx: Tx, actor_id: str) -> dict[str, object]:
        return {
            "item": create_review(
                tx,
                actor_id,
                outcome_id,
                deviation_reasons=command.deviation_reasons,
                notes=command.notes,
            )
        }

    return execute(request, command, outcome_id, "outcome.review", operation)


@router.post("/outcomes/{outcome_id}/feedback-proposals")
def post_feedback(request: Request, outcome_id: str, command: FeedbackCommand) -> dict[str, object]:
    def operation(tx: Tx, actor_id: str) -> dict[str, object]:
        return {
            "item": propose_feedback(
                tx,
                actor_id,
                outcome_id,
                before_rules=command.before_rules,
                after_rules=command.after_rules,
                reason=command.reason,
                before_required_evidence=command.before_required_evidence,
                after_required_evidence=command.after_required_evidence,
                research_learning=command.research_learning,
            )
        }

    return execute(request, command, outcome_id, "feedback.propose", operation)


@router.get("/candidates/{candidate_id}/research")
def get_candidate_research(request: Request, candidate_id: str) -> dict[str, object]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return get_research_closure(tx, candidate_id)


@router.post("/candidates/{candidate_id}/research-conclusions")
def post_research_conclusion(
    request: Request, candidate_id: str, command: ResearchConclusionCommand
) -> dict[str, object]:
    def operation(tx: Tx, actor_id: str) -> dict[str, object]:
        return {
            "item": create_research_conclusion(
                tx,
                actor_id,
                candidate_id,
                disposition=command.disposition,
                reason=command.reason,
                learning=command.learning,
                source_locator=command.source_locator,
                data_origin=command.data_origin,
                evidence_ids=command.evidence_ids,
                source_ids=command.source_ids,
            )
        }

    return execute(request, command, candidate_id, "research.conclude", operation)


@router.post("/research-conclusions/{conclusion_id}/feedback-proposals")
def post_research_feedback(
    request: Request, conclusion_id: str, command: FeedbackCommand
) -> dict[str, object]:
    def operation(tx: Tx, actor_id: str) -> dict[str, object]:
        return {
            "item": propose_research_feedback(
                tx,
                actor_id,
                conclusion_id,
                before_rules=command.before_rules,
                after_rules=command.after_rules,
                reason=command.reason,
                before_required_evidence=command.before_required_evidence,
                after_required_evidence=command.after_required_evidence,
                research_learning=command.research_learning,
            )
        }

    return execute(request, command, conclusion_id, "research.feedback.propose", operation)


@router.post("/feedback-proposals/{feedback_id}/confirm")
def post_feedback_confirm(
    request: Request, feedback_id: str, command: Command
) -> dict[str, object]:
    def operation(tx: Tx, actor_id: str) -> dict[str, object]:
        item, criteria = decide_feedback(tx, actor_id, feedback_id, confirm=True)
        return {"item": item, "criteria": criteria}

    return execute(request, command, feedback_id, "feedback.confirm", operation)


@router.post("/feedback-proposals/{feedback_id}/reject")
def post_feedback_reject(
    request: Request, feedback_id: str, command: RejectFeedbackCommand
) -> dict[str, object]:
    def operation(tx: Tx, actor_id: str) -> dict[str, object]:
        item, _ = decide_feedback(tx, actor_id, feedback_id, confirm=False, reason=command.reason)
        return {"item": item}

    return execute(request, command, feedback_id, "feedback.reject", operation)


@router.post("/candidates/{candidate_id}/finalize-review")
def post_finalize_review(
    request: Request, candidate_id: str, command: Command
) -> dict[str, object]:
    def operation(tx: Tx, actor_id: str) -> dict[str, object]:
        return {"candidate": finalize_review(tx, actor_id, candidate_id)}

    return execute(request, command, candidate_id, "outcome.finalize", operation)
