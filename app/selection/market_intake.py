"""Persisted discovery observations, selected by server-owned batch identity."""

from __future__ import annotations

from datetime import timedelta
from typing import Any
from uuid import uuid4

from app.core import DomainError, require_role
from app.persistence.store import Tx
from app.selection.intake import _require_url

MAPPING_VERSION = "market-observation-v1"


def persist_discovery(
    tx: Tx,
    project_id: str,
    result: dict[str, Any],
    *,
    retention_days: int,
) -> dict[str, Any]:
    project = tx.get(project_id, "project")
    if result.get("is_demo") is not False:
        raise DomainError("INVALID_PROVIDER_RESULT", "真实来源不能返回演示数据")
    if result.get("channel") != project["channel"] or result.get("market") != project["market"]:
        raise DomainError("INVALID_PROVIDER_RESULT", "来源市场与项目不匹配")
    batch_id = str(uuid4())
    rows: list[tuple[str, dict[str, Any]]] = []
    for item in result.get("items", [])[:10]:
        title = item.get("name") or item.get("title")
        if not title or not item.get("stable_id"):
            continue
        source_url = _require_url(item.get("source_url"))
        if not source_url and not item.get("external_id"):
            continue
        rows.append((str(uuid4()), {**item, "title": title, "source_url": source_url}))
    meta = result.get("meta", {})
    batch = tx.add(
        "discovery_batch",
        {
            "provider": result["provider"],
            "channel": project["channel"],
            "market": project["market"],
            "query": result["query"],
            "coverage": result.get("coverage", "COVERED"),
            "workspace_id": tx.workspace_id,
            "mapping_version": MAPPING_VERSION,
            "collected_at": tx.now.isoformat(),
            "is_demo": False,
            "request_id": meta.get("request_id"),
            "cost": meta.get("cost"),
            "latency_ms": meta.get("latency_ms"),
            "raw_response_hash": meta.get("raw_response_hash"),
            "item_ids": [item_id for item_id, _ in rows],
            "location": "United States",
            "language": "en",
        },
        entity_id=batch_id,
        project_id=project_id,
    )
    tx.add(
        "source_material",
        {
            "batch_id": batch_id,
            "summary": meta.get("raw", {}),
            "expires_at": (tx.now + timedelta(days=retention_days)).isoformat(),
            "status": "AVAILABLE",
            "raw_response_hash": meta.get("raw_response_hash"),
        },
        project_id=project_id,
    )
    items = []
    for item_id, row in rows:
        item = tx.add(
            "discovery_item",
            {
                **row,
                "batch_id": batch_id,
                "workspace_id": tx.workspace_id,
                "mapping_version": MAPPING_VERSION,
                "collected_at": tx.now.isoformat(),
            },
            entity_id=item_id,
            project_id=project_id,
        )
        items.append({**item, "item_id": item_id})
    return {
        "batch": batch,
        "items": items,
        "coverage": batch["coverage"],
        "provider": batch["provider"],
        "channel": project["channel"],
        "market": project["market"],
        "query": batch["query"],
        "is_demo": False,
    }


def select_item(
    tx: Tx,
    actor: str,
    project_id: str,
    batch_id: str,
    item_id: str,
) -> dict[str, Any]:
    project = tx.get(project_id, "project")
    require_role(tx, project, actor, "analyst")
    batch = tx.get(batch_id, "discovery_batch")
    item = tx.get(item_id, "discovery_item")
    if (
        batch["project_id"] != project_id
        or item["project_id"] != project_id
        or item["batch_id"] != batch_id
        or item_id not in batch["item_ids"]
        or batch["workspace_id"] != tx.workspace_id
        or batch["channel"] != project["channel"]
        or batch["market"] != project["market"]
    ):
        raise DomainError("DISCOVERY_SELECTION_INVALID", "所选条目不属于当前项目和来源批次")
    for source in tx.list("source", project_id=project_id):
        if source.get("batch_id") == batch_id and source.get("item_id") == item_id:
            return {
                "candidate": tx.get(source["candidate_id"], "candidate"),
                "source": source,
                "reused": True,
            }
    candidate = next(
        (
            c
            for c in tx.list("candidate", project_id=project_id)
            if c.get("market_identity") == item["stable_id"] and c.get("market") == batch["market"]
        ),
        None,
    )
    reused = candidate is not None
    if candidate is None:
        candidate = tx.add(
            "candidate",
            {
                "title": item["title"],
                "external_id": item["external_id"],
                "source_url": item.get("source_url"),
                "market_identity": item["stable_id"],
                "market": batch["market"],
                "business_status": "PREPARING",
                "screening_status": "UNCHECKED",
                "current_evaluation_id": None,
                "current_submission_id": None,
                "approval_id": None,
                "sku": None,
                "is_demo": False,
            },
            project_id=project_id,
        )
    source = tx.add(
        "source",
        {
            "entry_kind": "DISCOVERY",
            "provider": batch["provider"],
            "source_ref": f"{batch_id}/{item_id}",
            "batch_id": batch_id,
            "item_id": item_id,
            "external_id": item["external_id"],
            "source_url": item.get("source_url"),
            "collected_at": batch["collected_at"],
            "mapping_version": MAPPING_VERSION,
            "is_demo": False,
            "raw": {},
        },
        project_id=project_id,
        candidate_id=candidate["id"],
    )
    previous = tx.list("evidence", candidate_id=candidate["id"])
    for observation in item.get("observations", []):
        field = str(observation["field"])
        observation_key = f"{item['offer_id']}:{field}"
        superseded = {e.get("supersedes_id") for e in previous}
        prior = next(
            (
                e
                for e in reversed(previous)
                if e.get("observation_key") == observation_key
                and e["id"] not in superseded
                and e.get("verification") == "UNVERIFIED"
                and e.get("batch_id")
                and e.get("mapping_version") == MAPPING_VERSION
            ),
            None,
        )
        observation_order = (batch["collected_at"], batch_id, item_id)
        if prior is not None:
            prior_order = (
                str(prior.get("observed_at", "")),
                str(prior.get("batch_id", "")),
                str(prior.get("item_id", "")),
            )
            # The immutable batch item and source retain older observations. Evidence heads only
            # advance: equal timestamps use stable batch/item ids so selection order cannot decide.
            if observation_order <= prior_order:
                continue
        value = observation.get("value")
        evidence = tx.add(
            "evidence",
            {
                "field": field,
                "value": None if value is None else str(value),
                "unit": observation.get("unit") or ("per_item" if "price" in field else "label"),
                "currency": observation.get("currency"),
                "window": None,
                "source_locator": item.get("source_url") or source["source_ref"],
                "observed_at": batch["collected_at"],
                "valid_until": None,
                "epistemic_kind": "FACT",
                "verification": "UNVERIFIED",
                "is_demo": False,
                # A refresh may only advance the raw provider-observation chain.
                # Human-verified evidence remains a separate active head.
                "supersedes_id": prior["id"] if prior else None,
                "recorded_by": actor,
                "batch_id": batch_id,
                "item_id": item_id,
                "mapping_version": MAPPING_VERSION,
                "observation_key": observation_key,
                "semantics": "页面观测；购买量标签不代表完整订单；未知税费/运费未计入",
            },
            project_id=project_id,
            candidate_id=candidate["id"],
        )
        previous.append(evidence)
    candidate = tx.update(candidate["id"], {"screening_status": "UNCHECKED"})
    return {"candidate": candidate, "source": source, "reused": reused}


def expire_materials(tx: Tx) -> int:
    expired = 0
    for material in tx.list("source_material"):
        if material["status"] == "AVAILABLE" and material["expires_at"] <= tx.now.isoformat():
            tx.update(material["id"], {"summary": None, "status": "EXPIRED"})
            expired += 1
    return expired
