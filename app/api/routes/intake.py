"""HTTP boundary for deterministic discovery and candidate intake."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import Field

from app.core import Command, DomainError, execute
from app.pilot.context import current_identity
from app.selection.intake import (
    AddDiscoveredCandidateCommand,
    ConfirmCandidateImport,
    DiscoveryCommand,
    ManualCandidateCommand,
    PreviewCandidateImport,
    add_discovered_candidate,
    add_manual_candidate,
    confirm_candidate_import,
    discover_candidates,
    preview_candidate_import,
)

router = APIRouter(tags=["candidate-intake"])


class RecoverDataForSEOCommand(Command):
    task_id: str = Field(min_length=1, max_length=100)


@router.get("/projects/{project_id}/discovery/history")
def discovery_history_route(
    request: Request, project_id: str, provider: Literal["dataforseo", "serpapi"]
) -> dict[str, Any]:
    from app.api.routes.pilot import services

    provider_service = services(request)
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return {"items": provider_service.discovery_history(tx, project_id, provider)}


@router.post("/pilot/jobs/{job_id}/recover-dataforseo")
def recover_dataforseo_route(
    request: Request, job_id: str, command: RecoverDataForSEOCommand
) -> dict[str, Any]:
    """Recover an already billed DataForSEO task through fixed provider reads."""

    from app.api.routes.pilot import services
    from app.pilot.reconcile import (
        fetch_dataforseo_recovery,
        prepare_dataforseo_recovery,
        reconcile_discovery,
    )
    from app.pilot.services import public_job

    identity = current_identity()
    if identity is None:
        raise DomainError("AUTH_REQUIRED", "试点操作需要已认证的请求上下文", 401)
    actor = identity.user_id
    if command.actor_id is not None and command.actor_id != actor:
        raise DomainError("FORGED_ACTOR", "请求中的操作者与登录用户不一致", 403)
    if command.expected_version is None:
        raise DomainError("VERSION_REQUIRED", "恢复前请刷新任务版本", 422)
    provider_service = services(request)
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        prepared = prepare_dataforseo_recovery(
            tx, actor, job_id, command.task_id, command.expected_version
        )
        if prepared["reused"]:
            return {"job": public_job(prepared["job"], tx), "reused": True}
        workspace_id = tx.workspace_id
        attempt = prepared["attempt"]
    task_document, audit_entry = fetch_dataforseo_recovery(
        provider_service.config(workspace_id, "dataforseo"),
        prepared["task_id"],
        attempt,
        request.app.state.clock(),
    )
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        recovered = reconcile_discovery(
            tx,
            actor,
            job_id,
            task_document,
            audit_entry,
            command.expected_version,
        )
        return {"job": public_job(recovered["job"], tx), "reused": recovered["reused"]}


@router.post("/projects/{project_id}/discovery")
def discover_route(request: Request, project_id: str, command: DiscoveryCommand) -> dict[str, Any]:
    if getattr(request.app.state, "settings", None) and request.app.state.settings.mode == "pilot":
        from app.api.routes.pilot import services

        provider_service = services(request)
        return execute(
            request,
            command,
            project_id,
            "candidate.discover.live",
            lambda tx, actor: provider_service.enqueue_discovery(
                tx, actor, project_id, command.query, command.provider
            ),
        )
    return execute(
        request,
        command,
        project_id,
        "candidate.discover",
        lambda tx, actor: discover_candidates(tx, actor, command, project_id),
    )


@router.post("/projects/{project_id}/discovery/candidates")
def add_discovered_route(
    request: Request, project_id: str, command: AddDiscoveredCandidateCommand
) -> dict[str, Any]:
    if getattr(request.app.state, "settings", None) and request.app.state.settings.mode == "pilot":
        from app.core import DomainError
        from app.selection.market_intake import select_item

        if command.selection is not None or not command.batch_id or not command.item_id:
            raise DomainError("DISCOVERY_BATCH_REQUIRED", "请选择真实查询批次中的条目")
        return execute(
            request,
            command,
            project_id,
            "candidate.add_discovered.live",
            lambda tx, actor: select_item(
                tx, actor, project_id, str(command.batch_id), str(command.item_id)
            ),
        )
    return execute(
        request,
        command,
        project_id,
        "candidate.add_discovered",
        lambda tx, actor: add_discovered_candidate(tx, actor, command, project_id),
    )


@router.post("/projects/{project_id}/candidates")
def add_manual_route(
    request: Request, project_id: str, command: ManualCandidateCommand
) -> dict[str, Any]:
    return execute(
        request,
        command,
        project_id,
        "candidate.add_manual",
        lambda tx, actor: add_manual_candidate(tx, actor, command, project_id),
    )


@router.post("/candidate-imports/preview")
def preview_import_route(request: Request, preview: PreviewCandidateImport) -> dict[str, Any]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return preview_candidate_import(tx, preview)


@router.post("/candidate-imports/confirm")
def confirm_import_route(request: Request, command: ConfirmCandidateImport) -> dict[str, Any]:
    return execute(
        request,
        command,
        command.project_id,
        "candidate.import_confirm",
        lambda tx, actor: confirm_candidate_import(tx, actor, command),
    )
