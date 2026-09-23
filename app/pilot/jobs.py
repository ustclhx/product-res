"""Durable, bounded execution of external work.

The workspace ``Store`` is the isolation boundary.  A worker always claims and
finishes work in short transactions; provider I/O happens between them.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from app.core import DomainError
from app.persistence.store import Store, Tx, encode
from app.pilot import usage as model_usage

QUEUED = "QUEUED"
RUNNING = "RUNNING"
SUCCEEDED = "SUCCEEDED"
FAILED = "FAILED"
CANCELLED = "CANCELLED"
OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN"

TERMINAL_STATES = frozenset({SUCCEEDED, FAILED, CANCELLED, OUTCOME_UNKNOWN})
MAX_ATTEMPTS_LIMIT = 5
DEFAULT_LEASE_SECONDS = 60

type Runner = Callable[[dict[str, Any]], Any]
type InputValidator = Callable[[Tx, dict[str, Any]], bool]
type CompletionCallback = Callable[[Tx, dict[str, Any], Any], Any]
type OutputSnapshotSanitizer = Callable[[Any], Any]


@dataclass(eq=False)
class ExternalJobError(Exception):
    """A provider failure whose safe classification may be persisted.

    ``outcome_unknown`` must be true whenever the request may have reached the
    provider and no authoritative response was received.  Such work is never
    automatically retried. ``confirmed_not_sent`` permits a bounded retry only
    when the caller can prove that no external side effect was possible.
    """

    code: str
    safe_message: str
    outcome_unknown: bool = False
    retryable: bool = False
    confirmed_not_sent: bool = False
    diagnostic: Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        super().__init__(self.safe_message)


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("job timestamps must include an explicit UTC offset")
    return value.astimezone(UTC)


def _iso(value: datetime) -> str:
    return _utc(value).isoformat()


def _parse_time(value: object) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return _utc(value)
    if not isinstance(value, str):
        raise ValueError("persisted job timestamp is invalid")
    return _utc(datetime.fromisoformat(value.replace("Z", "+00:00")))


def _snapshot(value: Any) -> Any:
    """Return a detached JSON snapshot using the repository's stable encoding."""

    return json.loads(encode(value))


def snapshot_hash(value: Any) -> str:
    """Calculate the stable digest used to bind a job to its immutable input."""

    return hashlib.sha256(encode(_snapshot(value)).encode()).hexdigest()


def _metadata(value: Any) -> dict[str, Any]:
    encoded = encode(value).encode()
    metadata: dict[str, Any] = {
        "bytes": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
    }
    if isinstance(value, Mapping):
        metadata.update({"type": "object", "keys": sorted(str(key) for key in value)})
    elif isinstance(value, list):
        metadata.update({"type": "array", "items": len(value)})
    else:
        metadata["type"] = type(value).__name__
    return metadata


_SECRET = re.compile(
    r"(?i)(authorization|api[-_ ]?key|secret|token|password|bearer)\s*[:=]\s*[^\s,;]+"
)


def _safe_message(value: str) -> str:
    return _SECRET.sub(r"\1=[redacted]", value.replace("\x00", ""))[:300]


def enqueue(
    tx: Tx,
    actor: str,
    kind: str,
    input_snapshot: Any,
    project_id: str,
    candidate_id: str | None = None,
    dedupe_key: str | None = None,
    *,
    max_attempts: int = 2,
) -> dict[str, Any]:
    """Create a durable job, or replay the same deduplicated command."""

    if not actor or not kind or not project_id:
        raise ValueError("actor, kind and project_id are required")
    if not 1 <= max_attempts <= MAX_ATTEMPTS_LIMIT:
        raise ValueError(f"max_attempts must be between 1 and {MAX_ATTEMPTS_LIMIT}")
    if dedupe_key is not None and (not dedupe_key or len(dedupe_key) > 255):
        raise ValueError("dedupe_key must be 1..255 characters when supplied")

    frozen_input = _snapshot(input_snapshot)
    input_digest = snapshot_hash(frozen_input)
    if dedupe_key is not None:
        for existing in tx.list("job", project_id=project_id, candidate_id=candidate_id):
            if (
                existing.get("candidate_id") != candidate_id
                or existing.get("job_kind") != kind
                or existing.get("dedupe_key") != dedupe_key
            ):
                continue
            if existing.get("input_hash") != input_digest:
                raise DomainError(
                    "JOB_DEDUPE_CONFLICT",
                    "同一任务请求标识不能用于不同输入",
                    409,
                    {"job_id": existing["id"]},
                )
            return existing

    job = tx.add(
        "job",
        {
            "job_kind": kind,
            "actor_id": actor,
            "status": QUEUED,
            "input_snapshot": frozen_input,
            "input_hash": input_digest,
            "input_metadata": _metadata(frozen_input),
            "dedupe_key": dedupe_key,
            "max_attempts": max_attempts,
            "attempt_count": 0,
            "active_attempt_id": None,
            "lease_owner": None,
            "lease_token": None,
            "lease_expires_at": None,
            "cancel_requested_at": None,
            "cancel_requested_by": None,
            "dispatched_at": None,
            "finished_at": None,
            "result_disposition": None,
            "adoptable": False,
            "business_result": None,
            "output_metadata": None,
            "last_error": None,
        },
        project_id=project_id,
        candidate_id=candidate_id,
    )
    tx.audit(actor, "JOB_ENQUEUED", job["id"], {"job_kind": kind, "input_hash": input_digest})
    return job


def _active_attempt(tx: Tx, job: dict[str, Any]) -> dict[str, Any] | None:
    attempt_id = job.get("active_attempt_id")
    if not attempt_id:
        return None
    try:
        return tx.get(str(attempt_id), "job_attempt")
    except DomainError:
        return None


def _attempt_for_token(tx: Tx, job_id: str, lease_token: str) -> dict[str, Any] | None:
    for attempt in tx.list("job_attempt"):
        if attempt.get("job_id") == job_id and attempt.get("lease_token") == lease_token:
            return attempt
    return None


def _clear_lease() -> dict[str, None]:
    return {"lease_owner": None, "lease_token": None, "lease_expires_at": None}


def _cancel_in_tx(tx: Tx, job: dict[str, Any], now: datetime) -> dict[str, Any]:
    attempt = _active_attempt(tx, job)
    if attempt is not None and attempt.get("status") not in {
        "SUCCEEDED",
        "FAILED",
        "CANCELLED",
        "OUTCOME_UNKNOWN",
        "ABANDONED",
    }:
        attempt = tx.update(
            attempt["id"], {"status": "CANCELLED", "finished_at": _iso(now)}
        )
        model_usage.record_receipt(
            tx, job, attempt, outcome_status="cancelled", error_code="CANCELLED"
        )
    return tx.update(
        job["id"],
        {
            "status": CANCELLED,
            "finished_at": _iso(now),
            "adoptable": False,
            "result_disposition": "CANCELLED",
            **_clear_lease(),
        },
    )


def cancel(tx: Tx, actor: str, job_id: str) -> dict[str, Any]:
    """Cancel queued work or request cancellation of an in-flight call."""

    job = tx.get(job_id, "job")
    if job["status"] in TERMINAL_STATES:
        return job
    marked = tx.update(
        job_id,
        {"cancel_requested_at": _iso(tx.now), "cancel_requested_by": actor},
    )
    cancelled = _cancel_in_tx(tx, marked, tx.now)
    tx.audit(actor, "JOB_CANCELLED", job_id)
    return cancelled


def _recover_in_tx(tx: Tx, now: datetime) -> list[dict[str, Any]]:
    recovered: list[dict[str, Any]] = []
    for job in tx.list("job"):
        if job["status"] == QUEUED and job.get("cancel_requested_at"):
            recovered.append(_cancel_in_tx(tx, job, now))
            continue
        if job["status"] != RUNNING:
            continue
        if job.get("cancel_requested_at"):
            recovered.append(_cancel_in_tx(tx, job, now))
            continue
        expires_at = _parse_time(job.get("lease_expires_at"))
        if expires_at is not None and expires_at > now:
            continue

        attempt = _active_attempt(tx, job)
        was_dispatched = bool(job.get("dispatched_at")) or bool(
            attempt and attempt.get("dispatched_at")
        )
        if was_dispatched:
            if attempt is not None:
                attempt = tx.update(
                    attempt["id"],
                    {"status": "OUTCOME_UNKNOWN", "finished_at": _iso(now)},
                )
                model_usage.record_receipt(
                    tx,
                    job,
                    attempt,
                    outcome_status="unknown_error",
                    error_code="LEASE_EXPIRED_AFTER_DISPATCH",
                )
            recovered.append(
                tx.update(
                    job["id"],
                    {
                        "status": OUTCOME_UNKNOWN,
                        "finished_at": _iso(now),
                        "adoptable": False,
                        "result_disposition": "LEASE_EXPIRED_AFTER_DISPATCH",
                        "last_error": {
                            "code": "LEASE_EXPIRED_AFTER_DISPATCH",
                            "message": "外部请求可能已执行，结果无法确认",
                        },
                        **_clear_lease(),
                    },
                )
            )
            continue

        if attempt is not None:
            attempt = tx.update(
                attempt["id"], {"status": "ABANDONED", "finished_at": _iso(now)}
            )
            model_usage.record_receipt(
                tx,
                job,
                attempt,
                outcome_status="rejected_before_send",
                error_code="LEASE_EXPIRED_BEFORE_DISPATCH",
            )
        can_retry = int(job.get("attempt_count", 0)) < int(job.get("max_attempts", 1))
        recovered.append(
            tx.update(
                job["id"],
                {
                    "status": QUEUED if can_retry else FAILED,
                    "active_attempt_id": None if can_retry else job.get("active_attempt_id"),
                    "dispatched_at": None,
                    "finished_at": None if can_retry else _iso(now),
                    "result_disposition": "RETRY_AFTER_UNSENT_LEASE"
                    if can_retry
                    else "ATTEMPTS_EXHAUSTED_BEFORE_DISPATCH",
                    "last_error": None
                    if can_retry
                    else {
                        "code": "ATTEMPTS_EXHAUSTED",
                        "message": "任务在外发前多次中断",
                    },
                    **_clear_lease(),
                },
            )
        )
    return recovered


def recover_leases(store: Store, now: datetime) -> list[dict[str, Any]]:
    """Recover expired claims without resending possibly billed requests."""

    normalized = _utc(now)
    with store.transaction(normalized) as tx:
        return _recover_in_tx(tx, normalized)


def claim(
    store: Store,
    now: datetime,
    *,
    worker_id: str = "worker",
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
) -> dict[str, Any] | None:
    """Atomically claim the oldest queued job and create its mutable attempt."""

    if not worker_id:
        raise ValueError("worker_id is required")
    if lease_seconds <= 0:
        raise ValueError("lease_seconds must be positive")
    normalized = _utc(now)
    with store.transaction(normalized) as tx:
        _recover_in_tx(tx, normalized)
        jobs = tx.list("job")
        if any(item["status"] == RUNNING for item in jobs):
            return None
        job = next((item for item in jobs if item["status"] == QUEUED), None)
        if job is None:
            return None
        if int(job.get("attempt_count", 0)) >= int(job.get("max_attempts", 1)):
            return tx.update(
                job["id"],
                {
                    "status": FAILED,
                    "finished_at": _iso(normalized),
                    "result_disposition": "ATTEMPTS_EXHAUSTED",
                },
            )

        token = str(uuid4())
        number = int(job.get("attempt_count", 0)) + 1
        expires_at = normalized + timedelta(seconds=lease_seconds)
        attempt = tx.add(
            "job_attempt",
            {
                "job_id": job["id"],
                "number": number,
                "status": "CLAIMED",
                "worker_id": worker_id,
                "lease_token": token,
                "claimed_at": _iso(normalized),
                "dispatched_at": None,
                "finished_at": None,
                "result_disposition": None,
                "output_snapshot": None,
                "output_metadata": None,
                "error": None,
            },
            project_id=job.get("project_id"),
            candidate_id=job.get("candidate_id"),
        )
        return tx.update(
            job["id"],
            {
                "status": RUNNING,
                "attempt_count": number,
                "active_attempt_id": attempt["id"],
                "lease_owner": worker_id,
                "lease_token": token,
                "lease_expires_at": _iso(expires_at),
                "dispatched_at": None,
                "finished_at": None,
                "result_disposition": None,
                "last_error": None,
            },
        )


def mark_dispatched(store: Store, job_id: str, lease_token: str, now: datetime) -> dict[str, Any]:
    """Persist dispatch intent immediately before calling the provider."""

    normalized = _utc(now)
    with store.transaction(normalized) as tx:
        job = tx.get(job_id, "job")
        if job["status"] != RUNNING or job.get("lease_token") != lease_token:
            return job
        if job.get("cancel_requested_at"):
            return _cancel_in_tx(tx, job, normalized)
        expires_at = _parse_time(job.get("lease_expires_at"))
        if expires_at is None or expires_at <= normalized:
            _recover_in_tx(tx, normalized)
            return tx.get(job_id, "job")
        attempt = _active_attempt(tx, job)
        if attempt is None:
            raise DomainError("JOB_ATTEMPT_MISSING", "任务执行记录缺失", 409)
        if attempt.get("dispatched_at"):
            return job
        timestamp = _iso(normalized)
        tx.update(attempt["id"], {"status": "DISPATCHED", "dispatched_at": timestamp})
        return tx.update(job_id, {"dispatched_at": timestamp})


def _record_historical_result(
    tx: Tx,
    job: dict[str, Any],
    attempt: dict[str, Any] | None,
    output: Any,
    now: datetime,
    disposition: str,
    *,
    terminalize_running: bool = False,
    output_snapshot_sanitizer: OutputSnapshotSanitizer | None = None,
) -> dict[str, Any]:
    snapshot_output = output_snapshot_sanitizer(output) if output_snapshot_sanitizer else output
    frozen_output = _snapshot(snapshot_output)
    if attempt is not None and attempt.get("output_snapshot") is None:
        attempt_status = attempt.get("status")
        if attempt_status not in {"CANCELLED", "OUTCOME_UNKNOWN", "FAILED", "ABANDONED"}:
            attempt_status = "SUCCEEDED"
        attempt = tx.update(
            attempt["id"],
            {
                "status": attempt_status,
                "finished_at": _iso(now),
                "result_disposition": disposition,
                "output_snapshot": frozen_output,
                "output_metadata": _metadata(frozen_output),
            },
        )
        model_usage.record_receipt(
            tx,
            job,
            attempt,
            diagnostic=model_usage.diagnostic_from_output(output),
            outcome_status="cancelled" if "CANCELLED" in disposition else "stale",
        )
    if terminalize_running and job["status"] == RUNNING:
        terminal = CANCELLED if job.get("cancel_requested_at") else OUTCOME_UNKNOWN
        return tx.update(
            job["id"],
            {
                "status": terminal,
                "finished_at": _iso(now),
                "adoptable": False,
                "result_disposition": disposition,
                "output_metadata": _metadata(frozen_output),
                **_clear_lease(),
            },
        )
    return job


def complete(
    store: Store,
    job_id: str,
    lease_token: str,
    output: Any,
    now: datetime,
    *,
    input_is_current: InputValidator | None = None,
    on_complete: CompletionCallback | None = None,
    output_snapshot_sanitizer: OutputSnapshotSanitizer | None = None,
) -> dict[str, Any]:
    """Persist output and atomically adopt it only while the claim is valid."""

    normalized = _utc(now)
    with store.transaction(normalized) as tx:
        job = tx.get(job_id, "job")
        attempt = _attempt_for_token(tx, job_id, lease_token)
        if job["status"] == SUCCEEDED and job.get("lease_token") is None:
            return job
        if job["status"] != RUNNING or job.get("lease_token") != lease_token:
            disposition = "CANCELLED_LATE" if job["status"] == CANCELLED else "LATE_NONADOPTABLE"
            return _record_historical_result(
                tx,
                job,
                attempt,
                output,
                normalized,
                disposition,
                output_snapshot_sanitizer=output_snapshot_sanitizer,
            )
        if job.get("cancel_requested_at"):
            return _record_historical_result(
                tx,
                job,
                attempt,
                output,
                normalized,
                "CANCELLED_LATE",
                terminalize_running=True,
                output_snapshot_sanitizer=output_snapshot_sanitizer,
            )
        expires_at = _parse_time(job.get("lease_expires_at"))
        if expires_at is None or expires_at <= normalized:
            return _record_historical_result(
                tx,
                job,
                attempt,
                output,
                normalized,
                "LEASE_EXPIRED_LATE",
                terminalize_running=True,
                output_snapshot_sanitizer=output_snapshot_sanitizer,
            )

        snapshot_output = output_snapshot_sanitizer(output) if output_snapshot_sanitizer else output
        frozen_output = _snapshot(snapshot_output)
        if input_is_current is not None and not input_is_current(tx, job):
            if attempt is not None:
                attempt = tx.update(
                    attempt["id"],
                    {
                        "status": "SUCCEEDED",
                        "finished_at": _iso(normalized),
                        "result_disposition": "STALE",
                        "output_snapshot": frozen_output,
                        "output_metadata": _metadata(frozen_output),
                    },
                )
                model_usage.record_receipt(
                    tx,
                    job,
                    attempt,
                    diagnostic=model_usage.diagnostic_from_output(output),
                    outcome_status="stale",
                )
            return tx.update(
                job_id,
                {
                    "status": SUCCEEDED,
                    "finished_at": _iso(normalized),
                    "result_disposition": "STALE",
                    "adoptable": False,
                    "business_result": None,
                    "output_metadata": _metadata(frozen_output),
                    **_clear_lease(),
                },
            )

        callback_output = output if output_snapshot_sanitizer else frozen_output
        business_result = on_complete(tx, job, callback_output) if on_complete else None
        frozen_business_result = _snapshot(business_result)
        if attempt is not None:
            attempt = tx.update(
                attempt["id"],
                {
                    "status": "SUCCEEDED",
                    "finished_at": _iso(normalized),
                    "result_disposition": "ADOPTED",
                    "output_snapshot": frozen_output,
                    "output_metadata": _metadata(frozen_output),
                },
            )
            model_usage.record_receipt(
                tx,
                job,
                attempt,
                diagnostic=model_usage.diagnostic_from_output(output),
                outcome_status="success",
            )
        return tx.update(
            job_id,
            {
                "status": SUCCEEDED,
                "finished_at": _iso(normalized),
                "result_disposition": "ADOPTED",
                "adoptable": True,
                "business_result": frozen_business_result,
                "output_metadata": _metadata(frozen_output),
                **_clear_lease(),
            },
        )


def fail(
    store: Store,
    job_id: str,
    lease_token: str,
    error: ExternalJobError,
    now: datetime,
) -> dict[str, Any]:
    """Record a classified provider failure without unsafe automatic resend."""

    normalized = _utc(now)
    safe_error = {"code": error.code[:80], "message": _safe_message(error.safe_message)}
    with store.transaction(normalized) as tx:
        job = tx.get(job_id, "job")
        attempt = _attempt_for_token(tx, job_id, lease_token)
        if job["status"] != RUNNING or job.get("lease_token") != lease_token:
            model_usage.record_receipt(
                tx,
                job,
                attempt,
                diagnostic=error.diagnostic,
                outcome_status="cancelled" if job["status"] == CANCELLED else "unknown_error",
                error_code=error.code,
            )
            return job
        if job.get("cancel_requested_at"):
            cancelled = _cancel_in_tx(tx, job, normalized)
            if attempt is not None:
                attempt = tx.get(attempt["id"], "job_attempt")
                model_usage.record_receipt(
                    tx,
                    job,
                    attempt,
                    diagnostic=error.diagnostic,
                    outcome_status="cancelled",
                    error_code=error.code,
                )
            return cancelled
        uncertain = error.outcome_unknown
        can_retry = (
            error.retryable
            and error.confirmed_not_sent
            and int(job.get("attempt_count", 0)) < int(job.get("max_attempts", 1))
        )
        attempt_status = (
            "OUTCOME_UNKNOWN" if uncertain else ("RETRYABLE" if can_retry else "FAILED")
        )
        if attempt is not None:
            attempt = tx.update(
                attempt["id"],
                {
                    "status": attempt_status,
                    "finished_at": _iso(normalized),
                    "result_disposition": attempt_status,
                    "error": safe_error,
                },
            )
            model_usage.record_receipt(
                tx,
                job,
                attempt,
                diagnostic=error.diagnostic,
                outcome_status=_usage_outcome(error),
                error_code=error.code,
            )
        next_status = OUTCOME_UNKNOWN if uncertain else (QUEUED if can_retry else FAILED)
        return tx.update(
            job_id,
            {
                "status": next_status,
                "active_attempt_id": None if can_retry else job.get("active_attempt_id"),
                "dispatched_at": None if can_retry else job.get("dispatched_at"),
                "finished_at": None if can_retry else _iso(normalized),
                "result_disposition": attempt_status,
                "adoptable": False,
                "last_error": safe_error,
                **_clear_lease(),
            },
        )


def process_one(
    store: Store,
    runner: Runner,
    *,
    on_complete: CompletionCallback | None = None,
    input_is_current: InputValidator | None = None,
    output_snapshot_sanitizer: OutputSnapshotSanitizer | None = None,
    clock: Callable[[], datetime] | None = None,
    worker_id: str = "worker",
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
) -> dict[str, Any] | None:
    """Claim and process one job, keeping provider I/O outside all transactions."""

    get_now = clock or (lambda: datetime.now(UTC))
    job = claim(store, get_now(), worker_id=worker_id, lease_seconds=lease_seconds)
    if job is None or job["status"] != RUNNING:
        return job
    token = str(job["lease_token"])
    dispatched = mark_dispatched(store, job["id"], token, get_now())
    if dispatched["status"] != RUNNING or dispatched.get("lease_token") != token:
        return dispatched
    try:
        output = runner(dispatched)
    except ExternalJobError as exc:
        return fail(store, job["id"], token, exc, get_now())
    except Exception:
        return fail(
            store,
            job["id"],
            token,
            ExternalJobError(
                "UNCONFIRMED_PROVIDER_FAILURE",
                "外部请求可能已执行，结果无法确认",
                outcome_unknown=True,
            ),
            get_now(),
        )
    try:
        return complete(
            store,
            job["id"],
            token,
            output,
            get_now(),
            input_is_current=input_is_current,
            on_complete=on_complete,
            output_snapshot_sanitizer=output_snapshot_sanitizer,
        )
    except (DomainError, ValueError, TypeError):
        # The response was received, but its business output could not be accepted.
        # Roll back the completion callback and persist a terminal failure instead.
        return fail(
            store,
            job["id"],
            token,
            ExternalJobError(
                "OUTPUT_REJECTED",
                "返回内容未通过业务校验，未写入业务结果",
                diagnostic=model_usage.diagnostic_from_output(output),
            ),
            get_now(),
        )


def _usage_outcome(error: ExternalJobError) -> str:
    code = error.code
    if error.confirmed_not_sent:
        return "rejected_before_send"
    if error.outcome_unknown:
        return "network_error" if code in {"NEWAPI.NETWORK", "NEWAPI.TIMEOUT"} else "unknown_error"
    if code == "NEWAPI.OUTPUT_TRUNCATED":
        return "truncated"
    if code == "NEWAPI.OUTPUT_INVALID" or code == "OUTPUT_REJECTED":
        return "invalid_schema"
    if code == "NEWAPI.CITATION_INVALID":
        return "invalid_reference"
    if code == "NEWAPI.INVALID_RESPONSE":
        return "invalid_json"
    return "provider_error"


def _public_attempt(attempt: dict[str, Any]) -> dict[str, Any]:
    return {
        key: attempt.get(key)
        for key in (
            "id",
            "number",
            "status",
            "worker_id",
            "claimed_at",
            "dispatched_at",
            "finished_at",
            "result_disposition",
            "output_metadata",
            "error",
        )
    }


def _public_value(value: Any) -> Any:
    """Remove credential-shaped fields from callback-owned public metadata."""

    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, item in value.items():
            name = str(key)
            if re.search(r"(?i)(authorization|api.?key|secret|token|password|credential)", name):
                result[name] = "[redacted]"
            else:
                result[name] = _public_value(item)
        return result
    if isinstance(value, list):
        return [_public_value(item) for item in value]
    return value


def public_job(tx: Tx, job: dict[str, Any]) -> dict[str, Any]:
    """Return query-safe job data without input, output, tokens or dedupe keys."""

    attempts = [
        _public_attempt(attempt)
        for attempt in tx.list("job_attempt")
        if attempt.get("job_id") == job["id"]
    ]
    return {
        key: job.get(key)
        for key in (
            "id",
            "version",
            "created_at",
            "project_id",
            "candidate_id",
            "job_kind",
            "actor_id",
            "status",
            "input_hash",
            "input_metadata",
            "max_attempts",
            "attempt_count",
            "cancel_requested_at",
            "dispatched_at",
            "finished_at",
            "result_disposition",
            "adoptable",
            "output_metadata",
            "last_error",
        )
    } | {"business_result": _public_value(job.get("business_result")), "attempts": attempts}


def get_public(tx: Tx, job_id: str) -> dict[str, Any]:
    return public_job(tx, tx.get(job_id, "job"))


def list_public(
    tx: Tx, *, project_id: str | None = None, candidate_id: str | None = None
) -> list[dict[str, Any]]:
    return [
        public_job(tx, job)
        for job in tx.list("job", project_id=project_id, candidate_id=candidate_id)
    ]
