"""Deterministic evidence revision selection and restricted rule evaluation."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from app.core import DomainError

RuleStatus = Literal["PASS", "FAIL", "NEEDS_EVIDENCE"]
ScreeningStatus = Literal["PASS", "NEEDS_EVIDENCE", "EXCLUDED", "OVERRIDDEN"]


def _as_utc(value: str | datetime | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        candidate = value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value
        parsed = datetime.fromisoformat(candidate)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise DomainError("INVALID_DATETIME", "Evidence timestamps require a UTC offset")
    return parsed.astimezone(UTC)


def current_evidence(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return revision-chain heads; independent observations remain side by side."""

    ids = {record["id"] for record in records}
    superseded = {
        supersedes_id
        for record in records
        if (supersedes_id := record.get("supersedes_id")) in ids
    }
    return sorted(
        (record for record in records if record["id"] not in superseded),
        key=lambda item: (str(item.get("observed_at", "")), item["id"]),
    )


def _fingerprint(record: dict[str, Any]) -> tuple[Any, ...]:
    return (
        record.get("value"),
        record.get("unit"),
        record.get("currency"),
        record.get("window"),
    )


def evidence_quality(
    records: list[dict[str, Any]],
    *,
    now: datetime,
    unit: str | None = None,
    currency: str | None = None,
) -> tuple[str, dict[str, Any] | None, list[str]]:
    """Classify current evidence and choose an eligible fact without guessing."""

    heads = current_evidence(records)
    evidence_ids = [item["id"] for item in heads]
    if not heads or all(item.get("value") is None for item in heads):
        return "MISSING", None, evidence_ids
    if any(item.get("verification") == "CONFLICT" for item in heads):
        return "CONFLICT", None, evidence_ids
    non_missing = [item for item in heads if item.get("value") is not None]
    if len({_fingerprint(item) for item in non_missing}) > 1:
        return "CONFLICT", None, evidence_ids

    eligible: list[dict[str, Any]] = []
    reasons: set[str] = set()
    for item in non_missing:
        if item.get("epistemic_kind") != "FACT":
            reasons.add(str(item.get("epistemic_kind", "UNKNOWN")))
            continue
        if item.get("verification") != "VERIFIED":
            reasons.add("UNVERIFIED")
            continue
        valid_until = _as_utc(item.get("valid_until"))
        if valid_until is not None and valid_until < now.astimezone(UTC):
            reasons.add("EXPIRED")
            continue
        if unit is not None and item.get("unit") != unit:
            reasons.add("UNIT_MISMATCH")
            continue
        if currency is not None and item.get("currency") != currency:
            reasons.add("CURRENCY_MISMATCH")
            continue
        eligible.append(item)
    if not eligible:
        order = [
            "EXPIRED",
            "CONFLICT",
            "UNIT_MISMATCH",
            "CURRENCY_MISMATCH",
            "UNVERIFIED",
            "ESTIMATE",
            "ASSUMPTION",
            "UNKNOWN",
        ]
        reason = next((candidate for candidate in order if candidate in reasons), "INELIGIBLE")
        return reason, None, evidence_ids
    selected = max(
        eligible,
        key=lambda item: (str(item.get("observed_at", "")), item["id"]),
    )
    return "ELIGIBLE", selected, evidence_ids


def eligible_evidence_for_field(
    evidence: list[dict[str, Any]],
    field: str,
    *,
    now: datetime,
    unit: str | None = None,
    currency: str | None = None,
) -> dict[str, Any] | None:
    """Shared lifecycle seam: return only a current eligible fact for ``field``."""

    quality, selected, _ = evidence_quality(
        [item for item in evidence if item.get("field") == field],
        now=now,
        unit=unit,
        currency=currency,
    )
    return selected if quality == "ELIGIBLE" else None


def build_input_hash(
    criteria: dict[str, Any], current_records: list[dict[str, Any]]
) -> str:
    payload = {
        "criteria_id": criteria["id"],
        "evidence": [
            {
                key: record.get(key)
                for key in (
                    "id",
                    "field",
                    "value",
                    "unit",
                    "currency",
                    "window",
                    "observed_at",
                    "valid_until",
                    "epistemic_kind",
                    "verification",
                    "supersedes_id",
                )
            }
            for record in current_records
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def _rule_key(rule: dict[str, Any], index: int) -> str:
    explicit = rule.get("key")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    return f"{index}:{rule['field']}:{rule['operator']}:{rule['threshold']}:{rule['unit']}"


def _compare(value: str, operator: str, threshold: str) -> bool:
    if operator == "eq":
        try:
            left_equal = Decimal(value)
            right_equal = Decimal(threshold)
        except InvalidOperation:
            return value == threshold
        if not left_equal.is_finite() or not right_equal.is_finite():
            raise DomainError("INVALID_RULE_INPUT", "Numeric rules require finite decimal values")
        return left_equal == right_equal
    try:
        left = Decimal(value)
        right = Decimal(threshold)
    except InvalidOperation as exc:
        raise DomainError(
            "INVALID_RULE_INPUT",
            "Numeric rules require decimal evidence and thresholds",
            details={"value": value, "threshold": threshold},
        ) from exc
    if not left.is_finite() or not right.is_finite():
        raise DomainError("INVALID_RULE_INPUT", "Numeric rules require finite decimal values")
    if operator == "lte":
        return left <= right
    if operator == "gte":
        return left >= right
    raise DomainError("UNSUPPORTED_OPERATOR", f"Unsupported rule operator: {operator}")


def evaluate_screening(
    criteria: dict[str, Any],
    evidence: list[dict[str, Any]],
    overrides: list[dict[str, Any]],
    *,
    now: datetime,
) -> dict[str, Any]:
    """Evaluate confirmed criteria against immutable current evidence heads."""

    if not criteria.get("confirmed_at") or not criteria.get("confirmed_by"):
        raise DomainError("CRITERIA_NOT_CONFIRMED", "Hard rules must be confirmed before screening")
    heads = current_evidence(evidence)
    input_hash = build_input_hash(criteria, heads)
    by_field: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in heads:
        by_field[str(record.get("field"))].append(record)

    valid_override_keys = {
        str(item.get("rule_key"))
        for item in overrides
        if item.get("criteria_id") == criteria["id"] and item.get("input_hash") == input_hash
    }
    results: list[dict[str, Any]] = []
    failed_keys: list[str] = []
    unresolved_failed_keys: list[str] = []
    missing_fields: set[str] = set()
    for index, rule in enumerate(criteria.get("rules", [])):
        field = str(rule["field"])
        key = _rule_key(rule, index)
        quality, selected, evidence_ids = evidence_quality(
            by_field[field],
            now=now,
            unit=str(rule["unit"]),
            currency=rule.get("currency"),
        )
        if quality != "ELIGIBLE" or selected is None:
            missing_fields.add(field)
            results.append(
                {
                    "rule_key": key,
                    "field": field,
                    "status": "NEEDS_EVIDENCE",
                    "reason": quality,
                    "evidence_ids": evidence_ids,
                    "observed": None,
                    "threshold": str(rule["threshold"]),
                    "operator": rule["operator"],
                    "unit": rule["unit"],
                    "currency": rule.get("currency"),
                    "overridden": False,
                }
            )
            continue
        passed = _compare(str(selected["value"]), str(rule["operator"]), str(rule["threshold"]))
        overridden = not passed and key in valid_override_keys
        rule_status: RuleStatus = "PASS" if passed else "FAIL"
        if not passed:
            failed_keys.append(key)
            if not overridden:
                unresolved_failed_keys.append(key)
        results.append(
            {
                "rule_key": key,
                "field": field,
                "status": rule_status,
                "reason": "RULE_PASSED" if passed else "RULE_FAILED",
                "evidence_ids": [selected["id"]],
                "observed": str(selected["value"]),
                "threshold": str(rule["threshold"]),
                "operator": rule["operator"],
                "unit": rule["unit"],
                "currency": rule.get("currency"),
                "overridden": overridden,
            }
        )

    for field in criteria.get("required_evidence", []):
        quality, _, _ = evidence_quality(by_field[str(field)], now=now)
        if quality != "ELIGIBLE":
            missing_fields.add(str(field))

    aggregate_status: ScreeningStatus
    if unresolved_failed_keys:
        aggregate_status = "EXCLUDED"
    elif missing_fields:
        aggregate_status = "NEEDS_EVIDENCE"
    elif failed_keys:
        aggregate_status = "OVERRIDDEN"
    else:
        aggregate_status = "PASS"
    return {
        "criteria_id": criteria["id"],
        "input_hash": input_hash,
        "evidence_ids": [item["id"] for item in heads],
        "rule_results": results,
        "missing_fields": sorted(missing_fields),
        "failed_rule_keys": failed_keys,
        "unresolved_failed_rule_keys": unresolved_failed_keys,
        "status": aggregate_status,
    }
