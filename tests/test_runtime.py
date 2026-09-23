import pytest
from app.runtime.errors import (
    ErrorAction,
    ErrorCategory,
    ErrorFact,
    ExecutionFailure,
    RetryPolicy,
    decide_error_policy,
)
from app.runtime.state import (
    InvalidStateTransition,
    NodeAttemptState,
    RunState,
    plan_node_attempt_transition,
    plan_run_transition,
)


def test_run_and_node_transitions_keep_execution_states_explicit() -> None:
    run = plan_run_transition(
        RunState.PENDING,
        RunState.RUNNING,
        reason_code="RUN.START",
        error_summary="started",
    )
    node = plan_node_attempt_transition(
        NodeAttemptState.RUNNING,
        NodeAttemptState.RETRY_WAIT,
        reason_code="NODE.RETRY",
        error_summary="temporary upstream failure",
    )

    assert run.to_state is RunState.RUNNING
    assert node.to_state is NodeAttemptState.RETRY_WAIT


def test_terminal_states_reject_further_transitions() -> None:
    with pytest.raises(InvalidStateTransition):
        plan_run_transition(
            RunState.SUCCEEDED,
            RunState.RUNNING,
            reason_code="RUN.REOPEN",
            error_summary="no",
        )
    with pytest.raises(InvalidStateTransition):
        plan_node_attempt_transition(
            NodeAttemptState.RETRY_WAIT,
            NodeAttemptState.RUNNING,
            reason_code="NODE.REOPEN",
            error_summary="no",
        )


def test_transient_error_policy_retries_then_stops_at_terminal_attempt() -> None:
    failure = ExecutionFailure(
        facts=frozenset({ErrorFact.UPSTREAM_UNAVAILABLE}),
        error_code="UPSTREAM.UNAVAILABLE",
        error_summary="upstream unavailable",
    )

    retry = decide_error_policy(failure, RetryPolicy(attempt_no=1, max_attempts=2))
    exhausted = decide_error_policy(failure, RetryPolicy(attempt_no=2, max_attempts=2))

    assert retry.category is ErrorCategory.TRANSIENT
    assert retry.action is ErrorAction.RETRY_WITH_BACKOFF
    assert exhausted.action is ErrorAction.FAIL_RETRY_EXHAUSTED
    assert exhausted.fabricate_output_forbidden
