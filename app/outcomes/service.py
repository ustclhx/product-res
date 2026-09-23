"""Outcome intake, comparable finance calculations, and feedback lifecycle."""

from __future__ import annotations

import csv
import hashlib
import io
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, cast

from pydantic import ValidationError

from app.core import DomainError, require_role
from app.persistence.store import Tx
from app.selection.projects import CriteriaRule

OutcomeStatus = Literal["RECORDED", "NOT_LAUNCHED"]
RevenueBasis = Literal["GROSS", "NET"]
OutcomeOrigin = Literal["REAL", "TEST", "DEMO"]
ResearchDisposition = Literal["STOP", "HOLD"]
METRIC_FIELDS = (
    "revenue",
    "refunds",
    "procurement",
    "platform",
    "fulfillment",
    "advertising",
    "other",
)
CSV_LIMIT = 2 * 1024 * 1024
ROW_LIMIT = 1000
CSV_FIELDS = {
    "approval_id",
    "candidate_id",
    "sku",
    "status",
    "window_start",
    "window_end",
    "currency",
    "units",
    "revenue_basis",
    *METRIC_FIELDS,
    "source_locator",
    "source_revision",
    "data_origin",
    "listing_id",
    "test_id",
    "reason",
    "is_demo",
}


def _required(value: str | None, field: str) -> str:
    normalized = (value or "").strip()
    if not normalized:
        raise DomainError("OUTCOME_REQUIRED", f"{field} is required", details={"field": field})
    return normalized


def _dt(value: datetime | str | None, field: str) -> datetime:
    if value is None:
        raise DomainError("OUTCOME_REQUIRED", f"{field} is required", details={"field": field})
    parsed = (
        value
        if isinstance(value, datetime)
        else datetime.fromisoformat(value.replace("Z", "+00:00"))
    )
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise DomainError("INVALID_TIMESTAMP", f"{field} must include an explicit offset")
    return parsed.astimezone(UTC)


def _decimal(value: str | None, field: str, *, positive: bool = False) -> Decimal | None:
    if value is None or value.strip() == "":
        return None
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise DomainError("INVALID_DECIMAL", f"{field} must be a decimal string") from exc
    if not parsed.is_finite() or parsed < 0 or (positive and parsed == 0):
        comparison = "greater than zero" if positive else "zero or greater"
        raise DomainError("INVALID_DECIMAL", f"{field} must be finite and {comparison}")
    return parsed


def _approval_for_candidate(
    tx: Tx, candidate: dict[str, Any], approval_id: str | None
) -> dict[str, Any]:
    frozen = candidate.get("approval_id")
    if not frozen or (approval_id is not None and approval_id != frozen):
        raise DomainError(
            "APPROVAL_MISMATCH", "outcome must reference the candidate's immutable approval"
        )
    approval = tx.get(str(frozen), "decision")
    if approval.get("action") != "APPROVE" or approval.get("candidate_id") != candidate["id"]:
        raise DomainError("APPROVAL_MISMATCH", "approval does not belong to this candidate")
    tx.get(str(approval["evaluation_id"]), "evaluation")
    return approval


def _origin(data_origin: str | None, is_demo: bool | None) -> OutcomeOrigin:
    """Normalize the new origin field while retaining the old ``is_demo`` API."""
    if data_origin is None:
        return "DEMO"
    normalized = data_origin.strip().upper()
    if normalized not in {"REAL", "TEST", "DEMO"}:
        raise DomainError("INVALID_DATA_ORIGIN", "data_origin must be REAL, TEST, or DEMO")
    if normalized == "REAL" and is_demo:
        raise DomainError("ORIGIN_CONFLICT", "REAL outcomes cannot be marked as demo")
    return cast(OutcomeOrigin, normalized)


def _text(value: str | None) -> str | None:
    return value.strip() if value and value.strip() else None


def outcome_origin(outcome: dict[str, Any]) -> OutcomeOrigin:
    """Return the normalized origin for statistics and workbench consumers."""
    value = outcome.get("data_origin")
    if value in {"REAL", "TEST", "DEMO"}:
        return cast(OutcomeOrigin, value)
    # Legacy rows, including rows that only carry is_demo=False, are demo rows.
    return "DEMO"


def counts_as_real(outcome: dict[str, Any]) -> bool:
    return outcome_origin(outcome) == "REAL"


def _validate_row_values(row: dict[str, str]) -> None:
    status = row.get("status") or "RECORDED"
    if status not in {"RECORDED", "NOT_LAUNCHED"}:
        raise DomainError("INVALID_OUTCOME_STATUS", "status is not supported")
    if row.get("is_demo", "").lower() not in {"", "0", "1", "false", "true", "no", "yes"}:
        raise DomainError("INVALID_BOOLEAN", "is_demo must be true or false")
    if row.get("data_origin") and row["data_origin"].upper() not in {"REAL", "TEST", "DEMO"}:
        raise DomainError("INVALID_DATA_ORIGIN", "data_origin must be REAL, TEST, or DEMO")
    metrics = {name: row.get(name) or None for name in METRIC_FIELDS}
    if status == "NOT_LAUNCHED":
        if not row.get("reason"):
            raise DomainError("OUTCOME_REQUIRED", "reason is required for NOT_LAUNCHED")
        if row.get("units") or any(value is not None for value in metrics.values()):
            raise DomainError(
                "FABRICATED_OUTCOME",
                "not-launched rows must not contain units or financial metrics",
            )
        return
    start = _dt(row.get("window_start") or None, "window_start")
    end = _dt(row.get("window_end") or None, "window_end")
    if end <= start:
        raise DomainError("INVALID_WINDOW", "window_end must be later than window_start")
    currency = row.get("currency", "")
    if len(currency) != 3 or not currency.isalpha():
        raise DomainError("INVALID_CURRENCY", "currency must be a three-letter code")
    if row.get("revenue_basis") not in {"GROSS", "NET"}:
        raise DomainError("OUTCOME_REQUIRED", "revenue_basis is required")
    if _decimal(row.get("units") or None, "units") is None:
        raise DomainError("OUTCOME_REQUIRED", "units is required")
    for name, value in metrics.items():
        _decimal(value, name)


def _duplicate_outcome(
    tx: Tx,
    candidate_id: str,
    approval_id: str,
    status: str,
    window_start: str | None,
    window_end: str | None,
    source_locator: str,
    source_revision: str | None = None,
    data_origin: OutcomeOrigin | None = None,
) -> dict[str, Any] | None:
    for item in tx.list("outcome", candidate_id=candidate_id):
        if (
            item.get("approval_id") == approval_id
            and item.get("status") == status
            and item.get("window_start") == window_start
            and item.get("window_end") == window_end
            and item.get("source_locator") == source_locator
            and item.get("source_revision") == source_revision
            and (data_origin is None or outcome_origin(item) == data_origin)
        ):
            return item
    return None


def record_outcome(
    tx: Tx,
    actor_id: str,
    candidate_id: str,
    *,
    approval_id: str | None,
    status: OutcomeStatus,
    window_start: datetime | str | None,
    window_end: datetime | str | None,
    currency: str | None,
    units: str | None,
    revenue_basis: RevenueBasis | None,
    metrics: dict[str, str | None] | None,
    source_locator: str,
    is_demo: bool,
    reason: str | None,
    sku: str | None,
    data_origin: str | None = None,
    listing_id: str | None = None,
    test_id: str | None = None,
    source_revision: str | None = None,
) -> tuple[dict[str, Any], bool]:
    candidate = tx.get(candidate_id, "candidate")
    project = tx.get(str(candidate["project_id"]), "project")
    require_role(tx, project, actor_id, "contributor")
    approval = _approval_for_candidate(tx, candidate, approval_id)
    source_locator = _required(source_locator, "source_locator")
    if getattr(tx, "mode", "demo") == "pilot" and data_origin is None:
        raise DomainError(
            "DATA_ORIGIN_REQUIRED",
            "pilot outcome intake requires an explicit REAL or TEST data_origin",
        )
    origin = _origin(data_origin, is_demo)
    if getattr(tx, "mode", "demo") == "pilot" and origin == "DEMO":
        raise DomainError("DEMO_OUTCOME_FORBIDDEN", "pilot outcome intake cannot record DEMO data")
    normalized_sku = _text(sku) or _text(candidate.get("sku"))
    normalized_listing = _text(listing_id)
    normalized_test_id = _text(test_id)
    source_revision = _text(source_revision)
    normalized_metrics = {name: (metrics or {}).get(name) for name in METRIC_FIELDS}
    if set(metrics or {}) - set(METRIC_FIELDS):
        raise DomainError("UNKNOWN_METRIC", "outcome metrics contain unsupported fields")
    if status == "NOT_LAUNCHED":
        if units not in (None, "") or any(
            value not in (None, "") for value in normalized_metrics.values()
        ):
            raise DomainError(
                "FABRICATED_OUTCOME",
                "not-launched outcomes must not contain units or financial metrics",
            )
        start_iso = end_iso = currency = revenue_basis = None
        normalized_metrics = {name: None for name in METRIC_FIELDS}
        reason = _required(reason, "reason")
        units = None
    else:
        start = _dt(window_start, "window_start")
        end = _dt(window_end, "window_end")
        if end <= start:
            raise DomainError("INVALID_WINDOW", "window_end must be later than window_start")
        start_iso = start.isoformat().replace("+00:00", "Z")
        end_iso = end.isoformat().replace("+00:00", "Z")
        currency = _required(currency, "currency").upper()
        if len(currency) != 3 or not currency.isalpha():
            raise DomainError("INVALID_CURRENCY", "currency must be a three-letter code")
        if revenue_basis not in {"GROSS", "NET"}:
            raise DomainError("OUTCOME_REQUIRED", "revenue_basis is required")
        if _decimal(units, "units") is None:
            raise DomainError("OUTCOME_REQUIRED", "units is required")
        for name, value in normalized_metrics.items():
            _decimal(value, name)
        reason = (reason or "").strip() or None
    outcomes = [
        item
        for item in tx.list("outcome", candidate_id=candidate_id)
        if item.get("approval_id") == str(approval["id"])
        and item.get("status") == status
        and item.get("window_start") == start_iso
        and item.get("window_end") == end_iso
        and item.get("source_locator") == source_locator
        and outcome_origin(item) == origin
    ]
    duplicate = next(
        (item for item in outcomes if item.get("source_revision") == source_revision), None
    )
    if duplicate is not None:
        incoming = {
            "currency": currency,
            "units": units,
            "revenue_basis": revenue_basis,
            "metrics": normalized_metrics,
            "is_demo": origin == "DEMO",
            "data_origin": origin,
            "sku": normalized_sku,
            "listing_id": normalized_listing,
            "test_id": normalized_test_id,
            "reason": reason,
        }
        if any(duplicate.get(key) != value for key, value in incoming.items()):
            raise DomainError(
                "OUTCOME_SOURCE_CONFLICT",
                "同一来源和观察窗口已有不同结果，请核对数据或明确新的来源版本",
                409,
                {"existing_outcome_id": duplicate["id"]},
            )
        return duplicate, True
    if outcomes and source_revision is None:
        raise DomainError(
            "OUTCOME_SOURCE_CONFLICT",
            "同一来源和观察窗口已有不同结果，请明确新的来源修订版本",
            409,
            {"existing_outcome_id": outcomes[-1]["id"], "requires_source_revision": True},
        )
    if candidate.get("business_status") != "OUTCOME_PENDING":
        raise DomainError(
            "INVALID_CANDIDATE_STATE",
            "candidate must enter outcome follow-up before recording an outcome",
        )
    item = tx.add(
        "outcome",
        {
            "approval_id": approval["id"],
            "status": status,
            "window_start": start_iso,
            "window_end": end_iso,
            "currency": currency,
            "units": units,
            "revenue_basis": revenue_basis,
            "metrics": normalized_metrics,
            "source_locator": source_locator,
            "source_revision": source_revision,
            "data_origin": origin,
            "is_demo": origin == "DEMO",
            "reason": reason,
            "sku": normalized_sku,
            "listing_id": normalized_listing,
            "test_id": normalized_test_id,
        },
        project_id=str(candidate["project_id"]),
        candidate_id=candidate_id,
    )
    return item, False


def _parse_csv(csv_text: str) -> tuple[str, list[dict[str, str]]]:
    try:
        raw = csv_text.encode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise DomainError("INVALID_CSV_ENCODING", "CSV must be UTF-8") from exc
    if len(raw) > CSV_LIMIT:
        raise DomainError("CSV_TOO_LARGE", "outcome CSV exceeds 2 MiB")
    digest = hashlib.sha256(raw).hexdigest()
    try:
        reader = csv.DictReader(io.StringIO(csv_text, newline=""))
        headers = set(reader.fieldnames or [])
        if not headers or headers - CSV_FIELDS:
            raise DomainError(
                "INVALID_CSV_HEADERS",
                "outcome CSV has unsupported or missing headers",
                details={"unsupported": sorted(headers - CSV_FIELDS)},
            )
        rows = []
        for index, row in enumerate(reader, start=2):
            if index - 1 > ROW_LIMIT:
                raise DomainError("CSV_TOO_MANY_ROWS", "outcome CSV exceeds 1,000 data rows")
            values = {key: (value or "").strip() for key, value in row.items() if key is not None}
            if any(value.startswith(("=", "@")) for value in values.values()):
                raise DomainError(
                    "CSV_FORMULA_NOT_ALLOWED",
                    "CSV formulas are not accepted",
                    details={"row": index},
                )
            values["_row"] = str(index)
            rows.append(values)
    except csv.Error as exc:
        raise DomainError("INVALID_CSV", "CSV could not be parsed") from exc
    return digest, rows


def _resolve_mapping(
    tx: Tx, row: dict[str, str], explicit: dict[str, str] | None = None
) -> tuple[dict[str, Any] | None, str | None]:
    candidate_id = (explicit or {}).get("candidate_id") or row.get("candidate_id")
    approval_id = (explicit or {}).get("approval_id") or row.get("approval_id")
    if candidate_id:
        try:
            candidate = tx.get(candidate_id, "candidate")
            if candidate.get("business_status") != "OUTCOME_PENDING":
                return None, "INVALID_CANDIDATE_STATE"
            approval = _approval_for_candidate(tx, candidate, approval_id or None)
            row_sku = _text((explicit or {}).get("sku")) or _text(row.get("sku"))
            candidate_sku = _text(candidate.get("sku"))
            if row_sku and candidate_sku and row_sku != candidate_sku:
                return None, "SKU_MISMATCH"
            return {
                "candidate_id": candidate["id"],
                "approval_id": approval["id"],
                "sku": row_sku or candidate_sku,
                "listing_id": _text((explicit or {}).get("listing_id"))
                or _text(row.get("listing_id")),
                "test_id": _text((explicit or {}).get("test_id")) or _text(row.get("test_id")),
            }, None
        except DomainError as exc:
            return None, exc.code
    sku = _text(row.get("sku"))
    listing_id = _text(row.get("listing_id"))
    test_id = _text(row.get("test_id"))
    if not sku and not listing_id and not test_id:
        return None, "MAPPING_REQUIRED"
    candidates = [
        item
        for item in tx.list("candidate")
        if (not sku or item.get("sku") == sku)
        and (not listing_id or item.get("listing_id") == listing_id)
        and (not test_id or item.get("test_id") == test_id)
        and item.get("approval_id")
        and (not approval_id or item.get("approval_id") == approval_id)
    ]
    if len(candidates) != 1:
        return None, "AMBIGUOUS_MAPPING" if candidates else "MAPPING_NOT_FOUND"
    candidate = candidates[0]
    if candidate.get("business_status") != "OUTCOME_PENDING":
        return None, "INVALID_CANDIDATE_STATE"
    return {
        "candidate_id": candidate["id"],
        "approval_id": candidate["approval_id"],
        "sku": sku or _text(candidate.get("sku")),
        "listing_id": listing_id,
        "test_id": test_id,
    }, None


def preview_csv(
    tx: Tx, csv_text: str, mappings: dict[str, dict[str, str]] | None = None
) -> dict[str, Any]:
    digest, rows = _parse_csv(csv_text)
    results: list[dict[str, Any]] = []
    for row in rows:
        row_number = row["_row"]
        mapping, mapping_error = _resolve_mapping(tx, row, (mappings or {}).get(row_number))
        errors = [mapping_error] if mapping_error else []
        duplicate_id = None
        if mapping is not None:
            try:
                _validate_row_values(row)
                status = row.get("status") or "RECORDED"
                start = row.get("window_start") or None
                end = row.get("window_end") or None
                if start:
                    start = _dt(start, "window_start").isoformat().replace("+00:00", "Z")
                if end:
                    end = _dt(end, "window_end").isoformat().replace("+00:00", "Z")
                existing = _duplicate_outcome(
                    tx,
                    mapping["candidate_id"],
                    mapping["approval_id"],
                    status,
                    start,
                    end,
                    row.get("source_locator", ""),
                    _text(row.get("source_revision")),
                    _origin(
                        row.get("data_origin") or None,
                        row.get("is_demo", "").lower() in {"1", "true", "yes"},
                    ),
                )
                duplicate_id = existing["id"] if existing else None
            except (DomainError, ValueError) as exc:
                errors.append(exc.code if isinstance(exc, DomainError) else "INVALID_ROW")
        results.append(
            {
                "row": int(row_number),
                "mapping": mapping,
                "errors": errors,
                "duplicate_outcome_id": duplicate_id,
                "source_revision": _text(row.get("source_revision")),
                "valid": not errors and duplicate_id is None,
            }
        )
    return {"content_hash": digest, "rows": results, "row_count": len(rows)}


def confirm_csv(
    tx: Tx,
    actor_id: str,
    csv_text: str,
    content_hash: str,
    selected_rows: list[int],
    mappings: dict[str, dict[str, str]] | None = None,
) -> dict[str, Any]:
    preview = preview_csv(tx, csv_text, mappings)
    if preview["content_hash"] != content_hash:
        raise DomainError("CSV_CONTENT_CHANGED", "CSV content does not match the preview")
    selected = set(selected_rows)
    if len(selected) != len(selected_rows):
        raise DomainError("DUPLICATE_ROW_SELECTION", "selected_rows contains duplicates")
    by_row = {item["row"]: item for item in preview["rows"]}
    digest, raw_rows = _parse_csv(csv_text)
    del digest
    source_rows = {int(item["_row"]): item for item in raw_rows}
    created: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    for row_number in selected_rows:
        item = by_row.get(row_number)
        if item is None or item["errors"]:
            raise DomainError(
                "INVALID_ROW_SELECTION", "selected row is invalid", details={"row": row_number}
            )
        row = source_rows[row_number]
        mapping = item["mapping"]
        row_status = cast(OutcomeStatus, row.get("status") or "RECORDED")
        row_basis = cast(RevenueBasis | None, row.get("revenue_basis") or None)
        outcome, duplicate = record_outcome(
            tx,
            actor_id,
            mapping["candidate_id"],
            approval_id=mapping["approval_id"],
            status=row_status,
            window_start=row.get("window_start") or None,
            window_end=row.get("window_end") or None,
            currency=row.get("currency") or None,
            units=row.get("units") or None,
            revenue_basis=row_basis,
            metrics={name: row.get(name) or None for name in METRIC_FIELDS},
            source_locator=row.get("source_locator") or f"csv:{content_hash}:row:{row_number}",
            is_demo=row.get("is_demo", "").lower() in {"1", "true", "yes"},
            reason=row.get("reason") or None,
            sku=row.get("sku") or None,
            data_origin=row.get("data_origin") or None,
            listing_id=row.get("listing_id") or None,
            test_id=row.get("test_id") or None,
            source_revision=row.get("source_revision") or None,
        )
        (duplicates if duplicate else created).append(
            {"row": row_number, "outcome_id": outcome["id"]} if duplicate else outcome
        )
    return {"items": created, "duplicates": duplicates, "content_hash": content_hash}


def _metric_dict(snapshot: dict[str, Any]) -> dict[str, str | None]:
    metrics = snapshot.get("metrics")
    source = metrics if isinstance(metrics, dict) else snapshot
    return {name: source.get(name) for name in METRIC_FIELDS}


def _validated_feedback_rules(rules: object) -> list[dict[str, Any]]:
    if not isinstance(rules, list):
        raise DomainError(
            "INVALID_FEEDBACK_RULES", "rules must be a list"
        )
    normalized: list[dict[str, Any]] = []
    try:
        for rule in rules:
            validated = CriteriaRule.model_validate(rule)
            threshold = Decimal(validated.threshold)
            if not threshold.is_finite():
                raise ValueError("threshold must be finite")
            normalized.append(validated.model_dump(mode="json"))
    except (ValidationError, InvalidOperation, ValueError) as exc:
        raise DomainError(
            "INVALID_FEEDBACK_RULES",
            "after_rules must contain valid criteria rules with finite numeric thresholds",
            details={"reason": str(exc)},
        ) from exc
    return normalized


def _validated_required_evidence(value: object, field: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise DomainError(
            "INVALID_REQUIRED_EVIDENCE", f"{field} must contain at least one item"
        )
    normalized: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise DomainError(
                "INVALID_REQUIRED_EVIDENCE", f"{field} must contain non-empty strings"
            )
        name = item.strip()
        if name not in normalized:
            normalized.append(name)
    return normalized


def _same_candidate_refs(
    tx: Tx, candidate_id: str, kind: str, ids: list[str], *, required: bool = False
) -> list[dict[str, Any]]:
    normalized = list(dict.fromkeys(item.strip() for item in ids if item.strip()))
    if required and not normalized:
        raise DomainError(
            "RESEARCH_REFERENCE_REQUIRED", f"at least one {kind} reference is required"
        )
    items: list[dict[str, Any]] = []
    for entity_id in normalized:
        item = tx.get(entity_id, kind)
        if item.get("candidate_id") != candidate_id:
            raise DomainError(
                "CROSS_CANDIDATE_REFERENCE",
                f"{kind} reference must belong to the research candidate",
                422,
                {"reference_id": entity_id, "candidate_id": candidate_id},
            )
        items.append(item)
    return items


def create_research_conclusion(
    tx: Tx,
    actor_id: str,
    candidate_id: str,
    *,
    disposition: ResearchDisposition,
    reason: str,
    learning: str,
    source_locator: str,
    data_origin: str,
    evidence_ids: list[str],
    source_ids: list[str],
) -> dict[str, Any]:
    """Freeze a research-only STOP/HOLD decision without changing candidate state."""

    candidate = tx.get(candidate_id, "candidate")
    project = tx.get(str(candidate["project_id"]), "project")
    require_role(tx, project, actor_id, "decision")
    if disposition not in {"STOP", "HOLD"}:
        raise DomainError("INVALID_RESEARCH_DISPOSITION", "disposition must be STOP or HOLD")
    criteria_id = project.get("current_criteria_id")
    if not criteria_id:
        raise DomainError("CRITERIA_NOT_CONFIRMED", "research conclusion requires frozen criteria")
    criteria = tx.get(str(criteria_id), "criteria")
    evidence = _same_candidate_refs(tx, candidate_id, "evidence", evidence_ids, required=True)
    sources = _same_candidate_refs(tx, candidate_id, "source", source_ids)
    locator = _required(source_locator, "source_locator")
    origin = _origin(data_origin, data_origin == "DEMO")
    if tx.mode == "pilot" and origin == "DEMO":
        raise DomainError("DEMO_RESEARCH_FORBIDDEN", "pilot research cannot use DEMO data")
    if origin == "REAL":
        referenced = [candidate, *evidence, *sources]
        non_real = [
            item["id"]
            for item in referenced
            if item.get("is_demo") is True or item.get("data_origin") in {"TEST", "DEMO"}
        ]
        if non_real:
            raise DomainError(
                "RESEARCH_ORIGIN_CONFLICT",
                "REAL research cannot reference demo or test material",
                422,
                {"reference_ids": non_real},
            )
    return tx.add(
        "research_conclusion",
        {
            "disposition": disposition,
            "reason": _required(reason, "reason"),
            "learning": _required(learning, "learning"),
            "source_locator": locator,
            "source_ids": [item["id"] for item in sources],
            "data_origin": origin,
            "evidence_ids": [item["id"] for item in evidence],
            "criteria_id": criteria["id"],
            "criteria_snapshot": {
                "rules": criteria.get("rules", []),
                "required_evidence": criteria.get("required_evidence", []),
                "template_id": criteria.get("template_id"),
                "template_version": criteria.get("template_version"),
            },
            "decided_by": actor_id,
            "decided_at": tx.now.isoformat().replace("+00:00", "Z"),
        },
        project_id=str(project["id"]),
        candidate_id=candidate_id,
    )


def get_research_closure(tx: Tx, candidate_id: str) -> dict[str, Any]:
    candidate = tx.get(candidate_id, "candidate")
    project = tx.get(str(candidate["project_id"]), "project")
    criteria = (
        tx.get(str(project["current_criteria_id"]), "criteria")
        if project.get("current_criteria_id")
        else None
    )
    conclusions = tx.list("research_conclusion", candidate_id=candidate_id)
    feedback = [
        item
        for item in tx.list("feedback", candidate_id=candidate_id)
        if item.get("research_conclusion_id")
    ]
    adopted_feedback_ids = {
        str(item.get("source_feedback_id"))
        for item in tx.list("project")
        if item.get("source_feedback_id")
    }
    confirmed = [item for item in feedback if item.get("status") == "CONFIRMED"]
    return {
        "candidate": candidate,
        "project": project,
        "criteria": criteria,
        "conclusions": conclusions,
        "feedback": feedback,
        "evidence": tx.list("evidence", candidate_id=candidate_id),
        "sources": tx.list("source", candidate_id=candidate_id),
        "closure": {
            "research_conclusion_count": len(conclusions),
            "confirmed_feedback_count": len(confirmed),
            "adopted_feedback_count": sum(
                1 for item in confirmed if str(item["id"]) in adopted_feedback_ids
            ),
            "commercial_outcome_count": len(tx.list("outcome", candidate_id=candidate_id)),
            "commercial_reviewed": candidate.get("business_status") == "REVIEWED",
        },
    }


def _profit_per_unit(
    metrics: dict[str, str | None], units: str | None, basis: str | None
) -> tuple[str | None, list[str]]:
    required = list(METRIC_FIELDS)
    missing = [name for name in required if metrics.get(name) is None]
    if units is None:
        missing.append("units")
    if basis not in {"GROSS", "NET"}:
        missing.append("revenue_basis")
    if missing:
        return None, missing
    parsed = {name: _decimal(metrics[name], name) for name in required}
    unit_count = _decimal(units, "units")
    assert unit_count is not None
    if unit_count == 0:
        return None, ["ZERO_UNITS"]
    revenue = parsed["revenue"]
    assert revenue is not None
    deductions = ("procurement", "platform", "fulfillment", "advertising", "other")
    total = revenue - sum((parsed[name] or Decimal(0) for name in deductions), Decimal(0))
    if basis == "GROSS":
        total -= parsed["refunds"] or Decimal(0)
    return str(total / unit_count), []


def compare_outcome(tx: Tx, outcome_id: str) -> dict[str, Any]:
    outcome = tx.get(outcome_id, "outcome")
    # Rows written before ``data_origin`` existed remain demo data by default.
    origin = outcome_origin(outcome)
    approval = tx.get(str(outcome["approval_id"]), "decision")
    evaluation = tx.get(str(approval["evaluation_id"]), "evaluation")
    forecast = evaluation.get("forecast") or {}
    basis_reasons: list[str] = []
    if outcome["status"] == "NOT_LAUNCHED":
        basis_reasons.append("NOT_LAUNCHED")
    for field in ("window_start", "window_end", "currency", "revenue_basis"):
        expected = forecast.get(field)
        actual = outcome.get(field)
        if field in {"window_start", "window_end"} and expected and actual:
            matches = _dt(expected, field) == _dt(actual, field)
        else:
            matches = expected == actual
        if not matches:
            basis_reasons.append(f"{field.upper()}_MISMATCH")
    basis_comparable = not basis_reasons
    expected_metrics = _metric_dict(forecast)
    actual_metrics = _metric_dict(outcome)
    expected_profit, expected_missing = _profit_per_unit(
        expected_metrics, forecast.get("units"), forecast.get("revenue_basis")
    )
    actual_profit, actual_missing = _profit_per_unit(
        actual_metrics, outcome.get("units"), outcome.get("revenue_basis")
    )
    contribution_reasons: list[str] = []
    if expected_missing:
        if expected_missing == ["ZERO_UNITS"]:
            contribution_reasons.append("FORECAST_ZERO_UNITS")
        else:
            contribution_reasons.append("FORECAST_MISSING:" + ",".join(expected_missing))
    if actual_missing:
        if actual_missing == ["ZERO_UNITS"]:
            contribution_reasons.append("ZERO_UNITS")
        else:
            contribution_reasons.append("ACTUAL_MISSING:" + ",".join(actual_missing))
    fields: dict[str, Any] = {}
    for name in ("units", *METRIC_FIELDS):
        before = forecast.get(name) if name == "units" else expected_metrics.get(name)
        after = outcome.get(name) if name == "units" else actual_metrics.get(name)
        variance = None
        if before is not None and after is not None and basis_comparable:
            before_decimal = _decimal(before, name)
            after_decimal = _decimal(after, name)
            assert before_decimal is not None and after_decimal is not None
            variance = str(after_decimal - before_decimal)
        field_reasons = list(basis_reasons)
        if before is None:
            field_reasons.append("FORECAST_MISSING")
        if after is None:
            field_reasons.append("ACTUAL_MISSING")
        fields[name] = {
            "forecast": before,
            "actual": after,
            "variance": variance,
            "comparable": not field_reasons,
            "reasons": field_reasons,
        }
    contribution_comparable = basis_comparable and not contribution_reasons
    reasons = [*basis_reasons, *contribution_reasons]
    if origin == "TEST":
        reasons.append("TEST_ORDER_EXCLUDED_FROM_REAL_STATISTICS")
    return {
        "outcome_id": outcome_id,
        "approval_id": approval["id"],
        "evaluation_id": evaluation["id"],
        "criteria_id": approval["criteria_id"],
        "comparable": basis_comparable,
        "basis_comparable": basis_comparable,
        "contribution_comparable": contribution_comparable,
        "reasons": reasons,
        "fields": fields,
        "forecast_contribution_per_unit": expected_profit,
        "actual_contribution_per_unit": actual_profit,
        "contribution_variance_per_unit": (
            str(Decimal(actual_profit) - Decimal(expected_profit))
            if contribution_comparable and expected_profit is not None and actual_profit is not None
            else None
        ),
        "profit_label": "unit_contribution_profit",
        "data_origin": origin,
        "is_test": origin == "TEST",
        "counts_as_real": origin == "REAL",
        "source_chain": {
            "candidate_id": outcome.get("candidate_id"),
            "approval_id": approval["id"],
            "evaluation_id": evaluation["id"],
            "outcome_id": outcome_id,
            "source_locator": outcome.get("source_locator"),
            "source_revision": outcome.get("source_revision"),
            "sku": outcome.get("sku"),
            "listing_id": outcome.get("listing_id"),
            "test_id": outcome.get("test_id"),
        },
    }


def create_review(
    tx: Tx, actor_id: str, outcome_id: str, *, deviation_reasons: list[str], notes: str
) -> dict[str, Any]:
    outcome = tx.get(outcome_id, "outcome")
    candidate = tx.get(str(outcome["candidate_id"]), "candidate")
    project = tx.get(str(candidate["project_id"]), "project")
    require_role(tx, project, actor_id, "contributor")
    if outcome["status"] != "RECORDED":
        raise DomainError(
            "REVIEW_NOT_REQUIRED", "not-launched outcomes are reviewed by their explicit reason"
        )
    comparison = compare_outcome(tx, outcome_id)
    normalized = [reason.strip() for reason in deviation_reasons if reason.strip()]
    if not normalized:
        raise DomainError("REVIEW_REASON_REQUIRED", "review requires at least one deviation reason")
    return tx.add(
        "outcome_review",
        {
            "outcome_id": outcome_id,
            "approval_id": comparison["approval_id"],
            "evaluation_id": comparison["evaluation_id"],
            "data_origin": outcome_origin(outcome),
            "source_chain": comparison["source_chain"],
            "deviation_reasons": normalized,
            "notes": _required(notes, "notes"),
            "status": "COMPLETED",
            "assistant": {
                "is_simulated": tx.mode == "demo",
                "kind": "deterministic_comparison",
                "version": "deterministic-review-v1",
                "explanation": (
                    f"Review of outcome {outcome_id} against approval {comparison['approval_id']}"
                ),
                "outcome_id": outcome_id,
            },
        },
        project_id=str(candidate["project_id"]),
        candidate_id=str(candidate["id"]),
    )


def propose_feedback(
    tx: Tx,
    actor_id: str,
    outcome_id: str,
    *,
    before_rules: list[dict[str, Any]],
    after_rules: list[dict[str, Any]],
    reason: str,
    before_required_evidence: list[str] | None = None,
    after_required_evidence: list[str] | None = None,
    research_learning: str | None = None,
) -> dict[str, Any]:
    outcome = tx.get(outcome_id, "outcome")
    candidate = tx.get(str(outcome["candidate_id"]), "candidate")
    project = tx.get(str(candidate["project_id"]), "project")
    require_role(tx, project, actor_id, "contributor")
    approval = tx.get(str(outcome["approval_id"]), "decision")
    criteria = tx.get(str(approval["criteria_id"]), "criteria")
    if outcome["status"] == "RECORDED" and not any(
        item.get("outcome_id") == outcome_id and item.get("status") == "COMPLETED"
        for item in tx.list("outcome_review", candidate_id=str(candidate["id"]))
    ):
        raise DomainError(
            "REVIEW_INCOMPLETE",
            "feedback requires a completed review tied to the source outcome",
        )
    if before_rules != criteria.get("rules", []):
        raise DomainError(
            "BEFORE_RULES_MISMATCH", "before_rules must match the approved criteria snapshot"
        )
    normalized_after = _validated_feedback_rules(after_rules)
    return _add_feedback(
        tx,
        candidate,
        criteria,
        before_rules=before_rules,
        after_rules=normalized_after,
        reason=reason,
        before_required_evidence=before_required_evidence,
        after_required_evidence=after_required_evidence,
        research_learning=research_learning,
        outcome=outcome,
    )


def _add_feedback(
    tx: Tx,
    candidate: dict[str, Any],
    criteria: dict[str, Any],
    *,
    before_rules: list[dict[str, Any]],
    after_rules: list[dict[str, Any]],
    reason: str,
    before_required_evidence: list[str] | None,
    after_required_evidence: list[str] | None,
    research_learning: str | None,
    outcome: dict[str, Any] | None = None,
    conclusion: dict[str, Any] | None = None,
) -> dict[str, Any]:
    before_evidence = _validated_required_evidence(
        criteria.get("required_evidence", [])
        if before_required_evidence is None
        else before_required_evidence,
        "before_required_evidence",
    )
    if before_evidence != criteria.get("required_evidence", []):
        raise DomainError(
            "BEFORE_EVIDENCE_MISMATCH",
            "before_required_evidence must match the frozen criteria snapshot",
        )
    after_evidence = _validated_required_evidence(
        before_evidence if after_required_evidence is None else after_required_evidence,
        "after_required_evidence",
    )
    learning = _text(research_learning)
    if after_rules == before_rules and after_evidence == before_evidence and learning is None:
        raise DomainError(
            "FEEDBACK_CHANGE_REQUIRED",
            "feedback must change rules or required evidence, or record research learning",
        )
    source_chain: dict[str, Any]
    if outcome is not None:
        source_chain = {
            "approval_id": outcome["approval_id"],
            "outcome_id": outcome["id"],
            "source_locator": outcome.get("source_locator"),
            "source_revision": outcome.get("source_revision"),
        }
    else:
        assert conclusion is not None
        source_chain = {
            "research_conclusion_id": conclusion["id"],
            "criteria_id": conclusion["criteria_id"],
            "evidence_ids": conclusion["evidence_ids"],
            "source_ids": conclusion.get("source_ids", []),
            "source_locator": conclusion["source_locator"],
        }
    if outcome is not None:
        data_origin = outcome_origin(outcome)
    else:
        assert conclusion is not None
        data_origin = conclusion["data_origin"]
    return tx.add(
        "feedback",
        {
            "outcome_id": outcome["id"] if outcome is not None else None,
            "research_conclusion_id": conclusion["id"] if conclusion is not None else None,
            "data_origin": data_origin,
            "source_chain": source_chain,
            "before_rules": before_rules,
            "after_rules": after_rules,
            "before_required_evidence": before_evidence,
            "after_required_evidence": after_evidence,
            "research_learning": learning,
            "reason": _required(reason, "reason"),
            "status": "PROPOSED",
            "new_criteria_id": None,
        },
        project_id=str(candidate["project_id"]),
        candidate_id=str(candidate["id"]),
    )


def propose_research_feedback(
    tx: Tx,
    actor_id: str,
    conclusion_id: str,
    *,
    before_rules: list[dict[str, Any]],
    after_rules: list[dict[str, Any]],
    reason: str,
    before_required_evidence: list[str] | None = None,
    after_required_evidence: list[str] | None = None,
    research_learning: str | None = None,
) -> dict[str, Any]:
    conclusion = tx.get(conclusion_id, "research_conclusion")
    candidate = tx.get(str(conclusion["candidate_id"]), "candidate")
    project = tx.get(str(candidate["project_id"]), "project")
    require_role(tx, project, actor_id, "contributor")
    criteria = tx.get(str(conclusion["criteria_id"]), "criteria")
    frozen = conclusion.get("criteria_snapshot", {})
    if before_rules != frozen.get("rules", []):
        raise DomainError(
            "BEFORE_RULES_MISMATCH", "before_rules must match the frozen criteria snapshot"
        )
    normalized_after = _validated_feedback_rules(after_rules)
    return _add_feedback(
        tx,
        candidate,
        criteria,
        before_rules=before_rules,
        after_rules=normalized_after,
        reason=reason,
        before_required_evidence=before_required_evidence,
        after_required_evidence=after_required_evidence,
        research_learning=research_learning,
        conclusion=conclusion,
    )


def decide_feedback(
    tx: Tx,
    actor_id: str,
    feedback_id: str,
    *,
    confirm: bool,
    reason: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    feedback = tx.get(feedback_id, "feedback")
    if feedback.get("status") != "PROPOSED":
        raise DomainError(
            "FEEDBACK_ALREADY_DECIDED", "feedback proposal is already decided", status=409
        )
    project = tx.get(str(feedback["project_id"]), "project")
    require_role(tx, project, actor_id, "decision")
    if not confirm:
        feedback = tx.update(
            feedback_id,
            {
                "status": "REJECTED",
                "reason": _required(reason, "reason"),
                "decided_by": actor_id,
                "decided_at": tx.now.isoformat().replace("+00:00", "Z"),
            },
        )
        return feedback, None
    outcome_id = feedback.get("outcome_id")
    conclusion_id = feedback.get("research_conclusion_id")
    if bool(outcome_id) == bool(conclusion_id):
        raise DomainError("INVALID_FEEDBACK_SOURCE", "feedback must have exactly one source")
    outcome = tx.get(str(outcome_id), "outcome") if outcome_id else None
    approval = tx.get(str(outcome["approval_id"]), "decision") if outcome is not None else None
    conclusion = (
        tx.get(str(conclusion_id), "research_conclusion") if conclusion_id is not None else None
    )
    if approval is not None:
        prior_id = approval["criteria_id"]
    else:
        assert conclusion is not None
        prior_id = conclusion["criteria_id"]
    prior = tx.get(str(prior_id), "criteria")
    confirmed_rules = _validated_feedback_rules(feedback.get("after_rules"))
    confirmed_evidence = _validated_required_evidence(
        feedback.get("after_required_evidence", prior.get("required_evidence", [])),
        "after_required_evidence",
    )
    criteria = tx.add(
        "criteria",
        {
            "rules": confirmed_rules,
            "required_evidence": confirmed_evidence,
            "template_id": prior["template_id"],
            "template_version": prior["template_version"],
            "research_learning": feedback.get("research_learning"),
            "confirmed_by": actor_id,
            "confirmed_at": tx.now.isoformat().replace("+00:00", "Z"),
            "parent_revision_id": prior["id"],
            "feedback_id": feedback_id,
            "source_outcome_id": outcome["id"] if outcome is not None else None,
            "source_approval_id": approval["id"] if approval is not None else None,
            "source_research_conclusion_id": (
                conclusion["id"] if conclusion is not None else None
            ),
        },
        project_id=str(project["id"]),
    )
    feedback = tx.update(
        feedback_id,
        {
            "status": "CONFIRMED",
            "new_criteria_id": criteria["id"],
            "decided_by": actor_id,
            "decided_at": tx.now.isoformat().replace("+00:00", "Z"),
        },
    )
    return feedback, criteria


def finalize_review(tx: Tx, actor_id: str, candidate_id: str) -> dict[str, Any]:
    candidate = tx.get(candidate_id, "candidate")
    project = tx.get(str(candidate["project_id"]), "project")
    require_role(tx, project, actor_id, "decision")
    if candidate.get("business_status") != "OUTCOME_PENDING":
        raise DomainError("INVALID_CANDIDATE_STATE", "candidate is not awaiting outcome review")
    outcomes = tx.list("outcome", candidate_id=candidate_id)
    if not outcomes:
        raise DomainError(
            "OUTCOME_REQUIRED",
            "review cannot finish without an outcome or explicit no-launch record",
        )
    latest = outcomes[-1]
    if latest["status"] == "NOT_LAUNCHED":
        if not latest.get("reason"):
            raise DomainError("NO_LAUNCH_REASON_REQUIRED", "not-launched outcome requires a reason")
    else:
        window_end = _dt(latest.get("window_end"), "window_end")
        if window_end > tx.now:
            raise DomainError(
                "OUTCOME_WINDOW_OPEN",
                "review cannot finish before the recorded observation window ends",
                details={
                    "window_end": latest["window_end"],
                    "current_time": tx.now.isoformat().replace("+00:00", "Z"),
                },
            )
        reviews = [
            item
            for item in tx.list("outcome_review", candidate_id=candidate_id)
            if item.get("outcome_id") == latest["id"] and item.get("status") == "COMPLETED"
        ]
        if not reviews:
            raise DomainError("REVIEW_INCOMPLETE", "recorded outcome requires a completed review")
        feedback = [
            item
            for item in tx.list("feedback", candidate_id=candidate_id)
            if item.get("outcome_id") == latest["id"]
        ]
        if any(item.get("status") == "PROPOSED" for item in feedback):
            raise DomainError(
                "FEEDBACK_PENDING", "all feedback proposals must be confirmed or rejected"
            )
    return tx.update(candidate_id, {"business_status": "REVIEWED"})
