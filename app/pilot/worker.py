"""Single-process worker for the two pilot workspace databases."""

from __future__ import annotations

import argparse
import time
from datetime import UTC, datetime
from typing import Any

from app.core import DomainError
from app.persistence.store import Store, Tx
from app.pilot.auth import ControlStore
from app.pilot.config import Settings
from app.pilot.context import RequestIdentity, bind_request
from app.pilot.jobs import ExternalJobError, process_one
from app.pilot.services import PilotServices
from app.selection.market_intake import expire_materials


def worker_identity(control: ControlStore, workspace_id: str, actor: str) -> RequestIdentity:
    workspace = control.get_workspace(workspace_id)
    members = control.workspace_members(workspace_id)
    member = next((item for item in members if item.id == actor), None)
    if member is None:
        raise DomainError("MEMBERSHIP_REVOKED", "任务操作者已无工作区权限", 403)
    return RequestIdentity(
        user_id=member.id,
        username=member.id,
        display_name=member.name,
        workspace_id=workspace_id,
        workspace_name=workspace.name,
        workspace_slug=workspace.slug,
        role=member.role,
        session_id="worker",
        csrf_hash="",
        expires_at="",
        members=members,
    )


def run_one(control: ControlStore, store: Store, providers: PilotServices) -> dict[str, Any] | None:
    identities: dict[str, RequestIdentity | None] = {}

    def runner(job: dict[str, Any]) -> dict[str, Any]:
        try:
            identity = worker_identity(control, str(store.workspace_id), job["actor_id"])
            with bind_request(identity, store), store.transaction(datetime.now(UTC)) as tx:
                if not providers.input_is_current(tx, job):
                    raise ExternalJobError(
                        "INPUT_CHANGED", "任务输入已变化，请重新发起", confirmed_not_sent=True
                    )
        except DomainError as exc:
            raise ExternalJobError(
                "ACCESS_CHANGED", "任务权限已变化，请重新发起", confirmed_not_sent=True
            ) from exc
        result = providers.runner(job)
        # Refresh membership after external I/O, before entering the completion transaction.
        try:
            identities[job["id"]] = worker_identity(
                control, str(store.workspace_id), job["actor_id"]
            )
        except DomainError:
            identities[job["id"]] = None
        return result

    def is_current(tx: Tx, job: dict[str, Any]) -> bool:
        identity = identities.get(job["id"])
        if identity is None:
            return False
        with bind_request(identity, store):
            try:
                return providers.input_is_current(tx, job)
            except DomainError:
                return False

    def finish(tx: Tx, job: dict[str, Any], output: Any) -> Any:
        identity = identities[job["id"]]
        assert identity is not None
        with bind_request(identity, store):
            return providers.on_complete(tx, job, output)

    with store.transaction(datetime.now(UTC)) as tx:
        expire_materials(tx)
    return process_one(
        store,
        runner,
        on_complete=finish,
        input_is_current=is_current,
        output_snapshot_sanitizer=providers.output_snapshot,
        lease_seconds=180,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Run bounded pilot external jobs")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    settings = Settings.from_env()
    if settings.mode != "pilot" or not settings.control_db_path or not settings.workspaces_dir:
        raise SystemExit("worker requires pilot mode and registered workspaces")
    control = ControlStore(settings.control_db_path, settings.workspaces_dir)
    while True:
        providers = PilotServices.from_env()
        for workspace in control.list_workspaces():
            result = run_one(control, control.workspace_store(workspace.id), providers)
            if result is not None:
                print(f"job={result['id']} status={result['status']}", flush=True)
        if args.once:
            return
        time.sleep(1)


if __name__ == "__main__":
    main()
