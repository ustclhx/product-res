"""Candidate discovery selection, manual intake, and two-step CSV import."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import unicodedata
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import ConfigDict, Field, model_validator

from app.api.contracts import APIModel
from app.core import Command, DomainError, require_role
from app.persistence.store import Tx
from app.providers.discovery import FixtureMarketDataProvider

MAX_CSV_BYTES = 2 * 1024 * 1024
MAX_CSV_ROWS = 1_000
_CANONICAL_FIELDS = ("title", "external_id", "source_url", "sku")
_HEADER_ALIASES = {
    "title": ("title", "name", "product_name", "商品名称", "商品名"),
    "external_id": ("external_id", "asin", "item_id", "product_id", "外部标识"),
    "source_url": ("source_url", "url", "link", "商品链接", "来源链接"),
    "sku": ("sku", "seller_sku", "货号"),
}


class CSVMapping(APIModel):
    title: str = Field(min_length=1, max_length=200)
    external_id: str | None = Field(default=None, min_length=1, max_length=200)
    source_url: str | None = Field(default=None, min_length=1, max_length=200)
    sku: str | None = Field(default=None, min_length=1, max_length=200)


class PreviewCandidateImport(APIModel):
    project_id: str = Field(min_length=1)
    filename: str = Field(min_length=1, max_length=255)
    content: str
    mapping: CSVMapping | None = None


class ConfirmCandidateImport(Command):
    # CSV content is hashed byte-for-byte; Command's global whitespace stripping
    # would otherwise turn a valid preview into a mismatched confirmation.
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)

    project_id: str = Field(min_length=1)
    filename: str = Field(min_length=1, max_length=255)
    content: str
    mapping: CSVMapping
    summary_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    selected_rows: list[int] = Field(max_length=MAX_CSV_ROWS)
    skipped_rows: list[int] = Field(max_length=MAX_CSV_ROWS)

    @model_validator(mode="after")
    def _unique_explicit_rows(self) -> ConfirmCandidateImport:
        if len(set(self.selected_rows)) != len(self.selected_rows):
            raise ValueError("selected_rows must be unique")
        if len(set(self.skipped_rows)) != len(self.skipped_rows):
            raise ValueError("skipped_rows must be unique")
        if set(self.selected_rows).intersection(self.skipped_rows):
            raise ValueError("a row cannot be both selected and skipped")
        return self


class ManualCandidateCommand(Command):
    title: str = Field(min_length=1, max_length=300)
    external_id: str | None = Field(default=None, min_length=1, max_length=200)
    source_url: str | None = Field(default=None, min_length=1, max_length=2_000)
    sku: str | None = Field(default=None, min_length=1, max_length=200)


class DiscoveryCommand(Command):
    query: str = Field(min_length=1, max_length=200)
    provider: Literal["dataforseo", "serpapi"] | None = None


class DiscoverySelection(APIModel):
    title: str = Field(min_length=1, max_length=300)
    external_id: str = Field(min_length=1, max_length=200)
    source_url: str = Field(min_length=1, max_length=2_000)
    source_ref: str = Field(min_length=1, max_length=200)
    channel: Literal["AMAZON", "EBAY", "DTC"] | None = None
    market: str | None = None
    is_demo: bool | None = None


class AddDiscoveredCandidateCommand(Command):
    selection: DiscoverySelection | None = None
    batch_id: str | None = None
    item_id: str | None = None

    @model_validator(mode="after")
    def one_selection(self) -> AddDiscoveredCandidateCommand:
        live = self.batch_id is not None and self.item_id is not None
        if (self.batch_id is None) != (self.item_id is None):
            raise ValueError("batch_id and item_id are required together")
        if live == (self.selection is not None):
            raise ValueError("select one demo item or one persisted batch item")
        return self


def _text(value: Any) -> str | None:
    if value is None:
        return None
    result = unicodedata.normalize("NFKC", str(value)).strip()
    return result or None


def _normalized_url(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = urlsplit(value.strip())
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            return None
        host = parsed.hostname.casefold()
        if parsed.port:
            host += f":{parsed.port}"
    except ValueError:
        return None
    path = parsed.path.rstrip("/") or "/"
    return urlunsplit((parsed.scheme.lower(), host, path, parsed.query, ""))


def _require_url(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = _normalized_url(value)
    if normalized is None:
        raise DomainError("INVALID_SOURCE_URL", "来源链接必须是有效的 http(s) 地址", 422)
    return normalized


def _identity_match(
    candidates: list[dict[str, Any]], external_id: str | None, source_url: str | None
) -> dict[str, Any] | None:
    normalized_id = external_id.casefold() if external_id else None
    normalized_url = _normalized_url(source_url)
    if normalized_id:
        for candidate in candidates:
            existing_id = _text(candidate.get("external_id"))
            if existing_id and normalized_id == existing_id.casefold():
                return candidate
    if normalized_url:
        for candidate in candidates:
            if normalized_url == _normalized_url(candidate.get("source_url")):
                return candidate
    return None


def _add_candidate(
    tx: Tx,
    project: dict[str, Any],
    *,
    title: str,
    external_id: str | None,
    source_url: str | None,
    sku: str | None,
    entry_kind: Literal["DISCOVERY", "MANUAL", "CSV"],
    provider: str,
    source_ref: str,
    is_demo: bool,
    raw: dict[str, Any] | None = None,
) -> dict[str, Any]:
    title_value = _text(title)
    if not title_value:
        raise DomainError("CANDIDATE_TITLE_REQUIRED", "候选商品名称不能为空", 422)
    external_id_value = _text(external_id)
    source_url_value = _require_url(_text(source_url))
    sku_value = _text(sku)
    candidates = tx.list("candidate", project_id=project["id"])
    candidate = _identity_match(candidates, external_id_value, source_url_value)
    reused = candidate is not None
    if candidate is None:
        candidate = tx.add(
            "candidate",
            {
                "title": title_value,
                "external_id": external_id_value,
                "source_url": source_url_value,
                "business_status": "PREPARING",
                "screening_status": "UNCHECKED",
                "current_evaluation_id": None,
                "current_submission_id": None,
                "approval_id": None,
                "sku": sku_value,
                "market": project["market"],
                "is_demo": is_demo,
            },
            project_id=project["id"],
        )
    source = tx.add(
        "source",
        {
            "entry_kind": entry_kind,
            "provider": provider,
            "source_ref": source_ref,
            "external_id": external_id_value,
            "source_url": source_url_value,
            "collected_at": tx.now,
            "is_demo": is_demo,
            "raw": raw or {},
        },
        project_id=project["id"],
        candidate_id=candidate["id"],
    )
    return {"candidate": candidate, "source": source, "reused": reused}


def discover_candidates(
    tx: Tx,
    actor_id: str,
    command: DiscoveryCommand,
    project_id: str,
    provider: FixtureMarketDataProvider | None = None,
) -> dict[str, Any]:
    project = tx.get(project_id, "project")
    require_role(tx, project, actor_id, "analyst")
    if not project.get("current_criteria_id"):
        raise DomainError("CRITERIA_NOT_CONFIRMED", "请先确认项目标准再发现候选", 422)
    return (provider or FixtureMarketDataProvider()).discover(
        str(project["channel"]), str(project["market"]), command.query
    )


def add_discovered_candidate(
    tx: Tx,
    actor_id: str,
    command: AddDiscoveredCandidateCommand,
    project_id: str,
    provider: FixtureMarketDataProvider | None = None,
) -> dict[str, Any]:
    if command.selection is None:
        raise DomainError("DISCOVERY_SELECTION_INVALID", "请选择示例条目")
    project = tx.get(project_id, "project")
    require_role(tx, project, actor_id, "analyst")
    fixture_item = (provider or FixtureMarketDataProvider()).get_item(
        str(project["channel"]), command.selection.external_id
    )
    if fixture_item is None or any(
        fixture_item[field] != getattr(command.selection, field)
        for field in ("title", "source_url", "source_ref")
    ):
        raise DomainError(
            "DISCOVERY_SELECTION_INVALID", "所选候选不属于当前示例发现结果，请重新发现", 422
        )
    wrong_channel = command.selection.channel not in {None, project["channel"]}
    wrong_market = command.selection.market not in {None, project["market"]}
    if wrong_channel or wrong_market:
        raise DomainError("DISCOVERY_SELECTION_INVALID", "所选候选的渠道或市场不匹配", 422)
    return _add_candidate(
        tx,
        project,
        title=fixture_item["title"],
        external_id=fixture_item["external_id"],
        source_url=fixture_item["source_url"],
        sku=None,
        entry_kind="DISCOVERY",
        provider="fixture",
        source_ref=fixture_item["source_ref"],
        is_demo=True,
    )


def add_manual_candidate(
    tx: Tx, actor_id: str, command: ManualCandidateCommand, project_id: str
) -> dict[str, Any]:
    project = tx.get(project_id, "project")
    require_role(tx, project, actor_id, "analyst")
    if tx.mode == "pilot" and not (command.external_id or command.source_url):
        raise DomainError("CANDIDATE_IDENTITY_REQUIRED", "请填写商品标识或来源链接以便追溯")
    return _add_candidate(
        tx,
        project,
        title=command.title,
        external_id=command.external_id,
        source_url=command.source_url,
        sku=command.sku,
        entry_kind="MANUAL",
        provider="manual",
        source_ref=f"manual:{actor_id}",
        is_demo=tx.mode == "demo",
    )


def _resolve_mapping(headers: list[str], requested: CSVMapping | None) -> CSVMapping:
    if requested is not None:
        values = requested.model_dump()
        missing = [value for value in values.values() if value is not None and value not in headers]
        if missing:
            raise DomainError(
                "CSV_MAPPING_INVALID", "映射列在 CSV 中不存在", 422, {"missing_columns": missing}
            )
        return requested
    normalized_headers = {header.strip().casefold(): header for header in headers}
    inferred: dict[str, str | None] = {}
    for field in _CANONICAL_FIELDS:
        inferred[field] = next(
            (
                normalized_headers[alias.casefold()]
                for alias in _HEADER_ALIASES[field]
                if alias.casefold() in normalized_headers
            ),
            None,
        )
    if inferred["title"] is None:
        raise DomainError(
            "CSV_MAPPING_REQUIRED",
            "无法识别商品名称列，请明确映射 title",
            422,
            {"headers": headers},
        )
    return CSVMapping.model_validate(inferred)


def _read_csv(filename: str, content: str) -> tuple[list[str], list[dict[str, str]]]:
    if not filename.casefold().endswith(".csv"):
        raise DomainError("CSV_FORMAT_UNSUPPORTED", "仅支持 UTF-8 CSV 文件", 415)
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_CSV_BYTES:
        raise DomainError(
            "CSV_TOO_LARGE", "CSV 文件不能超过 2MB", 413, {"max_bytes": MAX_CSV_BYTES}
        )
    if "\x00" in content:
        raise DomainError("CSV_ENCODING_INVALID", "CSV 包含无效字符，请使用 UTF-8", 422)
    try:
        reader = csv.DictReader(io.StringIO(content.lstrip("\ufeff"), newline=""))
        headers = list(reader.fieldnames or [])
        if not headers or any(not header.strip() for header in headers):
            raise DomainError("CSV_HEADER_INVALID", "CSV 必须包含非空表头", 422)
        if len(set(headers)) != len(headers):
            raise DomainError("CSV_HEADER_INVALID", "CSV 表头不能重复", 422)
        rows = list(reader)
    except (csv.Error, UnicodeError) as exc:
        raise DomainError("CSV_PARSE_FAILED", "CSV 无法解析", 422, {"reason": str(exc)}) from exc
    if len(rows) > MAX_CSV_ROWS:
        raise DomainError(
            "CSV_TOO_MANY_ROWS", "CSV 最多允许 1000 行数据", 413, {"max_rows": MAX_CSV_ROWS}
        )
    return headers, rows


def preview_candidate_import(tx: Tx, request: PreviewCandidateImport) -> dict[str, Any]:
    project = tx.get(request.project_id, "project")
    headers, raw_rows = _read_csv(request.filename, request.content)
    mapping = _resolve_mapping(headers, request.mapping)
    mapping_data = mapping.model_dump()
    existing = tx.list("candidate", project_id=request.project_id)
    seen: list[dict[str, Any]] = []
    preview_rows: list[dict[str, Any]] = []
    counts = {"valid": 0, "invalid": 0, "duplicate": 0}
    for row_number, raw in enumerate(raw_rows, start=2):
        values = {
            field: _text(raw.get(column)) if column is not None else None
            for field, column in mapping_data.items()
        }
        errors: list[str] = []
        if not values["title"]:
            errors.append("商品名称不能为空")
        if tx.mode == "pilot" and not (values["external_id"] or values["source_url"]):
            errors.append("试点候选需要商品标识或来源链接")
        if values["source_url"] and _normalized_url(values["source_url"]) is None:
            errors.append("来源链接必须是有效的 http(s) 地址")
        duplicate = _identity_match(existing + seen, values["external_id"], values["source_url"])
        if errors:
            status = "INVALID"
            counts["invalid"] += 1
        elif duplicate:
            status = "DUPLICATE"
            counts["duplicate"] += 1
        else:
            status = "VALID"
            counts["valid"] += 1
            seen.append(values)
        similar_titles: list[str] = []
        for item in existing:
            existing_title = _text(item.get("title"))
            if (
                existing_title
                and existing_title.casefold() == str(values["title"] or "").casefold()
                and item is not duplicate
            ):
                similar_titles.append(str(item["id"]))
        preview_rows.append(
            {
                "row_number": row_number,
                "status": status,
                "values": values,
                "errors": errors,
                "duplicate_candidate_id": duplicate.get("id") if duplicate else None,
                "similar_title_candidate_ids": similar_titles,
            }
        )

    summary_source = {
        "project_id": request.project_id,
        "filename": request.filename,
        "content_sha256": hashlib.sha256(request.content.encode("utf-8")).hexdigest(),
        "mapping": mapping_data,
        "rows": preview_rows,
    }
    summary_hash = hashlib.sha256(
        json.dumps(
            summary_source, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()
    return {
        "project": {
            "id": project["id"],
            "channel": project["channel"],
            "market": project["market"],
        },
        "summary_hash": summary_hash,
        "mapping": mapping_data,
        "rows": preview_rows,
        "counts": {**counts, "total": len(preview_rows)},
        "limits": {"max_bytes": MAX_CSV_BYTES, "max_rows": MAX_CSV_ROWS},
    }


def confirm_candidate_import(
    tx: Tx, actor_id: str, command: ConfirmCandidateImport
) -> dict[str, Any]:
    project = tx.get(command.project_id, "project")
    require_role(tx, project, actor_id, "analyst")
    preview = preview_candidate_import(
        tx,
        PreviewCandidateImport(
            project_id=command.project_id,
            filename=command.filename,
            content=command.content,
            mapping=command.mapping,
        ),
    )
    if preview["summary_hash"] != command.summary_hash:
        raise DomainError(
            "IMPORT_SUMMARY_MISMATCH", "CSV 内容、映射或重复状态已变化，请重新预览", 409
        )
    all_rows = {int(row["row_number"]) for row in preview["rows"]}
    selected = set(command.selected_rows)
    skipped = set(command.skipped_rows)
    if selected.union(skipped) != all_rows:
        raise DomainError(
            "IMPORT_ROW_SELECTION_REQUIRED",
            "必须明确选择或跳过每一行",
            422,
            {"unresolved_rows": sorted(all_rows - selected - skipped)},
        )
    row_by_number = {int(row["row_number"]): row for row in preview["rows"]}
    invalid_selected = [row for row in selected if row_by_number[row]["status"] == "INVALID"]
    if invalid_selected:
        raise DomainError(
            "IMPORT_INVALID_ROWS_SELECTED",
            "无效行不能确认导入",
            422,
            {"rows": sorted(invalid_selected)},
        )

    items: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    created_count = 0
    reused_count = 0
    for row_number in sorted(selected):
        row = row_by_number[row_number]
        values = row["values"]
        result = _add_candidate(
            tx,
            project,
            title=values["title"],
            external_id=values["external_id"],
            source_url=values["source_url"],
            sku=values["sku"],
            entry_kind="CSV",
            provider="csv",
            source_ref=f"{command.filename}#row={row_number}",
            is_demo=tx.mode == "demo",
            raw={"row_number": row_number, "values": values},
        )
        items.append(result["candidate"])
        sources.append(result["source"])
        if result["reused"]:
            reused_count += 1
        else:
            created_count += 1
    return {
        "items": items,
        "sources": sources,
        "created_count": created_count,
        "reused_count": reused_count,
        "skipped_rows": sorted(skipped),
    }
