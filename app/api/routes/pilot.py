"""Authenticated pilot job and source status endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Request, Response

from app.core import Command, DomainError, execute, require_role
from app.outcomes.service import counts_as_real
from app.pilot.jobs import cancel
from app.pilot.progress import candidate_provenance, research_progress
from app.pilot.services import PilotServices, public_job
from app.pilot.usage import export_csv, report
from app.selection.market_intake import expire_materials

router = APIRouter(tags=["pilot"])


@router.get("/pilot/progress")
def pilot_progress(request: Request) -> dict[str, Any]:
    services(request)
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        projects = tx.list("project")
        items = []
        for candidate in tx.list("candidate"):
            cid = candidate["id"]
            approval_id = candidate.get("approval_id")
            approval = tx.get(approval_id, "decision") if approval_id else None
            evaluation = tx.get(approval["evaluation_id"], "evaluation") if approval else None
            approved_evidence = set(evaluation.get("evidence_ids", [])) if evaluation else set()
            adopted_run = (
                evaluation.get("assistant_versions", {}).get("node_run_id") if evaluation else None
            )
            real_outcomes = [
                o
                for o in tx.list("outcome", candidate_id=cid)
                if counts_as_real(o)
                and o.get("approval_id") == approval_id
                and (
                    o.get("status") == "NOT_LAUNCHED"
                    or (
                        o.get("window_end")
                        and datetime.fromisoformat(o["window_end"].replace("Z", "+00:00")) <= tx.now
                    )
                )
            ]
            feedback = [
                f
                for f in tx.list("feedback", candidate_id=cid)
                if f.get("status") == "CONFIRMED"
                and f.get("outcome_id") in {o["id"] for o in real_outcomes}
            ]
            provenance = candidate_provenance(tx, candidate)
            research = research_progress(tx, candidate, projects, provenance)
            stages = {
                "market_source": provenance["traceable"],
                "verified_evidence": any(
                    e["id"] in approved_evidence and e.get("verification") == "VERIFIED"
                    for e in tx.list("evidence", candidate_id=cid)
                ),
                "model_draft": any(
                    n["id"] == adopted_run
                    and n.get("is_simulated") is False
                    and n.get("run_state") == "SUCCEEDED"
                    for n in tx.list("node_run", candidate_id=cid)
                ),
                "approval": bool(approval_id),
                "validation": any(
                    v.get("approval_id") == approval_id
                    for v in tx.list("validation_conclusion", candidate_id=cid)
                ),
                "real_outcome": bool(real_outcomes),
                "confirmed_feedback": bool(feedback),
                "next_project": any(
                    p.get("source_feedback_id") in {f["id"] for f in feedback} for p in projects
                ),
            }
            items.append(
                {
                    "candidate_id": cid,
                    "title": candidate["title"],
                    "stages": stages,
                    "provenance": provenance,
                    "research": research,
                    "complete": all(stages.values()),
                    "outcome_ids": [o["id"] for o in real_outcomes],
                    "feedback_ids": [f["id"] for f in feedback],
                }
            )
        return {
            "items": items,
            "completed_count": sum(i["complete"] for i in items),
            "research_completed_count": sum(i["research"]["complete"] for i in items),
            "effort_threshold": None,
            "scope": "current_workspace",
            "message": (
                "研究反馈与经营闭环分别统计；暂缓或停止研究不代表商业验证成功。"
                "测试数据不计入真实闭环；工时按实记录。"
            ),
        }


def services(request: Request) -> PilotServices:
    if (
        getattr(request.app.state, "settings", None) is None
        or request.app.state.settings.mode != "pilot"
    ):
        raise DomainError("PILOT_REQUIRED", "此入口仅供真实试点使用", 404)
    value = getattr(request.app.state, "pilot_services", None)
    if value is None:
        value = PilotServices.from_env()
        request.app.state.pilot_services = value
    assert isinstance(value, PilotServices)
    return value


@router.get("/pilot/sources")
def source_status(request: Request) -> dict[str, Any]:
    providers = services(request)
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return {"items": providers.sources(tx)}


@router.get("/pilot/jobs")
def list_jobs(
    request: Request, project_id: str | None = None, candidate_id: str | None = None
) -> dict[str, Any]:
    services(request)
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        if project_id:
            tx.get(project_id, "project")
        if candidate_id:
            tx.get(candidate_id, "candidate")
        return {
            "items": [
                public_job(j, tx)
                for j in tx.list("job", project_id=project_id, candidate_id=candidate_id)
            ]
        }


def _usage_report(
    request: Request, project_id: str | None, candidate_id: str | None
) -> dict[str, Any]:
    services(request)
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        if project_id:
            tx.get(project_id, "project")
        if candidate_id:
            candidate = tx.get(candidate_id, "candidate")
            if project_id and candidate.get("project_id") != project_id:
                raise DomainError("NOT_FOUND", "记录不存在或类型不匹配", 404)
        return report(tx, project_id=project_id, candidate_id=candidate_id)


@router.get("/pilot/model-usage")
def model_usage(
    request: Request, project_id: str | None = None, candidate_id: str | None = None
) -> dict[str, Any]:
    return _usage_report(request, project_id, candidate_id)


@router.get("/pilot/model-usage/export")
def model_usage_export(
    request: Request, project_id: str | None = None, candidate_id: str | None = None
) -> Response:
    payload = _usage_report(request, project_id, candidate_id)
    return Response(
        content=export_csv(payload["items"]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="model-usage.csv"'},
    )


@router.get("/pilot/jobs/{job_id}")
def get_job(request: Request, job_id: str) -> dict[str, Any]:
    services(request)
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return {"job": public_job(tx.get(job_id, "job"), tx)}


@router.post("/pilot/jobs/{job_id}/cancel")
def cancel_job(request: Request, job_id: str, command: Command) -> dict[str, Any]:
    services(request)

    def operation(tx: Any, actor: str) -> dict[str, Any]:
        job = tx.get(job_id, "job")
        require_role(tx, tx.get(job["project_id"], "project"), actor, "analyst")
        return {"job": public_job(cancel(tx, actor, job_id))}

    return execute(request, command, job_id, "job.cancel", operation)


@router.get("/pilot/batches/{batch_id}")
def get_batch(request: Request, batch_id: str) -> dict[str, Any]:
    services(request)
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        expire_materials(tx)
        batch = tx.get(batch_id, "discovery_batch")
        materials = [
            m
            for m in tx.list("source_material", project_id=batch["project_id"])
            if m["batch_id"] == batch_id
        ]
        return {
            "batch": batch,
            "items": [tx.get(i, "discovery_item") for i in batch["item_ids"]],
            "material_status": materials[0]["status"] if materials else "EXPIRED",
        }
