"""Operator-only recovery of completed DataForSEO discovery work.

The caller must bind the original job actor's authenticated request identity and
open one transaction.  This module performs no provider or filesystem I/O.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Never
from urllib.parse import urlsplit

from app.core import DomainError, require_role
from app.persistence.store import Tx, encode
from app.pilot import jobs
from app.pilot.services import PilotServices
from app.providers.market import (
    MAX_BODY_BYTES,
    DataForSEOAmazonProvider,
    HttpTransport,
    ProviderError,
    SecretFile,
    UrllibTransport,
)

_DFS_ENDPOINT = "v3/merchant/amazon/products/live/advanced"
_DFS_LOCATION = 2840
_DFS_LANGUAGE = "en_US"
_DFS_HOST = "https://api.dataforseo.com"
_DFS_ID_LIST_URL = f"{_DFS_HOST}/v3/merchant/id_list"
_DFS_TASK_GET_URL = f"{_DFS_HOST}/v3/merchant/amazon/products/task_get/advanced"
_TASK_ID = re.compile(r"^[0-9]{8}-[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9a-fA-F]{12}$")


def _reject(
    code: str, message: str, status: int = 409, *, details: dict[str, Any] | None = None
) -> Never:
    raise DomainError(code, message, status, details)


def _mapping(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _reject("RECONCILIATION_EVIDENCE_INVALID", f"{name}格式无效")
    return value


def _timestamp(value: Any, name: str) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            _reject("RECONCILIATION_EVIDENCE_INVALID", f"{name}时间无效")
    else:
        _reject("RECONCILIATION_EVIDENCE_INVALID", f"{name}时间缺失")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        _reject("RECONCILIATION_EVIDENCE_INVALID", f"{name}必须包含时区")
    return parsed.astimezone(UTC)


def _money(value: Any, name: str, *, zero: bool = False) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        _reject("RECONCILIATION_EVIDENCE_INVALID", f"{name}费用无效")
    try:
        parsed = Decimal(str(value))
    except InvalidOperation:
        _reject("RECONCILIATION_EVIDENCE_INVALID", f"{name}费用无效")
    if not parsed.is_finite() or (parsed != 0 if zero else parsed <= 0):
        _reject("RECONCILIATION_EVIDENCE_INVALID", f"{name}费用无效")
    return parsed


def _task_parameters(value: Any, expected_query: str, name: str) -> Mapping[str, Any]:
    data = _mapping(value, name)
    if (
        data.get("keyword") != expected_query
        or data.get("location_code") != _DFS_LOCATION
        or data.get("language_code") != _DFS_LANGUAGE
    ):
        _reject("RECONCILIATION_INPUT_MISMATCH", f"{name}与冻结查询不匹配")
    return data


def _endpoint(value: Any) -> str:
    if not isinstance(value, str):
        _reject("RECONCILIATION_EVIDENCE_INVALID", "ID List endpoint缺失")
    parsed = urlsplit(value.strip())
    path = parsed.path if parsed.scheme or parsed.netloc else value.strip()
    return path.strip("/")


def _output_metadata(value: Any) -> dict[str, Any]:
    body = encode(value).encode()
    return {
        "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "type": "object",
        "keys": sorted(value),
    }


def prepare_dataforseo_recovery(
    tx: Tx, actor: str, job_id: str, task_id: str, expected_version: int
) -> dict[str, Any]:
    """Validate a browser recovery request before any provider read is performed."""

    job = tx.get(job_id, "job")
    project = tx.get(job["project_id"], "project")
    require_role(tx, project, actor, "analyst")
    snapshot = _mapping(job.get("input_snapshot"), "任务输入")
    if actor != job.get("actor_id"):
        _reject("RECONCILIATION_ACTOR_MISMATCH", "只能由原任务分析负责人执行恢复", 403)
    if tx.workspace_id != snapshot.get("workspace_id"):
        _reject("WORKSPACE_ACCESS_DENIED", "任务不属于当前工作区", 403)
    if snapshot.get("provider") != "dataforseo" or job.get("job_kind") != "discovery":
        _reject("RECONCILIATION_JOB_INVALID", "该任务不支持 DataForSEO 恢复")
    if not _TASK_ID.fullmatch(task_id.strip()):
        _reject("RECONCILIATION_TASK_ID_INVALID", "DataForSEO task ID 格式无效", 422)
    prior = job.get("reconciliation")
    if isinstance(prior, Mapping):
        if prior.get("task_id") != task_id.strip():
            _reject("RECONCILIATION_CONFLICT", "任务已由不同的供应商task恢复")
        return {"job": job, "attempt": None, "task_id": task_id.strip(), "reused": True}
    if isinstance(expected_version, bool) or expected_version != job.get("version"):
        _reject(
            "VERSION_CONFLICT",
            "任务已变化，请刷新后重试",
            details={"current_version": job.get("version")},
        )
    if job.get("status") != jobs.OUTCOME_UNKNOWN:
        _reject("RECONCILIATION_STATE_INVALID", "只能恢复结果未知的任务")
    attempts = [item for item in tx.list("job_attempt") if item.get("job_id") == job_id]
    attempt = next(
        (
            item
            for item in attempts
            if item.get("id") == job.get("active_attempt_id")
            and item.get("status") == "OUTCOME_UNKNOWN"
        ),
        None,
    )
    if attempt is None:
        _reject("RECONCILIATION_ATTEMPT_INVALID", "原结果未知的执行记录缺失")
    return {"job": job, "attempt": attempt, "task_id": task_id.strip(), "reused": False}


def _provider_document(response: Any, name: str) -> dict[str, Any]:
    if response.status_code < 200 or response.status_code >= 300:
        _reject("RECONCILIATION_PROVIDER_CHECK_FAILED", f"{name}未成功，请稍后核对供应商记录")
    if len(response.body) > MAX_BODY_BYTES:
        _reject("RECONCILIATION_PROVIDER_CHECK_FAILED", f"{name}响应超过安全大小限制")
    try:
        document = json.loads(response.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        _reject("RECONCILIATION_PROVIDER_CHECK_FAILED", f"{name}返回无效 JSON")
    if not isinstance(document, dict):
        _reject("RECONCILIATION_PROVIDER_CHECK_FAILED", f"{name}返回格式无效")
    return document


def fetch_dataforseo_recovery(
    configuration: Mapping[str, Any],
    task_id: str,
    attempt: Mapping[str, Any],
    now: datetime,
    *,
    transport: HttpTransport | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Fetch only official fixed-endpoint evidence for an existing DataForSEO task.

    ID List and Task GET are provider read operations. They never submit a new
    market query and the caller cannot supply a URL or response payload.
    """

    if configuration.get("licensed") is not True:
        _reject("RECONCILIATION_PROVIDER_NOT_READY", "来源授权未确认，不能读取供应商结果")
    secret_file = configuration.get("secret_file")
    if not isinstance(secret_file, str) or not secret_file:
        _reject("RECONCILIATION_PROVIDER_NOT_READY", "DataForSEO 凭据未配置")
    timeout_value = configuration.get("timeout_seconds", 30)
    if (
        isinstance(timeout_value, bool)
        or not isinstance(timeout_value, (int, float))
        or not math.isfinite(float(timeout_value))
        or not 1 <= float(timeout_value) <= 120
    ):
        _reject("RECONCILIATION_PROVIDER_NOT_READY", "DataForSEO 超时配置无效")
    claimed_at = _timestamp(attempt.get("claimed_at"), "attempt started")
    finished_at = _timestamp(attempt.get("finished_at"), "attempt finished")
    current = _timestamp(now, "当前")
    if current < claimed_at or current - claimed_at > timedelta(days=30):
        _reject("RECONCILIATION_WINDOW_EXPIRED", "供应商已无法安全提供该任务的元数据或结果")
    try:
        credential = SecretFile(Path(secret_file)).read()
    except ProviderError:
        _reject("RECONCILIATION_PROVIDER_NOT_READY", "DataForSEO 凭据不可用")
    authorization = base64.b64encode(credential.encode()).decode("ascii")
    headers = {"Authorization": f"Basic {authorization}", "Content-Type": "application/json"}
    client = transport or UrllibTransport()
    payload = [
        {
            "datetime_from": (claimed_at - timedelta(minutes=2)).strftime(
                "%Y-%m-%d %H:%M:%S +00:00"
            ),
            "datetime_to": current.strftime("%Y-%m-%d %H:%M:%S +00:00"),
            "limit": 1000,
            "offset": 0,
            "sort": "desc",
            "include_metadata": True,
        }
    ]
    try:
        id_response = client.request(
            "POST",
            _DFS_ID_LIST_URL,
            headers=headers,
            body=json.dumps(payload).encode(),
            timeout=float(timeout_value),
            max_bytes=MAX_BODY_BYTES,
        )
        id_document = _provider_document(id_response, "DataForSEO ID List")
        tasks = id_document.get("tasks")
        rows = (
            tasks[0].get("result")
            if isinstance(tasks, list) and len(tasks) == 1 and isinstance(tasks[0], dict)
            else None
        )
        matches = [row for row in rows or [] if isinstance(row, dict) and row.get("id") == task_id]
        if len(matches) != 1:
            _reject("RECONCILIATION_TASK_NOT_FOUND", "未在原执行窗口找到唯一匹配的 DataForSEO task")
        audit_entry = matches[0]
        task_response = client.request(
            "GET",
            f"{_DFS_TASK_GET_URL}/{task_id}",
            headers=headers,
            body=None,
            timeout=float(timeout_value),
            max_bytes=MAX_BODY_BYTES,
        )
        task_document = _provider_document(task_response, "DataForSEO Task GET")
    except ProviderError:
        _reject("RECONCILIATION_PROVIDER_CHECK_FAILED", "供应商核对未完成，请稍后重试免费恢复")
    # Preserve the original attempt window as the authority; reconcile_discovery
    # validates the provider's posted timestamp against it again before writing.
    if finished_at < claimed_at:
        _reject("RECONCILIATION_ATTEMPT_INVALID", "原执行时间窗口无效")
    return task_document, audit_entry


def reconcile_discovery(
    tx: Tx,
    actor: str,
    job_id: str,
    task_document: dict[str, Any],
    audit_entry: dict[str, Any],
    expected_version: int,
) -> dict[str, Any]:
    """Adopt a verified DataForSEO Task GET result for one unknown discovery job.

    ``audit_entry`` is the matching official ID List row.  It must contain
    ``id`` (or ``task_id``), ``url`` (or ``endpoint``), ``datetime_posted``,
    ``status`` (or ``status_code``), ``cost``, and the row ``metadata``.
    """

    job = tx.get(job_id, "job")
    project = tx.get(job["project_id"], "project")
    require_role(tx, project, actor, "analyst")
    snapshot = _mapping(job.get("input_snapshot"), "任务输入")

    if actor != job.get("actor_id"):
        _reject("RECONCILIATION_ACTOR_MISMATCH", "只能由原任务分析负责人执行恢复", 403)
    if tx.workspace_id != snapshot.get("workspace_id"):
        _reject("WORKSPACE_ACCESS_DENIED", "任务不属于当前工作区", 403)
    if (
        job.get("job_kind") != "discovery"
        or snapshot.get("provider") != "dataforseo"
        or snapshot.get("channel") != "AMAZON"
        or snapshot.get("market") != "US"
    ):
        _reject("RECONCILIATION_JOB_INVALID", "任务不是可恢复的DataForSEO Amazon发现任务")

    task_id_value = audit_entry.get("task_id", audit_entry.get("id"))
    task_id = str(task_id_value).strip() if task_id_value is not None else ""
    prior = job.get("reconciliation")
    if isinstance(prior, Mapping):
        if prior.get("task_id") != task_id:
            _reject("RECONCILIATION_CONFLICT", "任务已由不同的供应商task恢复")
        return {"job": job, "result": job.get("business_result"), "reused": True}

    if isinstance(expected_version, bool) or expected_version != job.get("version"):
        _reject(
            "VERSION_CONFLICT",
            "任务已变化，请刷新后重试",
            details={"current_version": job.get("version")},
        )
    if job.get("status") != jobs.OUTCOME_UNKNOWN:
        _reject("RECONCILIATION_STATE_INVALID", "只能恢复结果未知的任务")
    if job.get("cancel_requested_at") is not None:
        _reject("RECONCILIATION_CANCELLED", "已请求取消的任务不能恢复")
    if project.get("version") != snapshot.get("project_version"):
        _reject("RECONCILIATION_INPUT_STALE", "项目输入已变化，不能纳入旧查询")
    if not PilotServices.input_is_current(tx, job):
        _reject("RECONCILIATION_INPUT_STALE", "项目输入已变化，不能纳入旧查询")

    attempts = [item for item in tx.list("job_attempt") if item.get("job_id") == job_id]
    attempt = next(
        (
            item
            for item in attempts
            if item.get("id") == job.get("active_attempt_id")
            and item.get("status") == "OUTCOME_UNKNOWN"
        ),
        None,
    )
    if attempt is None:
        _reject("RECONCILIATION_ATTEMPT_INVALID", "原结果未知的执行记录缺失")

    if not task_id:
        _reject("RECONCILIATION_EVIDENCE_INVALID", "ID List task id缺失")
    if _endpoint(audit_entry.get("endpoint", audit_entry.get("url"))) != _DFS_ENDPOINT:
        _reject("RECONCILIATION_EVIDENCE_INVALID", "ID List endpoint不匹配")
    id_status = audit_entry.get("status_code", audit_entry.get("status"))
    if isinstance(id_status, bool) or id_status != 20000:
        _reject("RECONCILIATION_EVIDENCE_INVALID", "ID List未确认task成功")
    id_cost = _money(audit_entry.get("cost"), "ID List")
    id_metadata = _task_parameters(
        audit_entry.get("metadata"), str(snapshot.get("query")), "ID List metadata"
    )
    if (
        id_metadata.get("api") != "merchant"
        or id_metadata.get("function") != "products"
        or id_metadata.get("se") != "amazon"
    ):
        _reject("RECONCILIATION_EVIDENCE_INVALID", "ID List metadata来源不匹配")

    posted_at = _timestamp(
        audit_entry.get("datetime_posted", audit_entry.get("posted_at")), "ID List posted"
    )
    started_at = _timestamp(attempt.get("claimed_at"), "attempt started")
    finished_at = _timestamp(attempt.get("finished_at"), "attempt finished")
    if not started_at <= posted_at <= finished_at + timedelta(seconds=120):
        _reject("RECONCILIATION_TIME_MISMATCH", "供应商task不在原执行窗口内")

    document = _mapping(task_document, "Task GET响应")
    if document.get("status_code") != 20000:
        _reject("RECONCILIATION_RESPONSE_INVALID", "Task GET响应未成功")
    task_get_cost = _money(document.get("cost"), "Task GET响应", zero=True)
    task_rows = document.get("tasks")
    if not isinstance(task_rows, list) or len(task_rows) != 1:
        _reject("RECONCILIATION_RESPONSE_INVALID", "Task GET响应必须只含目标task")
    task = _mapping(task_rows[0], "Task GET task")
    if task.get("id") != task_id:
        _reject("RECONCILIATION_TASK_MISMATCH", "Task GET与ID List task id不匹配")
    if task.get("status_code") != 20000:
        _reject("RECONCILIATION_RESPONSE_INVALID", "Task GET task未成功")
    task_cost = _money(task.get("cost"), "Task GET task", zero=True)
    _task_parameters(task.get("data"), str(snapshot.get("query")), "Task GET task data")
    results = task.get("result")
    if not isinstance(results, list) or not results:
        _reject("RECONCILIATION_RESPONSE_INVALID", "Task GET缺少结果")
    result = _task_parameters(results[0], str(snapshot.get("query")), "Task GET result")
    if not isinstance(result.get("items"), list):
        _reject("RECONCILIATION_RESPONSE_INVALID", "Task GET商品结果无效")

    response_hash = hashlib.sha256(encode(task_document).encode()).hexdigest()
    try:
        normalized = DataForSEOAmazonProvider.normalize_response(
            task_document,
            channel="AMAZON",
            market="US",
            direction=str(snapshot["query"]),
            raw_response_hash=response_hash,
            latency_ms=None,
            cost=float(id_cost),
        )
    except ProviderError as exc:
        _reject("RECONCILIATION_RESPONSE_INVALID", str(exc))
    sanitized = PilotServices.output_snapshot(normalized)
    business_result = PilotServices.on_complete(tx, job, normalized)
    reconciliation = {
        "task_id": task_id,
        "method": "DATAFORSEO_ID_LIST_TASK_GET",
        "query_resent": False,
        "prior_status": jobs.OUTCOME_UNKNOWN,
        "id_list_cost": float(id_cost),
        "task_get_cost": {"response": float(task_get_cost), "task": float(task_cost)},
        "task_get_response_hash": response_hash,
        "recovered_at": tx.now.isoformat(),
    }
    updated = tx.update(
        job_id,
        {
            "status": jobs.SUCCEEDED,
            "finished_at": tx.now.isoformat(),
            "result_disposition": "RECONCILED",
            "adoptable": True,
            "business_result": business_result,
            "output_metadata": _output_metadata(sanitized),
            "last_error": None,
            "reconciliation": reconciliation,
        },
    )
    tx.audit(
        actor,
        "JOB_DISCOVERY_RECONCILED",
        job_id,
        {
            "prior_status": jobs.OUTCOME_UNKNOWN,
            "task_id": task_id,
            "task_get_response_hash": response_hash,
            "id_list_cost": float(id_cost),
            "task_get_cost": {"response": float(task_get_cost), "task": float(task_cost)},
            "query_resent": False,
            "batch_id": business_result["batch"]["id"],
        },
    )
    return {"job": updated, "result": business_result, "reused": False}
