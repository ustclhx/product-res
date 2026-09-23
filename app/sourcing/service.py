"""Deterministic sourcing rules kept outside the HTTP transport layer."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from urllib.parse import unquote, urlparse

from app.core import DomainError, require_role
from app.evidence.screening import current_evidence, evidence_quality
from app.persistence.store import Tx

DEFAULT_PROFILE: dict[str, Any] = {
    "product_type": "LISTED",
    "stage": "RESEARCH",
    "benchmark_candidate_id": None,
    "target_market": None,
    "brand": None,
    "model": None,
    "year": None,
    "trim": None,
    "seat_type": None,
}

CONNECTORS = [
    {
        "platform": "1688",
        "status": "AUTHORIZATION_REQUIRED",
        "official_url": "https://aop.alibaba.com/",
    },
    {
        "platform": "YIWUGO",
        "status": "AUTHORIZATION_REQUIRED",
        "official_url": "https://en.yiwugo.com/partners/index.html",
    },
]

LABELS = {
    "procurement_reference_price": "供应参考价",
    "moq_reference": "参考 MOQ",
    "target_price": "目标售价",
    "fitment_desk_review": "桌面适配检查",
    "procurement_cost": "正式采购价",
    "moq": "正式 MOQ",
    "vehicle_configuration": "明确车辆配置",
    "vehicle_fitment": "实车适配",
    "price": "实际售价",
    "currency": "售价币种",
}

FORM_KIND = {
    "procurement_reference_price": "QUOTE",
    "moq_reference": "QUOTE",
    "procurement_cost": "QUOTE",
    "moq": "QUOTE",
    "target_price": "PRICE",
    "price": "PRICE",
    "currency": "PRICE",
    "fitment_desk_review": "FITMENT",
    "vehicle_fitment": "FITMENT",
    "vehicle_configuration": "FITMENT",
}


def _context(tx: Tx, candidate_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    candidate = tx.get(candidate_id, "candidate")
    project = tx.get(str(candidate["project_id"]), "project")
    return candidate, project


def update_profile(
    tx: Tx, actor: str, candidate_id: str, profile: dict[str, Any]
) -> dict[str, Any]:
    candidate, project = _context(tx, candidate_id)
    require_role(tx, project, actor, "analyst")
    benchmark_id = profile.get("benchmark_candidate_id")
    if benchmark_id is not None:
        benchmark = tx.get(str(benchmark_id), "candidate")
        if benchmark["id"] == candidate_id or benchmark.get("project_id") != project["id"]:
            raise DomainError("INVALID_BENCHMARK", "对标候选必须属于同一项目且不能是自身")
    changes: dict[str, Any] = {"sourcing_profile": {**DEFAULT_PROFILE, **profile}}
    previous_profile = candidate.get("sourcing_profile") or {}
    if any(
        previous_profile.get(key) != profile.get(key)
        for key in (
            "brand",
            "model",
            "year",
            "trim",
            "seat_type",
        )
    ):
        # A successful test of another vehicle configuration cannot carry over.
        for item in current_evidence(tx.list("evidence", candidate_id=candidate_id)):
            if item.get("field") != "vehicle_fitment" or item.get("value") is None:
                continue
            tx.add(
                "evidence",
                {
                    **{
                        key: item.get(key)
                        for key in (
                            "field",
                            "unit",
                            "currency",
                            "window",
                            "sourcing_record_id",
                        )
                    },
                    "value": None,
                    "source_locator": "车辆目标配置已变更，需重新核验适配",
                    "observed_at": tx.now.isoformat(),
                    "valid_until": None,
                    "epistemic_kind": "FACT",
                    "verification": "UNVERIFIED",
                    "verification_note": None,
                    "recorded_by": actor,
                    "supersedes_id": item["id"],
                    "is_demo": tx.mode == "demo",
                },
                project_id=project["id"],
                candidate_id=candidate_id,
            )
            changes["screening_status"] = "UNCHECKED"
    updated = tx.update(candidate_id, changes)
    return {"profile": updated["sourcing_profile"], "candidate": updated}


def _unit(price_unit: str, pieces_per_set: int | None) -> str:
    if price_unit == "piece":
        return "per_item"
    assert pieces_per_set is not None
    return f"per_set_{pieces_per_set}pcs"


def _moq_unit(unit: str, pieces_per_set: int | None) -> str:
    if unit == "piece":
        return "piece"
    assert pieces_per_set is not None
    return f"set_{pieces_per_set}pcs"


def _evidence_specs(record: dict[str, Any]) -> list[dict[str, Any]]:
    payload = record["payload"]
    common = {
        "source_locator": record["source_locator"],
        "observed_at": record["observed_at"],
        "valid_until": record["valid_until"],
        "verification_note": record.get("verification_note"),
        "is_demo": record["is_demo"],
        "recorded_by": record["recorded_by"],
        "sourcing_record_id": record["id"],
    }
    if record["record_type"] == "QUOTE":
        public = payload["quote_basis"] == "PUBLIC_REFERENCE"
        verification = "UNVERIFIED" if public else record["verification"]
        result = [
            {
                **common,
                "field": "procurement_reference_price" if public else "procurement_cost",
                "value": payload["amount"],
                "unit": _unit(payload["price_unit"], payload.get("pieces_per_set")),
                "currency": payload["currency"],
                "window": None,
                "epistemic_kind": "FACT",
                "verification": verification,
            },
            {
                **common,
                "field": "moq_reference" if public else "moq",
                "value": str(payload["moq"]),
                "unit": _moq_unit(payload["moq_unit"], payload.get("pieces_per_set")),
                "currency": None,
                "window": None,
                "epistemic_kind": "FACT",
                "verification": verification,
            },
        ]
        return result
    if record["record_type"] == "PRICE":
        target = payload["price_basis"] == "TARGET_ESTIMATE"
        result = [
            {
                **common,
                "field": "target_price" if target else "price",
                "value": payload["amount"],
                "unit": _unit(payload["price_unit"], payload.get("pieces_per_set")),
                "currency": payload["currency"],
                "window": None,
                "epistemic_kind": "ESTIMATE" if target else "FACT",
                "verification": "UNVERIFIED" if target else record["verification"],
            }
        ]
        if not target:
            result.append(
                {
                    **common,
                    "field": "currency",
                    "value": payload["currency"],
                    "unit": "ISO4217",
                    "currency": None,
                    "window": None,
                    "epistemic_kind": "FACT",
                    "verification": record["verification"],
                }
            )
        return result
    left = payload.get("left_front_seat") or {}
    right = payload.get("right_front_seat") or {}
    physical_pass = (
        payload["method"] == "PHYSICAL_TEST"
        and payload["result"] == "PASS"
        and record["verification"] == "VERIFIED"
        and payload.get("sample_ref")
        and payload.get("sample_target_consistent") is True
        and left.get("result") == "PASS"
        and bool(left.get("details"))
        and right.get("result") == "PASS"
        and bool(right.get("details"))
    )
    if payload["method"] == "DESK_REVIEW":
        return [
            {
                **common,
                "field": "fitment_desk_review",
                "value": payload["result"],
                "unit": "review_result",
                "currency": None,
                "window": None,
                "epistemic_kind": "FACT",
                "verification": record["verification"],
            }
        ]
    return [
        {
            **common,
            "field": "vehicle_fitment",
            "value": "PASS" if physical_pass else None,
            "unit": "test_result",
            "currency": None,
            "window": None,
            "epistemic_kind": "FACT",
            "verification": "VERIFIED" if physical_pass else "UNVERIFIED",
        }
    ]


def create_record(tx: Tx, actor: str, candidate_id: str, data: dict[str, Any]) -> dict[str, Any]:
    candidate, project = _context(tx, candidate_id)
    require_role(tx, project, actor, "contributor")
    payload = data["payload"]
    if (
        data["kind"] == "FITMENT"
        and payload["method"] == "PHYSICAL_TEST"
        and payload["result"] == "PASS"
        and data["verification"] == "VERIFIED"
    ):
        left = payload.get("left_front_seat") or {}
        right = payload.get("right_front_seat") or {}
        if (
            not payload.get("sample_ref")
            or payload.get("sample_target_consistent") is not True
            or left.get("result") != "PASS"
            or not left.get("details")
            or right.get("result") != "PASS"
            or not right.get("details")
        ):
            raise DomainError(
                "FITMENT_CHECKS_INCOMPLETE",
                "已核验的实车通过必须包含匹配目标的样品及左右前排通过明细",
            )
        profile = candidate.get("sourcing_profile") or {}
        if any(
            profile.get(key) and str(profile[key]).casefold() != str(payload.get(key)).casefold()
            for key in ("brand", "model", "year", "trim", "seat_type")
        ):
            raise DomainError(
                "FITMENT_TARGET_MISMATCH", "实车测试配置与候选目标不一致，请先核对车型配置"
            )
    previous_record: dict[str, Any] | None = None
    supersedes = data.get("supersedes_record_id")
    records = tx.list("sourcing_record", candidate_id=candidate_id)
    if supersedes is not None:
        previous_record = tx.get(str(supersedes), "sourcing_record")
        if (
            previous_record.get("candidate_id") != candidate_id
            or previous_record.get("record_type") != data["kind"]
        ):
            raise DomainError("INVALID_SUPERSEDES", "替代记录必须属于同一候选和同一类型")
        if any(item.get("supersedes_record_id") == supersedes for item in records):
            raise DomainError("SOURCING_REVISION_STALE", "该记录已被替代，请刷新后重试", 409)
        previous_evidence_ids = {
            item["id"]
            for item in tx.list("evidence", candidate_id=candidate_id)
            if item.get("sourcing_record_id") == previous_record["id"]
        }
        if any(
            item.get("supersedes_id") in previous_evidence_ids
            for item in tx.list("evidence", candidate_id=candidate_id)
        ):
            raise DomainError("SOURCING_REVISION_STALE", "对应证据已被替代，请刷新后重试", 409)
    record_data = {**data, "record_type": data["kind"], "recorded_by": actor}
    record_data.pop("kind")
    if (data["kind"] == "QUOTE" and payload["quote_basis"] == "PUBLIC_REFERENCE") or (
        data["kind"] == "PRICE" and payload["price_basis"] == "TARGET_ESTIMATE"
    ):
        record_data["verification"] = "UNVERIFIED"
    record = tx.add(
        "sourcing_record",
        {**record_data, "is_demo": tx.mode == "demo"},
        project_id=project["id"],
        candidate_id=candidate_id,
    )
    old_evidence = {
        str(item.get("field")): item
        for item in tx.list("evidence", candidate_id=candidate_id)
        if previous_record is not None and item.get("sourcing_record_id") == previous_record["id"]
    }
    evidence = []
    specs = _evidence_specs(record)
    emitted_fields = {str(spec["field"]) for spec in specs}
    for field, previous in old_evidence.items():
        if field not in emitted_fields:
            specs.append(
                {
                    "field": field,
                    "value": None,
                    "unit": previous.get("unit") or "withdrawn",
                    "currency": previous.get("currency"),
                    "window": previous.get("window"),
                    "source_locator": record["source_locator"],
                    "observed_at": record["observed_at"],
                    "valid_until": record["valid_until"],
                    "epistemic_kind": "FACT",
                    "verification": "UNVERIFIED",
                    "verification_note": "由新的结构化记录撤回",
                    "is_demo": record["is_demo"],
                    "recorded_by": actor,
                    "sourcing_record_id": record["id"],
                }
            )
    for spec in specs:
        prior_evidence = old_evidence.get(str(spec["field"]))
        evidence.append(
            tx.add(
                "evidence",
                {**spec, "supersedes_id": prior_evidence["id"] if prior_evidence else None},
                project_id=project["id"],
                candidate_id=candidate_id,
            )
        )
    updated = tx.update(candidate_id, {"screening_status": "UNCHECKED"})
    return {"record": _record_view(record), "evidence": evidence, "candidate": updated}


def _record_view(record: dict[str, Any]) -> dict[str, Any]:
    view = {**record, "kind": record["record_type"]}
    view.pop("record_type", None)
    return view


def _iso(value: Any) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed.astimezone(UTC)


def _requirement(
    tx: Tx,
    field: str,
    evidence: list[dict[str, Any]],
    tasks: list[dict[str, Any]],
    *,
    profile: dict[str, Any],
    reference_presence_ok: bool = False,
    required_now: bool = True,
    alternative_fields: tuple[str, ...] = (),
) -> dict[str, Any]:
    if field == "vehicle_configuration":
        ids: list[str] = []
        ready = all(profile.get(key) for key in ("brand", "model", "year", "seat_type"))
        status = "READY" if ready else "MISSING"
    else:
        accepted_fields = {field, *alternative_fields}
        candidates = [item for item in evidence if item.get("field") in accepted_fields]
        if alternative_fields:
            alternatives = [item for item in candidates if item.get("field") in alternative_fields]
            _, alternative_selected, _ = evidence_quality(alternatives, now=tx.now)
            if alternative_selected is not None:
                candidates = alternatives
            else:
                candidates = [item for item in candidates if item.get("field") == field]
        quality, selected, ids = evidence_quality(candidates, now=tx.now)
        ready = selected is not None
        if reference_presence_ok and candidates and quality != "CONFLICT":
            heads = current_evidence(candidates)
            current = [
                item
                for item in heads
                if not (_iso(item.get("valid_until")) or tx.now) < tx.now
                and item.get("value") is not None
            ]
            ready = bool(current and any(item.get("value") is not None for item in current))
            if not ready and any(item.get("value") is not None for item in heads):
                quality = "EXPIRED"
        if ready and quality == "ELIGIBLE":
            status = "READY"
        elif quality in {"CONFLICT"}:
            status = "CONFLICT"
        elif quality == "EXPIRED":
            status = "EXPIRED"
        elif quality == "MISSING":
            status = "MISSING"
        elif candidates:
            status = "UNVERIFIED"
        else:
            status = "MISSING"
    reason = {
        "READY": "当前材料满足本阶段准备要求",
        "UNVERIFIED": "已有材料，但仍是未核验或估算信息",
        "CONFLICT": "当前材料存在冲突",
        "EXPIRED": "当前材料已过有效期",
        "MISSING": "尚无当前可用材料",
    }[status]
    related_tasks = [
        item
        for item in tasks
        if item.get("field") in {field, *alternative_fields}
        and item.get("state") in {"TODO", "IN_PROGRESS", "BLOCKED"}
    ]
    return {
        "field": field,
        "label": LABELS.get(field, field),
        "status": status,
        "reason": reason,
        "form_kind": FORM_KIND.get(field, "GENERAL"),
        "evidence_ids": ids,
        "tasks": related_tasks,
        "required_now": required_now,
        "ready_for_stage": ready if required_now else True,
    }


def build_workbench(tx: Tx, candidate_id: str) -> dict[str, Any]:
    candidate, project = _context(tx, candidate_id)
    profile = {**DEFAULT_PROFILE, **(candidate.get("sourcing_profile") or {})}
    evidence = tx.list("evidence", candidate_id=candidate_id)
    tasks = tx.list("task", candidate_id=candidate_id)
    product_type, stage = profile["product_type"], profile["stage"]
    requirements: list[dict[str, Any]] = []
    if product_type == "OEM":
        fields: list[tuple[str, bool]]
        if stage == "RESEARCH":
            fields = [
                ("procurement_reference_price", True),
                ("moq_reference", True),
                ("target_price", True),
                ("fitment_desk_review", True),
                ("procurement_cost", False),
                ("moq", False),
                ("vehicle_fitment", False),
                ("price", False),
            ]
        elif stage == "SAMPLE":
            fields = [
                ("procurement_cost", True),
                ("moq", True),
                ("vehicle_configuration", True),
                ("vehicle_fitment", False),
                ("price", False),
            ]
        else:
            fields = [
                ("procurement_cost", True),
                ("moq", True),
                ("vehicle_configuration", True),
                ("vehicle_fitment", True),
                ("price", True),
            ]
        reference_fields = {"procurement_reference_price", "moq_reference", "target_price"}
        requirements = [
            _requirement(
                tx,
                field,
                evidence,
                tasks,
                profile=profile,
                reference_presence_ok=field in reference_fields,
                required_now=required,
                alternative_fields=("procurement_cost",)
                if field == "procurement_reference_price"
                else (("moq",) if field == "moq_reference" else ()),
            )
            for field, required in fields
        ]
    else:
        criteria_id = project.get("current_criteria_id")
        criteria = tx.get(str(criteria_id), "criteria") if criteria_id else {}
        requirements = [
            _requirement(tx, str(field), evidence, tasks, profile=profile)
            for field in criteria.get("required_evidence", [])
        ]
    return {
        "profile": profile,
        "records": [
            _record_view(item) for item in tx.list("sourcing_record", candidate_id=candidate_id)
        ],
        "requirements": requirements,
        "tasks": tasks,
        "connectors": CONNECTORS,
        "stage_ready": bool(requirements) and all(item["ready_for_stage"] for item in requirements),
        "formal_screening_status": candidate.get("screening_status", "UNCHECKED"),
    }


def parse_source_link(url: str) -> dict[str, str]:
    if not url or len(url) > 2048 or any(ord(char) < 32 for char in url):
        raise DomainError("UNSUPPORTED_SOURCE_URL", "链接不安全或不受支持")
    parsed = urlparse(url)
    try:
        unsafe_authority = bool(parsed.username or parsed.password or parsed.port)
        host = (parsed.hostname or "").lower().rstrip(".")
    except ValueError as exc:
        raise DomainError("UNSUPPORTED_SOURCE_URL", "链接端口无效") from exc
    if parsed.scheme != "https" or unsafe_authority:
        raise DomainError("UNSUPPORTED_SOURCE_URL", "仅支持安全的 HTTPS 商品链接")
    path = unquote(parsed.path)
    import re

    patterns = [
        ("1688", "detail.1688.com", r"^/offer/(\d+)\.html$"),
        ("YIWUGO", "www.yiwugo.com", r"^/(?:product/detail|products)/(\d+)(?:\.html)?$"),
        ("YIWUGO", "en.yiwugo.com", r"^/(?:product/detail|products)/(\d+)(?:\.html)?$"),
        ("YIWUGO", "wap.yiwugo.com", r"^/(?:product/detail|products)/(\d+)(?:\.html)?$"),
        ("ALIBABA", "www.alibaba.com", r"^/product-detail/[^/]*_(\d+)\.html$"),
    ]
    for platform, expected_host, pattern in patterns:
        match = re.fullmatch(pattern, path)
        if host == expected_host and match:
            product_id = match.group(1)
            return {
                "platform": platform,
                "product_id": product_id,
                "normalized_url": f"https://{expected_host}{path}",
                "connector_status": "AUTHORIZATION_REQUIRED",
            }
    raise DomainError("UNSUPPORTED_SOURCE_URL", "链接不是受支持平台的商品详情页")
