"""Explicit, deterministic demo initialization and business-first read models."""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any, cast

from app.core import ACTORS, DomainError
from app.evidence.screening import evaluate_screening
from app.outcomes.service import counts_as_real, record_outcome
from app.persistence.store import Tx, encode
from app.providers.discovery import FixtureMarketDataProvider
from app.selection.decisions import decide_submission, submit_evaluation
from app.selection.evaluations import create_evaluation
from app.selection.intake import (
    AddDiscoveredCandidateCommand,
    DiscoverySelection,
    ManualCandidateCommand,
    add_discovered_candidate,
    add_manual_candidate,
)
from app.selection.projects import (
    ConfirmCriteriaCommand,
    CreateProjectCommand,
    confirm_criteria,
    create_project,
    template_defaults,
)
from app.validation.service import conclude_validation, create_task

SAMPLE_VERSION = "selection-workflow-demo-v1"
WORKSPACE_ID = "demo-workspace"
_ACTIVE_TASK_STATES = frozenset({"TODO", "IN_PROGRESS", "BLOCKED"})


def demo_status(tx: Tx) -> dict[str, Any]:
    row = tx.connection.execute(
        "SELECT id FROM entities WHERE id=? AND kind='demo_workspace'", (WORKSPACE_ID,)
    ).fetchone()
    workspace = tx.get(WORKSPACE_ID, "demo_workspace") if row else None
    return {
        "actors": ACTORS,
        "initialized": workspace is not None,
        "has_business_data": bool(tx.list("project")),
        "sample_version": SAMPLE_VERSION,
        "clock": tx.now.isoformat(),
        "version": workspace["version"] if workspace else None,
    }


def initialize_demo(tx: Tx, actor_id: str) -> dict[str, Any]:
    if tx.mode == "pilot":
        raise DomainError("DEMO_FORBIDDEN", "试点不能初始化示例", 403)
    count = int(tx.connection.execute("SELECT count(*) FROM entities").fetchone()[0])
    if count:
        raise DomainError(
            "DEMO_WORKSPACE_NOT_EMPTY",
            "当前数据库已有业务数据，不能执行示例初始化",
            409,
            {"entity_count": count},
        )
    workspace = tx.add(
        "demo_workspace",
        {
            "sample_version": SAMPLE_VERSION,
            "initialized_by": actor_id,
            "initialized_at": tx.now,
            "reset_at": None,
            "is_demo": True,
        },
        entity_id=WORKSPACE_ID,
    )
    seeded = _seed_content(tx)
    _mark_seed_entities(tx)
    projects = [tx.get(str(item["id"]), "project") for item in seeded["projects"]]
    return {**demo_status(tx), "projects": projects, "workspace": workspace}


def reset_demo(tx: Tx, actor_id: str, sample_version: str) -> dict[str, Any]:
    if tx.mode == "pilot":
        raise DomainError("DEMO_FORBIDDEN", "试点不能重置示例", 403)
    if sample_version != SAMPLE_VERSION:
        raise DomainError(
            "SAMPLE_VERSION_CONFLICT",
            "示例版本已变化，请刷新后确认重置",
            409,
            {"current_sample_version": SAMPLE_VERSION},
        )
    tx.get(WORKSPACE_ID, "demo_workspace")
    tx.connection.execute("DELETE FROM receipts")
    tx.connection.execute("DELETE FROM audit")
    tx.connection.execute("DELETE FROM entities WHERE id<>?", (WORKSPACE_ID,))
    workspace = tx.update(
        WORKSPACE_ID,
        {
            "sample_version": SAMPLE_VERSION,
            "reset_by": actor_id,
            "reset_at": tx.now,
            "is_demo": True,
        },
    )
    seeded = _seed_content(tx)
    _mark_seed_entities(tx)
    projects = [tx.get(str(item["id"]), "project") for item in seeded["projects"]]
    return {**demo_status(tx), "projects": projects, "workspace": workspace}


def add_effort_entry(
    tx: Tx,
    actor_id: str,
    *,
    category: str,
    minutes: int,
    notes: str,
    is_demo: bool,
) -> dict[str, Any]:
    workspace_exists = demo_status(tx)["initialized"]
    item = tx.add(
        "effort_entry",
        {
            "actor_id": actor_id,
            "category": category,
            "minutes": minutes,
            "notes": notes,
            "is_demo": is_demo,
            "recorded_at": tx.now,
        },
    )
    workspace = (
        tx.update(WORKSPACE_ID, {"last_observation_at": tx.now, "last_observation_by": actor_id})
        if workspace_exists
        else None
    )
    return {"item": item, "version": workspace["version"] if workspace else None}


def list_effort_entries(tx: Tx) -> dict[str, Any]:
    return {
        "items": list(reversed(tx.list("effort_entry"))),
        "validation": {
            "status": "PENDING_BASELINE",
            "has_baseline": False,
            "efficiency_percentage": None,
            "message": "尚无人工流程基线，不能计算效率收益",
        },
    }


def workbench(tx: Tx) -> dict[str, Any]:
    candidates = tx.list("candidate")
    candidate_by_id = {str(item["id"]): item for item in candidates}
    tasks = tx.list("task")
    outcomes_by_candidate: dict[str, list[dict[str, Any]]] = {}
    for outcome in tx.list("outcome"):
        if tx.mode == "pilot" and not counts_as_real(outcome):
            continue
        outcomes_by_candidate.setdefault(str(outcome["candidate_id"]), []).append(outcome)

    evidence_tasks_by_candidate: dict[str, list[dict[str, Any]]] = {}
    for task in tasks:
        if task.get("type") == "EVIDENCE" and task.get("state") in _ACTIVE_TASK_STATES:
            evidence_tasks_by_candidate.setdefault(str(task["candidate_id"]), []).append(task)

    pending_evidence: list[dict[str, Any]] = []
    pending_review: list[dict[str, Any]] = []
    pending_outcomes: list[dict[str, Any]] = []
    for candidate in candidates:
        candidate_id = str(candidate["id"])
        evidence_tasks = evidence_tasks_by_candidate.get(candidate_id, [])
        evidence_task = evidence_tasks[0] if evidence_tasks else None
        if (
            candidate.get("business_status") == "RETURNED"
            or candidate.get("screening_status") == "NEEDS_EVIDENCE"
            or evidence_task is not None
        ):
            reason = _evidence_reason(tx, candidate, evidence_task)
            pending_evidence.append(
                {
                    **_queue_item(candidate, reason=reason, next_action="ADD_EVIDENCE"),
                    "evidence_tasks": [
                        {key: task.get(key) for key in (
                            "id", "field", "question", "owner_id", "due_at", "state",
                            "completion_criteria",
                        )}
                        for task in evidence_tasks
                    ],
                    "task_count": len(evidence_tasks),
                }
            )
        if candidate.get("business_status") == "IN_REVIEW":
            pending_review.append(
                _queue_item(
                    candidate,
                    reason="评估已提交，等待决策负责人审阅",
                    next_action="REVIEW_SUBMISSION",
                )
            )
        if candidate.get("business_status") in {
            "OUTCOME_PENDING",
            "REVIEWED",
        } and not outcomes_by_candidate.get(candidate_id):
            pending_outcomes.append(
                _queue_item(
                    candidate,
                    reason="验证已结束，尚未记录经营结果或未上市原因",
                    next_action="RECORD_OUTCOME",
                )
            )

    overdue: list[dict[str, Any]] = []
    for task in tasks:
        if task.get("state") not in _ACTIVE_TASK_STATES:
            continue
        due_at = _parse_time(str(task["due_at"]))
        if due_at >= tx.now:
            continue
        overdue_candidate = candidate_by_id.get(str(task["candidate_id"]))
        if overdue_candidate is None:
            continue
        overdue.append(
            {
                **_queue_item(
                    overdue_candidate,
                    reason=f"任务已逾期：{task['question']}",
                    next_action="UPDATE_TASK",
                ),
                "task_id": task["id"],
                "due_at": task["due_at"],
            }
        )

    coverage: dict[str, dict[str, Any]] = {
        key: {"count": 0, "candidate_ids": []} for key in ("missing", "not_launched", "recorded")
    }
    for candidate in candidates:
        if not candidate.get("approval_id"):
            continue
        candidate_id = str(candidate["id"])
        candidate_outcomes = outcomes_by_candidate.get(candidate_id, [])
        if not candidate_outcomes:
            bucket = "missing"
        elif candidate_outcomes[-1].get("status") == "NOT_LAUNCHED":
            bucket = "not_launched"
        else:
            bucket = "recorded"
        coverage[bucket]["count"] += 1
        coverage[bucket]["candidate_ids"].append(candidate_id)

    return {
        "pending_evidence": pending_evidence,
        "pending_review": pending_review,
        "overdue": overdue,
        "pending_outcomes": pending_outcomes,
        "coverage": coverage,
        "clock": tx.now.isoformat(),
    }


def _parse_time(value: str) -> Any:
    from datetime import datetime

    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _queue_item(candidate: dict[str, Any], *, reason: str, next_action: str) -> dict[str, Any]:
    return {
        "candidate_id": candidate["id"],
        "title": candidate["title"],
        "reason": reason,
        "next_action": next_action,
    }


def _evidence_reason(tx: Tx, candidate: dict[str, Any], task: dict[str, Any] | None) -> str:
    if task is not None:
        return str(task["question"])
    screening_id = candidate.get("current_screening_id")
    if screening_id:
        screening = tx.get(str(screening_id), "screening")
        missing = screening.get("missing_fields") or []
        if missing:
            return "缺少有效证据：" + "、".join(map(str, missing))
    if candidate.get("business_status") == "RETURNED":
        decisions = tx.list("decision", candidate_id=str(candidate["id"]))
        if decisions:
            latest = decisions[-1]
            questions = latest.get("questions") or []
            if questions:
                return "；".join(map(str, questions))
            if latest.get("reason"):
                return str(latest["reason"])
    return "材料不完整，需要补充有效证据"


def _seed_content(tx: Tx) -> dict[str, Any]:
    amazon = _seed_project(tx, "Amazon 户外露营候选", "AMAZON", "amazon-camping-v1")
    ebay = _seed_project(tx, "eBay 户外露营候选", "EBAY", "ebay-camping-v1")
    dtc = _seed_project(tx, "独立站户外露营候选", "DTC", "dtc-camping-v1")

    pending_evidence = _seed_candidate(
        tx,
        amazon,
        title="CampGlow USB-C 可充电营灯",
        external_id="B0CAMP1002",
        sku="AMZ-EVIDENCE-01",
        ready=False,
        discovered=True,
    )
    create_task(
        tx,
        "contributor",
        str(pending_evidence["id"]),
        task_type="EVIDENCE",
        question="补充已核验的采购成本报价",
        owner_id="contributor",
        due_at=tx.now + timedelta(days=3),
        completion_criteria="上传供应商报价并核验币种与单件口径",
        field="procurement_cost",
    )

    amazon_missing = _seed_approved(tx, amazon, "TrailNest 帐篷(待结果)", "AMZ-OUTCOME")
    conclude_validation(
        tx,
        "owner",
        str(amazon_missing["id"]),
        action="FOLLOW_UP",
        reason="验证通过，进入结果跟进",
    )

    _seed_review(tx, ebay, "NorthPine 防风便携露营炉", "EB-CAMP-2101", discovered=True)
    ebay_stopped = _seed_approved(tx, ebay, "DryTrail 防水收纳袋(未上市)", "EBAY-STOP")
    conclude_validation(
        tx,
        "owner",
        str(ebay_stopped["id"]),
        action="STOP",
        reason="样品耐用性未达到目标",
    )
    record_outcome(
        tx,
        "contributor",
        str(ebay_stopped["id"]),
        approval_id=str(ebay_stopped["approval_id"]),
        status="NOT_LAUNCHED",
        window_start=None,
        window_end=None,
        currency=None,
        units=None,
        revenue_basis=None,
        metrics={},
        source_locator="demo:ebay:not-launched",
        is_demo=True,
        reason="供应商样品未通过耐用性验证，未开展经营",
        sku=str(ebay_stopped["sku"]),
    )

    overdue_candidate = _seed_approved(
        tx,
        dtc,
        "WildHaven 模块化露营炊具套装",
        "DTC-CAMP-3101",
        discovered=True,
    )
    task = create_task(
        tx,
        "contributor",
        str(overdue_candidate["id"]),
        task_type="TEST",
        question="完成独立站落地页小流量测试",
        owner_id="analyst",
        due_at=tx.now + timedelta(days=1),
        completion_criteria="记录访问、加购和转化结果",
        expected_metrics={"visits": "100", "add_to_cart": "8"},
    )
    tx.update(task["id"], {"due_at": (tx.now - timedelta(days=1)).isoformat()})

    dtc_recorded = _seed_approved(tx, dtc, "Moss & Ember 营灯串(已回填)", "DTC-RECORDED")
    conclude_validation(
        tx,
        "owner",
        str(dtc_recorded["id"]),
        action="FOLLOW_UP",
        reason="进入示例结果回填",
    )
    record_outcome(
        tx,
        "contributor",
        str(dtc_recorded["id"]),
        approval_id=str(dtc_recorded["approval_id"]),
        status="RECORDED",
        window_start=tx.now - timedelta(days=30),
        window_end=tx.now,
        currency="USD",
        units="40",
        revenue_basis="GROSS",
        metrics={
            "revenue": "2400",
            "refunds": "120",
            "procurement": "920",
            "platform": "72",
            "fulfillment": "360",
            "advertising": "420",
            "other": "80",
        },
        source_locator="demo:dtc:recorded",
        is_demo=True,
        reason=None,
        sku=str(dtc_recorded["sku"]),
    )

    for candidate in tx.list("candidate"):
        tx.audit(
            "system",
            "demo.seed.stage",
            str(candidate["id"]),
            {
                "business_status": candidate["business_status"],
                "screening_status": candidate["screening_status"],
                "is_demo": True,
            },
        )
    return {"projects": [amazon["project"], ebay["project"], dtc["project"]]}


def _seed_project(tx: Tx, name: str, channel: str, template_id: str) -> dict[str, dict[str, Any]]:
    created = create_project(
        tx,
        "owner",
        CreateProjectCommand(
            actor_id="owner",
            name=name,
            channel=channel,
            market="US",
            direction="户外露营",
            goal="演示候选从补证到结果复盘的可追溯流程",
            constraints=["演示数据，不执行外部商业动作"],
            analyst_id="analyst",
            decision_owner_id="owner",
            default_due_days=7,
        ),
    )
    project = created["project"]
    defaults = template_defaults(template_id)
    confirmed = confirm_criteria(
        tx,
        "owner",
        ConfirmCriteriaCommand(
            actor_id="owner",
            expected_version=project["version"],
            parent_revision_id=None,
            **defaults,
        ),
        str(project["id"]),
    )
    return {"project": confirmed["project"], "criteria": confirmed["criteria"]}


def _seed_candidate(
    tx: Tx,
    workspace: dict[str, dict[str, Any]],
    *,
    title: str,
    external_id: str,
    sku: str,
    ready: bool,
    discovered: bool = False,
) -> dict[str, Any]:
    project = workspace["project"]
    if discovered:
        fixture_item = FixtureMarketDataProvider().get_item(str(project["channel"]), external_id)
        if fixture_item is None:
            raise RuntimeError(f"missing discovery fixture for {external_id}")
        created = add_discovered_candidate(
            tx,
            "analyst",
            AddDiscoveredCandidateCommand(
                actor_id="analyst",
                expected_version=project["version"],
                selection=DiscoverySelection(**fixture_item),
            ),
            str(project["id"]),
        )
        candidate = tx.update(str(created["candidate"]["id"]), {"sku": sku})
    else:
        created = add_manual_candidate(
            tx,
            "analyst",
            ManualCandidateCommand(
                actor_id="analyst",
                expected_version=project["version"],
                title=title,
                external_id=external_id,
                source_url=f"https://example.invalid/demo/{external_id.lower()}",
                sku=sku,
            ),
            str(project["id"]),
        )
        candidate = created["candidate"]
    moq = _add_evidence(
        tx,
        project,
        candidate,
        field="moq",
        value="80",
        unit="unit",
        currency=None,
        locator=f"demo:{external_id}:moq",
    )
    if ready:
        _add_evidence(
            tx,
            project,
            candidate,
            field="procurement_cost",
            value="18.50",
            unit="item",
            currency="USD",
            locator=f"demo:{external_id}:procurement-cost",
        )
    evidence = tx.list("evidence", candidate_id=str(candidate["id"]))
    screening_result = evaluate_screening(workspace["criteria"], evidence, [], now=tx.now)
    screening = tx.add(
        "screening",
        {**screening_result, "created_by": "analyst"},
        project_id=str(project["id"]),
        candidate_id=str(candidate["id"]),
    )
    candidate = tx.update(
        str(candidate["id"]),
        {
            "screening_status": screening_result["status"],
            "current_screening_id": screening["id"],
            "seed_evidence_id": moq["id"],
        },
    )
    return candidate


def _add_evidence(
    tx: Tx,
    project: dict[str, Any],
    candidate: dict[str, Any],
    *,
    field: str,
    value: str,
    unit: str,
    currency: str | None,
    locator: str,
) -> dict[str, Any]:
    return tx.add(
        "evidence",
        {
            "field": field,
            "value": value,
            "unit": unit,
            "currency": currency,
            "window": None,
            "source_locator": locator,
            "observed_at": tx.now,
            "valid_until": tx.now + timedelta(days=90),
            "epistemic_kind": "FACT",
            "verification": "VERIFIED",
            "supersedes_id": None,
            "is_demo": True,
            "recorded_by": "contributor",
        },
        project_id=str(project["id"]),
        candidate_id=str(candidate["id"]),
    )


def _seed_evaluation(
    tx: Tx,
    workspace: dict[str, dict[str, Any]],
    candidate: dict[str, Any],
) -> dict[str, Any]:
    evidence = tx.list("evidence", candidate_id=str(candidate["id"]))
    evidence_ids = [str(item["id"]) for item in evidence]
    dimensions = {
        name: {"summary": f"{name} 示例判断，引用当前证据", "evidence_ids": evidence_ids}
        for name in ("demand", "competition", "differentiation", "supply_cost", "risk")
    }
    created = create_evaluation(
        tx,
        "analyst",
        str(candidate["id"]),
        dimensions=dimensions,
        evidence_ids=evidence_ids,
        unknowns=["真实市场表现仍待验证"],
        counterevidence=[],
        assumptions=["所有预测仅用于离线演示"],
        forecast={
            "currency": "USD",
            "window_start": tx.now - timedelta(days=30),
            "window_end": tx.now,
            "revenue_basis": "GROSS",
            "units": "40",
            "metrics": {
                "revenue": "2400",
                "refunds": "120",
                "procurement": "920",
                "platform": "120",
                "fulfillment": "360",
                "advertising": "400",
                "other": "80",
            },
        },
        assistant_versions={"evaluation": "simulated-demo-v1"},
        parent_revision_id=None,
    )
    return cast(dict[str, Any], created["candidate"])


def _seed_review(
    tx: Tx,
    workspace: dict[str, dict[str, Any]],
    title: str,
    external_id: str,
    *,
    discovered: bool = False,
) -> dict[str, Any]:
    candidate = _seed_candidate(
        tx,
        workspace,
        title=title,
        external_id=external_id,
        sku=f"SKU-{external_id}",
        ready=True,
        discovered=discovered,
    )
    candidate = _seed_evaluation(tx, workspace, candidate)
    return cast(
        dict[str, Any],
        submit_evaluation(tx, "analyst", str(candidate["id"]))["candidate"],
    )


def _seed_approved(
    tx: Tx,
    workspace: dict[str, dict[str, Any]],
    title: str,
    external_id: str,
    *,
    discovered: bool = False,
) -> dict[str, Any]:
    candidate = _seed_review(
        tx,
        workspace,
        title,
        external_id,
        discovered=discovered,
    )
    approved = decide_submission(
        tx,
        "owner",
        str(candidate["id"]),
        action="APPROVE",
        reason="示例材料满足进入验证的条件",
        questions=[],
    )
    return cast(dict[str, Any], approved["candidate"])


def _mark_seed_entities(tx: Tx) -> None:
    rows = tx.connection.execute("SELECT id,data FROM entities").fetchall()
    for row in rows:
        data = json.loads(row["data"])
        if data.get("is_demo") is True:
            continue
        data["is_demo"] = True
        tx.connection.execute("UPDATE entities SET data=? WHERE id=?", (encode(data), row["id"]))
