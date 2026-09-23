"""HTTP boundary for selection projects and criteria revisions."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from app.core import execute
from app.selection.projects import (
    ConfirmCriteriaCommand,
    CreateProjectCommand,
    UpdateProjectCommand,
    confirm_criteria,
    create_project,
    get_project_detail,
    list_projects,
    list_templates,
    update_project,
)

router = APIRouter(tags=["projects"])


@router.get("/project-templates")
def project_templates() -> dict[str, Any]:
    return {"items": list_templates()}


@router.get("/projects")
def projects(request: Request) -> dict[str, Any]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return {"items": list_projects(tx)}


@router.get("/projects/{project_id}")
def project_detail(request: Request, project_id: str) -> dict[str, Any]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return get_project_detail(tx, project_id)


@router.post("/projects")
def create_project_route(request: Request, command: CreateProjectCommand) -> dict[str, Any]:
    return execute(
        request,
        command,
        None,
        "project.create",
        lambda tx, actor: create_project(tx, actor, command),
    )


@router.post("/projects/{project_id}/updates")
def update_project_route(
    request: Request, project_id: str, command: UpdateProjectCommand
) -> dict[str, Any]:
    return execute(
        request,
        command,
        project_id,
        "project.update",
        lambda tx, actor: update_project(tx, actor, command, project_id),
    )


@router.post("/projects/{project_id}/criteria-revisions")
def confirm_criteria_route(
    request: Request, project_id: str, command: ConfirmCriteriaCommand
) -> dict[str, Any]:
    return execute(
        request,
        command,
        project_id,
        "criteria.confirm",
        lambda tx, actor: confirm_criteria(tx, actor, command, project_id),
    )
