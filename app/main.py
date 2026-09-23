"""Product research API with isolated demo and authenticated pilot runtimes."""

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api.contracts import APIModel
from app.api.routes import (
    evidence,
    intake,
    outcomes,
    pilot,
    projects,
    reviews,
    sourcing,
    tasks,
    workbench,
)
from app.core import DomainError
from app.persistence.store import DEMO_NOW, Store
from app.pilot.admin import router as admin_router
from app.pilot.auth import SESSION_COOKIE, AuthManager
from app.pilot.auth import router as auth_router
from app.pilot.config import Settings
from app.pilot.context import StoreProxy, bind_request


class HealthResponse(APIModel):
    status: str
    service: str
    mode: str


def create_app(
    db_path: str | Path | None = None,
    clock: Callable[[], datetime] | None = None,
    *,
    settings: Settings | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env(db_path=db_path)
    if settings.mode == "pilot" and clock is not None:
        raise RuntimeError("pilot mode uses real UTC and does not accept an injected clock")
    app = FastAPI(title="product-res", version="0.1.0")
    app.state.settings = settings
    if settings.mode == "demo":
        if settings.demo_db_path is None:
            raise RuntimeError("demo database path is missing")
        app.state.store = Store(settings.demo_db_path)
        app.state.clock = clock or (lambda: DEMO_NOW)
    else:
        app.state.auth = AuthManager.from_settings(settings)
        app.state.store = StoreProxy()
        app.state.clock = lambda: datetime.now(UTC)

    @app.middleware("http")
    async def pilot_request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if settings.mode != "pilot" or not request.url.path.startswith("/api/v1"):
            return await call_next(request)

        manager: AuthManager = request.app.state.auth
        unsafe = request.method.upper() in {"POST", "PUT", "PATCH", "DELETE"}
        try:
            if unsafe:
                manager.validate_origin(request)
            if request.url.path == "/api/v1/health":
                return await call_next(request)
            if request.url.path == "/api/v1/auth/login":
                return await call_next(request)

            identity = manager.authenticate(request.cookies.get(SESSION_COOKIE))
            if unsafe:
                manager.validate_csrf(request, identity)
            if request.url.path.startswith("/api/v1/demo"):
                raise DomainError("DEMO_DISABLED", "试点模式不能初始化、读取或重置演示数据", 403)
            store = manager.control.workspace_store(identity.workspace_id)
            request.state.identity = identity
            with bind_request(identity, store):
                response = await call_next(request)
                response.headers["Cache-Control"] = "no-store"
                return response
        except DomainError as exc:
            return _domain_error_response(exc)

    @app.exception_handler(DomainError)
    async def domain_error(request: Request, exc: DomainError) -> JSONResponse:
        return _domain_error_response(exc)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"field": ".".join(map(str, item["loc"])), "message": item["msg"]}
            for item in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error_code": "INVALID_INPUT",
                "message": "请检查必填项、数值和日期格式",
                "details": {"fields": errors},
            },
        )

    for module in (
        projects,
        intake,
        evidence,
        reviews,
        tasks,
        outcomes,
        workbench,
        sourcing,
        pilot,
    ):
        app.include_router(module.router, prefix="/api/v1")
    if settings.mode == "pilot":
        app.include_router(auth_router, prefix="/api/v1")
        app.include_router(admin_router, prefix="/api/v1")

    @app.get("/api/v1/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(status="ok", service="product-res", mode=settings.mode)

    @app.get("/api/v1/candidates/{candidate_id}")
    def candidate_detail(candidate_id: str) -> dict[str, Any]:
        with app.state.store.transaction(app.state.clock()) as tx:
            candidate = tx.get(candidate_id, "candidate")
            project = tx.get(candidate["project_id"], "project")
            result = {
                "clock": app.state.clock().isoformat(),
                "candidate": candidate,
                "project": project,
                "criteria_versions": tx.list("criteria", project_id=project["id"]),
                "criteria": tx.get(project["current_criteria_id"], "criteria")
                if project.get("current_criteria_id")
                else None,
            }
            for key, kind in {
                "evidence": "evidence",
                "sources": "source",
                "screenings": "screening",
                "overrides": "override",
                "evaluations": "evaluation",
                "submissions": "submission",
                "decisions": "decision",
                "tasks": "task",
                "outcomes": "outcome",
                "obligations": "obligation",
                "feedback": "feedback",
                "node_runs": "node_run",
                "validation_conclusions": "validation_conclusion",
                "submission_invalidations": "submission_invalidation",
                "outcome_reviews": "outcome_review",
                "research_conclusions": "research_conclusion",
                "reopens": "reopen",
            }.items():
                result[key] = tx.list(kind, candidate_id=candidate_id)
            if settings.mode == "pilot":
                from app.selection.live_assistant import project_run

                result["node_runs"] = [project_run(tx, run) for run in result["node_runs"]]
            result["activity"] = tx.activity(candidate_id)
            return result

    return app


def _domain_error_response(exc: DomainError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content=jsonable_encoder(
            {
                "error_code": exc.code,
                "message": exc.message,
                "details": exc.details,
            }
        ),
    )


app = create_app()
