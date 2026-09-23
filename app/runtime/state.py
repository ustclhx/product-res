"""Generic execution state transitions adapted from d2market runtime/state.py.

These states describe technical workflow execution only. Product-res business
entities and candidate status are intentionally separate future modules.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Annotated

from pydantic import BaseModel, ConfigDict, StringConstraints, field_validator

_REASON_CODE_PATTERN = r"^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)*$"

type ReasonCode = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=128,
        pattern=_REASON_CODE_PATTERN,
    ),
]
type ErrorSummary = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=1_024),
]


class RunState(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    WAITING = "WAITING"
    SUCCEEDED = "SUCCEEDED"
    PARTIAL_SUCCESS = "PARTIAL_SUCCESS"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class WaitingReason(StrEnum):
    BUDGET_APPROVAL = "BUDGET_APPROVAL"
    HUMAN_GATE = "HUMAN_GATE"
    DEPENDENCY = "DEPENDENCY"
    POLICY = "POLICY"


class NodeAttemptState(StrEnum):
    PENDING = "PENDING"
    LEASED = "LEASED"
    RUNNING = "RUNNING"
    RETRY_WAIT = "RETRY_WAIT"
    SUCCEEDED = "SUCCEEDED"
    SKIPPED = "SKIPPED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


RUN_TRANSITIONS = MappingProxyType(
    {
        RunState.PENDING: frozenset({RunState.RUNNING, RunState.CANCELLED}),
        RunState.RUNNING: frozenset(
            {
                RunState.WAITING,
                RunState.SUCCEEDED,
                RunState.PARTIAL_SUCCESS,
                RunState.FAILED,
                RunState.CANCELLED,
            }
        ),
        RunState.WAITING: frozenset(
            {
                RunState.RUNNING,
                RunState.PARTIAL_SUCCESS,
                RunState.FAILED,
                RunState.CANCELLED,
            }
        ),
        RunState.SUCCEEDED: frozenset(),
        RunState.PARTIAL_SUCCESS: frozenset(),
        RunState.FAILED: frozenset(),
        RunState.CANCELLED: frozenset(),
    }
)

NODE_ATTEMPT_TRANSITIONS = MappingProxyType(
    {
        NodeAttemptState.PENDING: frozenset(
            {
                NodeAttemptState.LEASED,
                NodeAttemptState.SKIPPED,
                NodeAttemptState.CANCELLED,
            }
        ),
        NodeAttemptState.LEASED: frozenset(
            {
                NodeAttemptState.RUNNING,
                NodeAttemptState.PENDING,
                NodeAttemptState.CANCELLED,
            }
        ),
        NodeAttemptState.RUNNING: frozenset(
            {
                NodeAttemptState.RETRY_WAIT,
                NodeAttemptState.SUCCEEDED,
                NodeAttemptState.SKIPPED,
                NodeAttemptState.FAILED,
                NodeAttemptState.CANCELLED,
            }
        ),
        # A retry is a new immutable attempt after backoff; this attempt is complete.
        NodeAttemptState.RETRY_WAIT: frozenset(),
        NodeAttemptState.SUCCEEDED: frozenset(),
        NodeAttemptState.SKIPPED: frozenset(),
        NodeAttemptState.FAILED: frozenset(),
        NodeAttemptState.CANCELLED: frozenset(),
    }
)

RUN_TERMINAL_STATES = frozenset(
    {
        RunState.SUCCEEDED,
        RunState.PARTIAL_SUCCESS,
        RunState.FAILED,
        RunState.CANCELLED,
    }
)
NODE_ATTEMPT_TERMINAL_STATES = frozenset(
    {
        NodeAttemptState.RETRY_WAIT,
        NodeAttemptState.SUCCEEDED,
        NodeAttemptState.SKIPPED,
        NodeAttemptState.FAILED,
        NodeAttemptState.CANCELLED,
    }
)


class TransitionMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    reason_code: ReasonCode
    error_summary: ErrorSummary

    @field_validator("error_summary")
    @classmethod
    def reject_control_characters(cls, value: str) -> str:
        if any(unicodedata.category(character) == "Cc" for character in value):
            raise ValueError("error_summary cannot contain control characters")
        return value


@dataclass(frozen=True, slots=True)
class RunStateChange:
    from_state: RunState
    to_state: RunState
    metadata: TransitionMetadata


@dataclass(frozen=True, slots=True)
class NodeAttemptStateChange:
    from_state: NodeAttemptState
    to_state: NodeAttemptState
    metadata: TransitionMetadata


class InvalidStateTransition(ValueError):
    def __init__(
        self,
        entity_kind: str,
        from_state: StrEnum,
        to_state: StrEnum,
    ) -> None:
        self.entity_kind = entity_kind
        self.from_state = from_state
        self.to_state = to_state
        super().__init__(
            f"{entity_kind} cannot transition from {from_state.value} to {to_state.value}"
        )


def plan_run_transition(
    from_state: RunState,
    to_state: RunState,
    *,
    reason_code: str,
    error_summary: str,
) -> RunStateChange:
    if not isinstance(from_state, RunState) or not isinstance(to_state, RunState):
        raise TypeError("run transitions require RunState values")
    if to_state not in RUN_TRANSITIONS[from_state]:
        raise InvalidStateTransition("run", from_state, to_state)
    return RunStateChange(
        from_state=from_state,
        to_state=to_state,
        metadata=TransitionMetadata(
            reason_code=reason_code,
            error_summary=error_summary,
        ),
    )


def plan_node_attempt_transition(
    from_state: NodeAttemptState,
    to_state: NodeAttemptState,
    *,
    reason_code: str,
    error_summary: str,
) -> NodeAttemptStateChange:
    if not isinstance(from_state, NodeAttemptState) or not isinstance(
        to_state,
        NodeAttemptState,
    ):
        raise TypeError("node attempt transitions require NodeAttemptState values")
    if to_state not in NODE_ATTEMPT_TRANSITIONS[from_state]:
        raise InvalidStateTransition("node_attempt", from_state, to_state)
    return NodeAttemptStateChange(
        from_state=from_state,
        to_state=to_state,
        metadata=TransitionMetadata(
            reason_code=reason_code,
            error_summary=error_summary,
        ),
    )
