"""Read-only provenance and research-cycle projections for the current workspace."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from app.persistence.store import Tx


def _web_link(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        url = urlsplit(value)
        return url.scheme in {"http", "https"} and bool(url.hostname) and not url.username
    except ValueError:
        return False


def candidate_provenance(tx: Tx, candidate: dict[str, Any]) -> dict[str, Any]:
    """A traceable source is not proof of price, cost or fitment verification."""
    cid = candidate["id"]
    references = []
    if candidate.get("is_demo") is not True:
        for source in tx.list("source", candidate_id=cid):
            if source.get("is_demo") is True:
                continue
            if source.get("batch_id") or _web_link(source.get("source_url")):
                references.append(
                    {"id": source["id"], "kind": "MARKET" if source.get("batch_id") else "MANUAL"}
                )
        for record in tx.list("sourcing_record", candidate_id=cid):
            if record.get("record_type") != "QUOTE" or record.get("is_demo") is True:
                continue
            payload = record.get("payload", {})
            if payload.get("supplier_name") and str(record.get("source_locator") or "").strip():
                references.append({"id": record["id"], "kind": "SUPPLIER"})
    return {
        "traceable": bool(references),
        "references": references,
        "benchmark_candidate_id": candidate.get("sourcing_profile", {}).get(
            "benchmark_candidate_id"
        ),
        "message": "来源可追溯不代表价格、采购条件或适配已核验",
    }


def research_progress(
    tx: Tx, candidate: dict[str, Any], projects: list[dict[str, Any]], provenance: dict[str, Any]
) -> dict[str, Any]:
    conclusions = tx.list("research_conclusion", candidate_id=candidate["id"])
    # Latest disposition controls the displayed cycle; an old completed cycle
    # cannot make a newer unresolved research conclusion look complete.
    latest = conclusions[-1] if conclusions else None
    real = bool(latest and latest.get("data_origin") == "REAL" and not candidate.get("is_demo"))
    feedback = [
        f
        for f in tx.list("feedback", candidate_id=candidate["id"])
        if real
        and latest
        and f.get("research_conclusion_id") == latest["id"]
        and f.get("status") == "CONFIRMED"
    ]
    stages = {
        "source": provenance["traceable"],
        "conclusion": real,
        "confirmed_feedback": bool(feedback),
        "next_project": any(
            p.get("source_feedback_id") in {f["id"] for f in feedback} for p in projects
        ),
    }
    return {
        "stages": stages,
        "complete": all(stages.values()),
        "disposition": latest.get("disposition") if latest else None,
        "conclusion_id": latest["id"] if latest else None,
        "feedback_ids": [f["id"] for f in feedback],
    }
