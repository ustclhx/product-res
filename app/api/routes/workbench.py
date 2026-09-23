"""Demo workspace, workbench, activity, and effort observation routes."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import Field, model_validator

from app.core import Command, DomainError, execute
from app.demo.service import (
    WORKSPACE_ID,
    add_effort_entry,
    demo_status,
    initialize_demo,
    list_effort_entries,
    reset_demo,
    workbench,
)
from app.workflow import build_work_items

router = APIRouter(tags=["demo-workbench"])


class InitializeDemoCommand(Command):
    @model_validator(mode="after")
    def no_existing_version(self) -> InitializeDemoCommand:
        if self.expected_version is not None:
            raise ValueError("initialization does not accept an existing version")
        return self


class ResetDemoCommand(Command):
    sample_version: str = Field(min_length=1, max_length=100)


class EffortEntryCommand(Command):
    category: Literal["VERIFICATION", "EVIDENCE", "CORRECTION", "OTHER"]
    minutes: int = Field(ge=1, le=1440, strict=True)
    notes: str = Field(min_length=1, max_length=4000)
    is_demo: bool = True


@router.get("/demo")
def get_demo(request: Request) -> dict[str, Any]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return demo_status(tx)


@router.post("/demo/init")
def post_demo_init(request: Request, command: InitializeDemoCommand) -> dict[str, Any]:
    return execute(
        request,
        command,
        None,
        "demo.initialize",
        lambda tx, actor: initialize_demo(tx, actor),
    )


@router.post("/demo/reset")
def post_demo_reset(request: Request, command: ResetDemoCommand) -> dict[str, Any]:
    if command.expected_version is None:
        raise DomainError("VERSION_REQUIRED", "重置示例需要当前工作区版本", 422)
    return execute(
        request,
        command,
        WORKSPACE_ID,
        "demo.reset",
        lambda tx, actor: reset_demo(tx, actor, command.sample_version),
    )


@router.get("/workbench")
def get_workbench(request: Request) -> dict[str, Any]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return workbench(tx)


@router.get("/work-items")
def get_work_items(request: Request) -> dict[str, Any]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return build_work_items(tx)


@router.get("/activity")
def get_activity(request: Request, entity_id: str | None = None) -> dict[str, Any]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return {"items": tx.activity(entity_id)}


@router.get("/effort-entries")
def get_effort_entries(request: Request) -> dict[str, Any]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        return list_effort_entries(tx)


@router.post("/effort-entries")
def post_effort_entry(request: Request, command: EffortEntryCommand) -> dict[str, Any]:
    with request.app.state.store.transaction(request.app.state.clock()) as tx:
        initialized = demo_status(tx)["initialized"]
    if initialized and command.expected_version is None:
        raise DomainError("VERSION_REQUIRED", "记录试用工时需要当前工作区版本", 422)
    return execute(
        request,
        command,
        WORKSPACE_ID if initialized else None,
        "effort.record",
        lambda tx, actor: add_effort_entry(
            tx,
            actor,
            category=command.category,
            minutes=command.minutes,
            notes=command.notes,
            is_demo=command.is_demo,
        ),
    )
