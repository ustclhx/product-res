"""Allowlisted per-attempt model usage diagnostics."""

from __future__ import annotations

import csv
import io
from collections.abc import Mapping
from decimal import Decimal, InvalidOperation
from typing import Any

from app.persistence.store import Tx, encode

ITEM_FIELDS = (
    "id",
    "attempt_id",
    "job_id",
    "candidate_id",
    "project_id",
    "node_kind",
    "model",
    "input_bytes",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "elapsed_ms",
    "max_output_tokens",
    "max_total_tokens",
    "finish_reason",
    "request_id",
    "cost",
    "currency",
    "outcome_status",
    "error_code",
    "recorded_at",
)


def _nonnegative_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _short_text(value: Any, limit: int = 256) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = "".join(
        character for character in value if ord(character) >= 32 and ord(character) != 127
    )
    return cleaned[:limit] or None


def _cost(value: Any) -> str | None:
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return None
    try:
        parsed = Decimal(str(value))
    except InvalidOperation:
        return None
    return str(parsed) if parsed.is_finite() and parsed >= 0 else None


def _error_code(value: Any) -> str | None:
    code = _short_text(value, 80)
    if code is None:
        return None
    safe = all(
        character.isascii() and (character.isalnum() or character in "._-")
        for character in code
    )
    if not safe:
        return "UNCLASSIFIED"
    return code


def _currency(value: Any) -> str | None:
    currency = _short_text(value, 16)
    if currency is None or not currency.isascii() or not currency.isalnum():
        return None
    return currency.upper()


def _base_context(job: Mapping[str, Any]) -> dict[str, Any]:
    snapshot = job.get("input_snapshot")
    if not isinstance(snapshot, Mapping):
        return {}
    context = snapshot.get("usage_context")
    if isinstance(context, Mapping):
        return dict(context)
    prepared = snapshot.get("prepared")
    if not isinstance(prepared, Mapping):
        return {}
    input_snapshot = prepared.get("input_snapshot")
    return {
        "node_kind": prepared.get("node_kind"),
        "input_bytes": len(encode(input_snapshot).encode("utf-8")),
    }


def record_receipt(
    tx: Tx,
    job: Mapping[str, Any],
    attempt: Mapping[str, Any] | None,
    *,
    diagnostic: Mapping[str, Any] | None = None,
    outcome_status: str,
    error_code: str | None = None,
) -> dict[str, Any] | None:
    """Create or enrich the single diagnostic receipt for an assistant attempt."""

    if job.get("job_kind") != "assistant" or attempt is None:
        return None
    merged = {**_base_context(job), **dict(diagnostic or {})}
    data = {
        "attempt_id": str(attempt["id"]),
        "job_id": str(job["id"]),
        "node_kind": _short_text(merged.get("node_kind"), 80),
        "model": _short_text(merged.get("model"), 256),
        "input_bytes": _nonnegative_int(merged.get("input_bytes")),
        "input_tokens": _nonnegative_int(merged.get("input_tokens")),
        "output_tokens": _nonnegative_int(merged.get("output_tokens")),
        "total_tokens": _nonnegative_int(merged.get("total_tokens")),
        "elapsed_ms": _nonnegative_int(merged.get("elapsed_ms")),
        "max_output_tokens": _nonnegative_int(merged.get("max_output_tokens")),
        "max_total_tokens": _nonnegative_int(merged.get("max_total_tokens")),
        "finish_reason": _short_text(merged.get("finish_reason"), 80),
        "request_id": _short_text(merged.get("request_id"), 128),
        "cost": _cost(merged.get("cost")),
        "currency": _currency(merged.get("currency")),
        "outcome_status": _short_text(outcome_status, 80) or "unknown_error",
        "error_code": _error_code(error_code),
    }
    existing = next(
        (item for item in tx.list("model_usage") if item.get("attempt_id") == attempt["id"]),
        None,
    )
    if existing is None:
        return tx.add(
            "model_usage",
            data,
            project_id=job.get("project_id"),
            candidate_id=job.get("candidate_id"),
        )
    # A late provider return may fill fields that were unknown when cancellation was recorded.
    changes = {
        key: value
        for key, value in data.items()
        if value is not None or existing.get(key) is None
    }
    return tx.update(str(existing["id"]), changes)


def diagnostic_from_output(output: Any) -> Mapping[str, Any] | None:
    if not isinstance(output, Mapping):
        return None
    value = output.get("diagnostic")
    return value if isinstance(value, Mapping) else None


def _public(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": item.get("id"),
        "attempt_id": item.get("attempt_id"),
        "job_id": item.get("job_id"),
        "candidate_id": item.get("candidate_id"),
        "project_id": item.get("project_id"),
        "node_kind": item.get("node_kind"),
        "model": item.get("model"),
        "input_bytes": item.get("input_bytes"),
        "input_tokens": item.get("input_tokens"),
        "output_tokens": item.get("output_tokens"),
        "total_tokens": item.get("total_tokens"),
        "elapsed_ms": item.get("elapsed_ms"),
        "max_output_tokens": item.get("max_output_tokens"),
        "max_total_tokens": item.get("max_total_tokens"),
        "finish_reason": item.get("finish_reason"),
        "request_id": item.get("request_id"),
        "cost": item.get("cost"),
        "currency": item.get("currency"),
        "outcome_status": item.get("outcome_status"),
        "error_code": item.get("error_code"),
        "recorded_at": item.get("created_at"),
    }


def report(
    tx: Tx, *, project_id: str | None = None, candidate_id: str | None = None
) -> dict[str, Any]:
    receipts = tx.list("model_usage", project_id=project_id, candidate_id=candidate_id)
    items = [_public(item) for item in receipts]
    receipt_attempts = {item["attempt_id"] for item in items}
    matching_jobs = {
        job["id"]
        for job in tx.list("job", project_id=project_id, candidate_id=candidate_id)
        if job.get("job_kind") == "assistant"
    }
    unrecorded = sum(
        1
        for attempt in tx.list("job_attempt", project_id=project_id, candidate_id=candidate_id)
        if attempt.get("job_id") in matching_jobs and attempt["id"] not in receipt_attempts
    )
    known = partial = unknown = 0
    token_fields = ("input_tokens", "output_tokens", "total_tokens")
    for item in items:
        present = sum(item[field] is not None for field in token_fields)
        if present == len(token_fields):
            known += 1
        elif present:
            partial += 1
        else:
            unknown += 1
    costs: dict[str, Decimal] = {}
    for item in items:
        if item["cost"] is None or item["currency"] is None:
            continue
        currency = str(item["currency"]).upper()
        costs[currency] = costs.get(currency, Decimal()) + Decimal(str(item["cost"]))
    summary = {
        "receipt_count": len(items),
        "unrecorded_attempt_count": unrecorded,
        "usage_known_count": known,
        "usage_partial_count": partial,
        "usage_unknown_count": unknown,
        "input_tokens_known_sum": sum(item["input_tokens"] or 0 for item in items),
        "output_tokens_known_sum": sum(item["output_tokens"] or 0 for item in items),
        "total_tokens_known_sum": sum(item["total_tokens"] or 0 for item in items),
        "cost_by_currency": [
            {"currency": currency, "cost": str(costs[currency])}
            for currency in sorted(costs)
        ],
    }
    return {"items": items, "summary": summary}


def _csv_cell(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    if value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def export_csv(items: list[dict[str, Any]]) -> str:
    target = io.StringIO(newline="")
    writer = csv.DictWriter(target, fieldnames=ITEM_FIELDS, extrasaction="ignore")
    writer.writeheader()
    for item in items:
        writer.writerow({key: _csv_cell(item.get(key)) for key in ITEM_FIELDS})
    return "\ufeff" + target.getvalue()
