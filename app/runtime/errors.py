"""Generic execution failure taxonomy adapted from d2market runtime/errors.py.

Only the dependency-free Pydantic policy models are carried into this scaffold;
connectors, persistence, and application-specific handling remain out of scope.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_RETRY_DELAY_SECONDS = 86_400


class ErrorCategory(StrEnum):
    TRANSIENT = "TRANSIENT"
    AUTHORIZATION = "AUTHORIZATION"
    CONFIGURATION = "CONFIGURATION"
    DATA_QUALITY = "DATA_QUALITY"
    POLICY_BLOCK = "POLICY_BLOCK"
    PERMANENT = "PERMANENT"


class ErrorFact(StrEnum):
    NETWORK_TIMEOUT = "NETWORK_TIMEOUT"
    RATE_LIMITED = "RATE_LIMITED"
    UPSTREAM_UNAVAILABLE = "UPSTREAM_UNAVAILABLE"
    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"

    CREDENTIAL_EXPIRED = "CREDENTIAL_EXPIRED"
    SCOPE_INSUFFICIENT = "SCOPE_INSUFFICIENT"
    PAID_QUOTA_EXHAUSTED = "PAID_QUOTA_EXHAUSTED"

    INVALID_QUERY = "INVALID_QUERY"
    SCHEMA_INCOMPATIBLE = "SCHEMA_INCOMPATIBLE"

    MISSING_REQUIRED_FIELD = "MISSING_REQUIRED_FIELD"
    CONTENT_ANOMALY = "CONTENT_ANOMALY"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"

    LOGIN_WALL = "LOGIN_WALL"
    CAPTCHA = "CAPTCHA"
    ROBOTS_DENIED = "ROBOTS_DENIED"
    TERMS_RESTRICTED = "TERMS_RESTRICTED"

    RESOURCE_DELETED = "RESOURCE_DELETED"
    ENDPOINT_DEPRECATED = "ENDPOINT_DEPRECATED"


class ErrorAction(StrEnum):
    RETRY_WITH_BACKOFF = "RETRY_WITH_BACKOFF"
    FAIL_RETRY_EXHAUSTED = "FAIL_RETRY_EXHAUSTED"
    WAIT_FOR_OPERATOR = "WAIT_FOR_OPERATOR"
    FAIL_CONFIGURATION = "FAIL_CONFIGURATION"
    QUARANTINE_OR_DEGRADE = "QUARANTINE_OR_DEGRADE"
    STOP_POLICY_BLOCK = "STOP_POLICY_BLOCK"
    TOMBSTONE_OR_MIGRATE = "TOMBSTONE_OR_MIGRATE"


class SourceDisposition(StrEnum):
    RETRY = "RETRY"
    STOPPED = "STOPPED"
    QUARANTINED = "QUARANTINED"
    TOMBSTONED = "TOMBSTONED"


_FACT_CATEGORY: dict[ErrorFact, ErrorCategory] = {
    ErrorFact.NETWORK_TIMEOUT: ErrorCategory.TRANSIENT,
    ErrorFact.RATE_LIMITED: ErrorCategory.TRANSIENT,
    ErrorFact.UPSTREAM_UNAVAILABLE: ErrorCategory.TRANSIENT,
    ErrorFact.MODEL_UNAVAILABLE: ErrorCategory.TRANSIENT,
    ErrorFact.CREDENTIAL_EXPIRED: ErrorCategory.AUTHORIZATION,
    ErrorFact.SCOPE_INSUFFICIENT: ErrorCategory.AUTHORIZATION,
    ErrorFact.PAID_QUOTA_EXHAUSTED: ErrorCategory.AUTHORIZATION,
    ErrorFact.INVALID_QUERY: ErrorCategory.CONFIGURATION,
    ErrorFact.SCHEMA_INCOMPATIBLE: ErrorCategory.CONFIGURATION,
    ErrorFact.MISSING_REQUIRED_FIELD: ErrorCategory.DATA_QUALITY,
    ErrorFact.CONTENT_ANOMALY: ErrorCategory.DATA_QUALITY,
    ErrorFact.INSUFFICIENT_EVIDENCE: ErrorCategory.DATA_QUALITY,
    ErrorFact.LOGIN_WALL: ErrorCategory.POLICY_BLOCK,
    ErrorFact.CAPTCHA: ErrorCategory.POLICY_BLOCK,
    ErrorFact.ROBOTS_DENIED: ErrorCategory.POLICY_BLOCK,
    ErrorFact.TERMS_RESTRICTED: ErrorCategory.POLICY_BLOCK,
    ErrorFact.RESOURCE_DELETED: ErrorCategory.PERMANENT,
    ErrorFact.ENDPOINT_DEPRECATED: ErrorCategory.PERMANENT,
}
_CATEGORY_PRECEDENCE = (
    ErrorCategory.POLICY_BLOCK,
    ErrorCategory.AUTHORIZATION,
    ErrorCategory.CONFIGURATION,
    ErrorCategory.PERMANENT,
    ErrorCategory.DATA_QUALITY,
    ErrorCategory.TRANSIENT,
)


class ExecutionFailure(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    facts: frozenset[ErrorFact] = Field(min_length=1)
    error_code: str = Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)*$",
    )
    error_summary: str = Field(min_length=1, max_length=1024)
    retry_after_seconds: int | None = Field(
        default=None,
        strict=True,
        ge=1,
        le=MAX_RETRY_DELAY_SECONDS,
    )

    @field_validator("error_summary")
    @classmethod
    def validate_error_summary(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("error_summary cannot be blank")
        if any(ord(character) < 32 or ord(character) == 127 for character in normalized):
            raise ValueError("error_summary cannot contain control characters")
        return normalized


class RetryPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    attempt_no: int = Field(strict=True, ge=1)
    max_attempts: int = Field(strict=True, ge=1, le=100)
    base_delay_seconds: int = Field(default=5, strict=True, ge=1, le=3_600)
    max_backoff_seconds: int = Field(default=900, strict=True, ge=1, le=86_400)


@dataclass(frozen=True, slots=True)
class ErrorDecision:
    category: ErrorCategory
    action: ErrorAction
    source_disposition: SourceDisposition
    reason_code: str
    retry_delay_seconds: int | None
    operator_required: bool
    other_sources_may_continue: bool
    bypass_forbidden: bool
    fabricate_output_forbidden: bool


def classify_error(failure: ExecutionFailure) -> ErrorCategory:
    categories = {_FACT_CATEGORY[fact] for fact in failure.facts}
    return next(category for category in _CATEGORY_PRECEDENCE if category in categories)


def decide_error_policy(
    failure: ExecutionFailure,
    retry_policy: RetryPolicy,
) -> ErrorDecision:
    category = classify_error(failure)
    if category is ErrorCategory.TRANSIENT:
        if retry_policy.attempt_no >= retry_policy.max_attempts:
            return ErrorDecision(
                category=category,
                action=ErrorAction.FAIL_RETRY_EXHAUSTED,
                source_disposition=SourceDisposition.STOPPED,
                reason_code="RUNTIME.TRANSIENT_RETRY_EXHAUSTED",
                retry_delay_seconds=None,
                operator_required=False,
                other_sources_may_continue=True,
                bypass_forbidden=False,
                fabricate_output_forbidden=True,
            )
        exponential_delay = retry_policy.base_delay_seconds * 2 ** (retry_policy.attempt_no - 1)
        bounded_backoff = min(
            exponential_delay,
            retry_policy.max_backoff_seconds,
        )
        retry_delay = min(
            MAX_RETRY_DELAY_SECONDS,
            max(bounded_backoff, failure.retry_after_seconds or 0),
        )
        return ErrorDecision(
            category=category,
            action=ErrorAction.RETRY_WITH_BACKOFF,
            source_disposition=SourceDisposition.RETRY,
            reason_code="RUNTIME.TRANSIENT_RETRY",
            retry_delay_seconds=retry_delay,
            operator_required=False,
            other_sources_may_continue=True,
            bypass_forbidden=False,
            fabricate_output_forbidden=True,
        )
    if category is ErrorCategory.AUTHORIZATION:
        return ErrorDecision(
            category=category,
            action=ErrorAction.WAIT_FOR_OPERATOR,
            source_disposition=SourceDisposition.STOPPED,
            reason_code="RUNTIME.AUTHORIZATION_REQUIRED",
            retry_delay_seconds=None,
            operator_required=True,
            other_sources_may_continue=True,
            bypass_forbidden=True,
            fabricate_output_forbidden=True,
        )
    if category is ErrorCategory.CONFIGURATION:
        return ErrorDecision(
            category=category,
            action=ErrorAction.FAIL_CONFIGURATION,
            source_disposition=SourceDisposition.STOPPED,
            reason_code="RUNTIME.CONFIGURATION_INVALID",
            retry_delay_seconds=None,
            operator_required=True,
            other_sources_may_continue=True,
            bypass_forbidden=False,
            fabricate_output_forbidden=True,
        )
    if category is ErrorCategory.DATA_QUALITY:
        return ErrorDecision(
            category=category,
            action=ErrorAction.QUARANTINE_OR_DEGRADE,
            source_disposition=SourceDisposition.QUARANTINED,
            reason_code="RUNTIME.DATA_QUALITY_QUARANTINED",
            retry_delay_seconds=None,
            operator_required=False,
            other_sources_may_continue=True,
            bypass_forbidden=False,
            fabricate_output_forbidden=True,
        )
    if category is ErrorCategory.POLICY_BLOCK:
        return ErrorDecision(
            category=category,
            action=ErrorAction.STOP_POLICY_BLOCK,
            source_disposition=SourceDisposition.STOPPED,
            reason_code="RUNTIME.POLICY_BLOCK",
            retry_delay_seconds=None,
            operator_required=True,
            other_sources_may_continue=True,
            bypass_forbidden=True,
            fabricate_output_forbidden=True,
        )
    return ErrorDecision(
        category=category,
        action=ErrorAction.TOMBSTONE_OR_MIGRATE,
        source_disposition=SourceDisposition.TOMBSTONED,
        reason_code="RUNTIME.PERMANENT_TOMBSTONE",
        retry_delay_seconds=None,
        operator_required=True,
        other_sources_may_continue=True,
        bypass_forbidden=False,
        fabricate_output_forbidden=True,
    )
