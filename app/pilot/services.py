"""Workspace-specific provider configuration and job orchestration."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from app.core import DomainError, require_role
from app.persistence.store import Tx
from app.pilot import jobs
from app.providers.market import (
    DataForSEOAmazonProvider,
    DataForSEOConfig,
    ProviderError,
    SecretFile,
    SerpApiConfig,
    SerpApiGoogleShoppingProvider,
)
from app.selection.market_intake import persist_discovery

SOURCE_CHANNELS = {"dataforseo": "AMAZON", "serpapi": "DTC"}
SOURCE_LABELS = {
    "dataforseo": "Amazon 美国站",
    "serpapi": "Google Shopping 美国市场",
    "newapi": "业务整理模型",
}

DEFAULT_MARKET_TIMEOUT_SECONDS = 30.0
MAX_MARKET_TIMEOUT_SECONDS = 120.0


def _market_timeout_seconds(config: dict[str, Any]) -> float:
    """Return a bounded provider deadline from workspace configuration."""

    value = config.get("timeout_seconds", DEFAULT_MARKET_TIMEOUT_SECONDS)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise jobs.ExternalJobError(
            "PROVIDER_CONFIG_INVALID",
            "来源超时配置无效，必须是 1 到 120 秒之间的有限数值",
            confirmed_not_sent=True,
        )
    try:
        timeout = float(value)
    except (OverflowError, ValueError):
        raise jobs.ExternalJobError(
            "PROVIDER_CONFIG_INVALID",
            "来源超时配置无效，必须是 1 到 120 秒之间的有限数值",
            confirmed_not_sent=True,
        ) from None
    if not math.isfinite(timeout) or not 1 <= timeout <= MAX_MARKET_TIMEOUT_SECONDS:
        raise jobs.ExternalJobError(
            "PROVIDER_CONFIG_INVALID",
            "来源超时配置无效，必须是 1 到 120 秒之间的有限数值",
            confirmed_not_sent=True,
        )
    return timeout


class PilotServices:
    def __init__(self, configuration: dict[str, Any] | None = None):
        self.configuration = configuration or {}

    @classmethod
    def from_env(cls) -> PilotServices:
        filename = os.environ.get("PRODUCT_RES_PROVIDERS_FILE")
        if not filename:
            return cls()
        try:
            value = json.loads(Path(filename).read_text())
            if not isinstance(value, dict):
                raise ValueError("expected object")
            return cls(value)
        except (OSError, ValueError) as exc:
            raise RuntimeError("来源配置文件不可用，请检查服务端配置") from exc

    def config(self, workspace_id: str | None, provider: str) -> dict[str, Any]:
        value = self.configuration.get("workspaces", {}).get(workspace_id, {}).get(provider, {})
        if not isinstance(value, dict):
            return {}
        return value

    def status(self, workspace_id: str | None, provider: str) -> str:
        config = self.config(workspace_id, provider)
        if not config or not config.get("secret_file"):
            return "NOT_CONFIGURED"
        if not Path(config["secret_file"]).is_file():
            return "CREDENTIAL_MISSING"
        if provider != "newapi" and config.get("licensed") is not True:
            return "AUTHORIZATION_REQUIRED"
        if not isinstance(config.get("request_limit"), int) or config["request_limit"] < 1:
            return "LIMIT_REQUIRED"
        if provider != "newapi" and not 1 <= config.get("retention_days", 0) <= 365:
            return "RETENTION_REQUIRED"
        if provider == "newapi" and not all(config.get(k) for k in ("model", "base_url")):
            return "NOT_CONFIGURED"
        return "READY"

    def sources(self, tx: Tx) -> list[dict[str, Any]]:
        result = []
        for provider, label in SOURCE_LABELS.items():
            config = self.config(tx.workspace_id, provider)
            used = sum(
                1
                for job in tx.list("job")
                if job.get("input_snapshot", {}).get("provider") == provider
            )
            limit = config.get("request_limit")
            state = self.status(tx.workspace_id, provider)
            if state == "READY" and isinstance(limit, int) and used >= limit:
                state = "QUOTA_EXHAUSTED"
            timeout_seconds: float | None = None
            if provider != "newapi":
                try:
                    timeout_seconds = _market_timeout_seconds(config)
                except jobs.ExternalJobError:
                    timeout_seconds = None
            result.append(
                {
                    "id": provider,
                    "label": label,
                    "status": state,
                    "channel": SOURCE_CHANNELS.get(provider),
                    "market": "US",
                    "request_limit": limit,
                    "requests_reserved": used,
                    "requests_remaining": max(limit - used, 0) if isinstance(limit, int) else None,
                    "result_limit": 10 if provider != "newapi" else None,
                    "query_scope": {
                        "channel": SOURCE_CHANNELS.get(provider),
                        "market": "US",
                        "location": "United States" if provider != "newapi" else None,
                        "language": "en" if provider != "newapi" else None,
                    },
                    "timeout_seconds": timeout_seconds,
                    "is_demo": False,
                }
            )
        return result

    def discovery_history(self, tx: Tx, project_id: str, provider: str) -> list[dict[str, Any]]:
        """Return one project's provider-scoped history without reserving a request."""

        project = tx.get(project_id, "project")
        if SOURCE_CHANNELS.get(provider) != project.get("channel") or project.get("market") != "US":
            raise DomainError("NO_COVERAGE", "该来源不覆盖当前项目渠道或市场")
        items = [
            public_job(job, tx)
            for job in tx.list("job", project_id=project_id)
            if job.get("job_kind") == "discovery"
            and job.get("input_snapshot", {}).get("provider") == provider
        ]
        return sorted(items, key=lambda item: str(item.get("created_at", "")), reverse=True)

    def require_ready(self, tx: Tx, provider: str) -> dict[str, Any]:
        entry = next((s for s in self.sources(tx) if s["id"] == provider), None)
        if not entry or entry["status"] != "READY":
            raise DomainError(
                "PROVIDER_NOT_READY",
                "来源尚未配置、未授权或额度已用完；可先人工录入",
                409,
                {"provider": provider, "status": entry["status"] if entry else "UNSUPPORTED"},
            )
        return self.config(tx.workspace_id, provider)

    def enqueue_discovery(
        self,
        tx: Tx,
        actor: str,
        project_id: str,
        query: str,
        provider: str | None,
    ) -> dict[str, Any]:
        project = tx.get(project_id, "project")
        require_role(tx, project, actor, "analyst")
        if not project.get("current_criteria_id"):
            raise DomainError("CRITERIA_NOT_CONFIRMED", "请先确认项目标准")
        selected = provider or next(
            (key for key, channel in SOURCE_CHANNELS.items() if channel == project["channel"]), ""
        )
        if SOURCE_CHANNELS.get(selected) != project["channel"] or project["market"] != "US":
            raise DomainError("NO_COVERAGE", "首轮来源支持 Amazon 或独立站方向的美国市场")
        config = self.require_ready(tx, selected)
        job = jobs.enqueue(
            tx,
            actor,
            "discovery",
            {
                "workspace_id": tx.workspace_id,
                "provider": selected,
                "query": query,
                "channel": project["channel"],
                "market": project["market"],
                "project_version": project["version"],
                "retention_days": config["retention_days"],
            },
            project_id,
            max_attempts=1,
        )
        return {"job": public_job(job)}

    def enqueue_assistant(
        self,
        tx: Tx,
        actor: str,
        candidate_id: str,
        node_kind: Any,
        outcome_id: str | None = None,
    ) -> dict[str, Any]:
        from app.selection.live_assistant import prepare

        self.require_ready(tx, "newapi")
        config = self.config(tx.workspace_id, "newapi")
        prepared = prepare(tx, actor, candidate_id, node_kind, outcome_id=outcome_id)
        prepared_json = prepared.model_dump(mode="json")
        candidate = tx.get(candidate_id, "candidate")
        job = jobs.enqueue(
            tx,
            actor,
            "assistant",
            {
                "workspace_id": tx.workspace_id,
                "provider": "newapi",
                "prepared": prepared_json,
                "usage_context": {
                    "node_kind": prepared.node_kind.value,
                    "model": config["model"],
                    "input_bytes": len(
                        json.dumps(
                            prepared_json["input_snapshot"],
                            ensure_ascii=False,
                            separators=(",", ":"),
                        ).encode("utf-8")
                    ),
                    "max_output_tokens": int(config.get("max_output_tokens", 18_000)),
                    "max_total_tokens": int(config.get("max_total_tokens", 200_000)),
                },
            },
            candidate["project_id"],
            candidate_id,
            max_attempts=1,
        )
        return {"job": public_job(job)}

    def runner(self, job: dict[str, Any]) -> dict[str, Any]:
        snapshot = job["input_snapshot"]
        provider = snapshot["provider"]
        workspace_id = snapshot["workspace_id"]
        config = self.config(workspace_id, provider)
        if self.status(workspace_id, provider) != "READY":
            raise jobs.ExternalJobError(
                "PROVIDER_NOT_READY", "来源配置已变化，请检查配置", confirmed_not_sent=True
            )
        try:
            if provider == "dataforseo":
                timeout_seconds = _market_timeout_seconds(config)
                market_provider: Any = DataForSEOAmazonProvider(
                    DataForSEOConfig(
                        SecretFile(Path(config["secret_file"])),
                        timeout_seconds=timeout_seconds,
                    )
                )
            elif provider == "serpapi":
                timeout_seconds = _market_timeout_seconds(config)
                market_provider = SerpApiGoogleShoppingProvider(
                    SerpApiConfig(
                        SecretFile(Path(config["secret_file"])),
                        timeout_seconds=timeout_seconds,
                    )
                )
            else:
                from app.providers.newapi import NewAPIAdapter, NewAPIConfig, NewAPIError
                from app.selection.live_assistant import PreparedAssistantRun

                prepared = PreparedAssistantRun.model_validate(snapshot["prepared"])
                base_url = config["base_url"]
                adapter = NewAPIAdapter(
                    NewAPIConfig(
                        base_url=base_url,
                        secret_file=Path(config["secret_file"]),
                        trusted_hosts=frozenset(config.get("trusted_hosts", [])),
                        model=config["model"],
                        thinking_mode=config.get("thinking_mode"),
                        prompt_version=config.get("prompt_version", "newapi-prompt-v2"),
                        allow_http=urlsplit(base_url).scheme == "http",
                        timeout_seconds=min(float(config.get("timeout_seconds", 60)), 120),
                        max_output_tokens=int(config.get("max_output_tokens", 18_000)),
                        max_total_tokens=int(config.get("max_total_tokens", 200_000)),
                        max_requests=1,
                    )
                )
                try:
                    result = adapter.run(prepared.node_kind, prepared.input_snapshot)
                    return result.model_dump(mode="json")
                except NewAPIError as exc:
                    messages = {
                        "NEWAPI.MODEL_ACCESS_REQUIRED": "模型未开通，请联系管理员检查模型访问权限",
                        "NEWAPI.OUTPUT_TRUNCATED": (
                            "模型输出被截断，未写入结果；请缩小输入范围或提高输出上限后重试"
                        ),
                    }
                    raise jobs.ExternalJobError(
                        exc.code,
                        messages.get(
                            exc.code, "模型调用未完成，请查看配置、输入范围或明确发起新尝试"
                        ),
                        outcome_unknown=bool(exc.metadata.get("outcome_unknown", False)),
                        confirmed_not_sent=exc.code
                        in {
                            "NEWAPI.INPUT_BUDGET_EXCEEDED",
                            "NEWAPI.REQUEST_BUDGET_EXHAUSTED",
                            "NEWAPI.NOT_CONFIGURED",
                            "NEWAPI.SECRET_INVALID",
                        },
                        diagnostic=exc.diagnostic,
                    ) from exc
            return dict(
                market_provider.discover(snapshot["channel"], snapshot["market"], snapshot["query"])
            )
        except ProviderError as exc:
            messages = {
                "auth": "来源认证失败，请检查凭据",
                "quota": "来源限流或额度不足",
                "unknown": "来源执行结果未知，请核对调用记录后再发起新尝试",
            }
            raise jobs.ExternalJobError(
                f"MARKET_{exc.code.upper()}",
                messages.get(exc.code, "来源调用失败"),
                outcome_unknown=exc.code == "unknown",
            ) from exc
        except (KeyError, TypeError, ValueError) as exc:
            context = snapshot.get("usage_context")
            raise jobs.ExternalJobError(
                "PROVIDER_CONFIG_INVALID",
                "来源配置或任务输入无效，请检查服务端配置",
                confirmed_not_sent=True,
                diagnostic=context if isinstance(context, dict) else None,
            ) from exc

    @staticmethod
    def input_is_current(tx: Tx, job: dict[str, Any]) -> bool:
        snapshot = job["input_snapshot"]
        if job["job_kind"] == "discovery":
            project = tx.get(job["project_id"], "project")
            require_role(tx, project, job["actor_id"], "analyst")
            return bool(project["version"] == snapshot["project_version"])
        from app.selection.live_assistant import PreparedAssistantRun, current_fingerprint

        prepared = PreparedAssistantRun.model_validate(snapshot["prepared"])
        return current_fingerprint(tx, prepared) == prepared.input_hash

    @staticmethod
    def output_snapshot(output: Any) -> Any:
        """Remove licensed raw market material from durable job output snapshots."""

        if not isinstance(output, dict) or not isinstance(output.get("meta"), dict):
            return output
        sanitized = dict(output)
        metadata = dict(output["meta"])
        metadata.pop("raw", None)
        sanitized["meta"] = metadata
        return sanitized

    @staticmethod
    def on_complete(tx: Tx, job: dict[str, Any], output: Any) -> Any:
        if job["job_kind"] == "discovery":
            return persist_discovery(
                tx,
                job["project_id"],
                output,
                retention_days=job["input_snapshot"]["retention_days"],
            )
        from app.providers.newapi import ProviderResult
        from app.selection.live_assistant import PreparedAssistantRun, persist_result

        return persist_result(
            tx,
            PreparedAssistantRun.model_validate(job["input_snapshot"]["prepared"]),
            ProviderResult.model_validate(output),
        )


def public_job(job: dict[str, Any], tx: Tx | None = None) -> dict[str, Any]:
    error = job.get("last_error") or {}
    attempts = []
    result = job.get("business_result")
    stale = job.get("result_disposition") == "STALE"
    adoptable = bool(job.get("adoptable", False))
    if tx is not None:
        for attempt in tx.list("job_attempt"):
            if attempt.get("job_id") != job["id"]:
                continue
            attempts.append({
                "id": attempt["id"], "state": attempt.get("status"),
                "started_at": attempt.get("claimed_at"), "finished_at": attempt.get("finished_at"),
                "error_message": (attempt.get("error") or {}).get("message"),
                "disposition": attempt.get("result_disposition"),
                "output_metadata": attempt.get("output_metadata"),
                "historical_output": attempt.get("output_snapshot")
                if attempt.get("result_disposition") == "STALE" else None,
            })
        if isinstance(result, dict) and isinstance(result.get("node_run"), dict):
            from app.selection.live_assistant import project_run

            projected_run = project_run(tx, result["node_run"])
            result = {**result, "node_run": projected_run}
            stale = stale or bool(projected_run.get("is_stale"))
            if stale:
                adoptable = False
    snapshot = job.get("input_snapshot")
    if not isinstance(snapshot, dict):
        snapshot = {}
    provider = snapshot.get("provider")
    batch = result.get("batch") if isinstance(result, dict) else None
    batch_metadata = None
    if isinstance(batch, dict):
        batch_metadata = {
            "id": batch.get("id"),
            "provider": batch.get("provider"),
            "query": batch.get("query"),
            "market": batch.get("market"),
            "location": batch.get("location"),
            "language": batch.get("language"),
            "collected_at": batch.get("collected_at"),
            "request_id": batch.get("request_id"),
            "cost": batch.get("cost"),
            "item_count": len(batch.get("item_ids", [])),
        }
    recovery = None
    if job.get("job_kind") == "discovery" and job.get("status") in {
        jobs.FAILED,
        jobs.OUTCOME_UNKNOWN,
    }:
        if provider == "dataforseo" and job.get("status") == jobs.OUTCOME_UNKNOWN:
            recovery = {
                "kind": "DATAFORSEO_TASK_ID",
                "supported": True,
                "message": "先在 DataForSEO 任务记录中取得 task ID，再免费核对并取回原结果。",
            }
        else:
            recovery = {
                "kind": "PROVIDER_CHECK",
                "supported": False,
                "message": (
                    "SerpApi 暂无可安全取回的原任务接口；请先核对供应商记录，"
                    "需要时再明确发起可能计费的新查询。"
                    if provider == "serpapi"
                    else "请先核对来源配置和供应商记录，再明确发起新的外部查询。"
                ),
            }
    return {
        "id": job["id"],
        "version": job["version"],
        "state": job["status"],
        "project_id": job["project_id"],
        "candidate_id": job["candidate_id"],
        "job_kind": job["job_kind"],
        "provider": provider,
        "query": snapshot.get("query"),
        "query_scope": {
            "channel": snapshot.get("channel"),
            "market": snapshot.get("market"),
            "location": "United States" if job.get("job_kind") == "discovery" else None,
            "language": "en" if job.get("job_kind") == "discovery" else None,
        },
        "created_at": job["created_at"],
        "stale": stale,
        "error_code": error.get("code"),
        "error_message": error.get("message"),
        "result": result,
        "batch_metadata": batch_metadata,
        "recovery": recovery,
        "adoptable": adoptable,
        "attempts": attempts,
    }
