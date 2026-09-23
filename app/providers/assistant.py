"""Bounded deterministic assistant fixtures for the three workflow nodes."""

from __future__ import annotations

from copy import deepcopy
from enum import StrEnum
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field


class NodeKind(StrEnum):
    EVIDENCE_CHECKLIST = "EVIDENCE_CHECKLIST"
    EVALUATION_ORGANIZER = "EVALUATION_ORGANIZER"
    OUTCOME_REVIEW = "OUTCOME_REVIEW"


class AssistantInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    candidate_id: str = Field(min_length=1)
    criteria_id: str = Field(min_length=1)
    evidence: list[dict[str, Any]]
    missing_fields: list[str] = Field(default_factory=list)
    context: dict[str, Any] = Field(default_factory=dict)


class AssistantStatement(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    text: str = Field(min_length=1)
    kind: str = Field(pattern=r"^(FACT|SUGGESTION)$")
    evidence_ids: list[str] = Field(default_factory=list)


class AssistantOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    node_kind: NodeKind
    summary: str = Field(min_length=1)
    dimensions: dict[str, dict[str, Any]]
    statements: list[AssistantStatement]
    citations: list[str]
    unknowns: list[str]
    counterevidence: list[str]
    assumptions: list[str]
    recommendations: list[str]
    provider: str
    model_version: str
    prompt_version: str
    schema_version: str
    is_simulated: bool


class NodeAssistant(Protocol):
    def run(
        self,
        node_kind: NodeKind,
        input_snapshot: AssistantInput,
        *,
        fixture: str = "default",
    ) -> dict[str, Any]: ...


class SimulatedNodeAssistant:
    """Offline, deterministic fixtures with explicit invalid-output cases."""

    provider = "product-res-fixture"
    model_version = "simulated-2026-09"
    prompt_version = "prompt-v1"
    schema_version = "assistant-output-v1"

    def run(
        self,
        node_kind: NodeKind,
        input_snapshot: AssistantInput,
        *,
        fixture: str = "default",
    ) -> dict[str, Any]:
        evidence_ids = sorted(item["id"] for item in input_snapshot.evidence)
        first_id = evidence_ids[0] if evidence_ids else None
        if node_kind is NodeKind.EVIDENCE_CHECKLIST:
            output = self._evidence_checklist(input_snapshot, first_id)
        elif node_kind is NodeKind.EVALUATION_ORGANIZER:
            output = self._evaluation_organizer(input_snapshot, first_id)
        else:
            output = self._outcome_review(input_snapshot, first_id)
        output.update(
            {
                "node_kind": node_kind,
                "provider": self.provider,
                "model_version": self.model_version,
                "prompt_version": self.prompt_version,
                "schema_version": self.schema_version,
                "is_simulated": True,
            }
        )
        if fixture == "invalid_reference":
            output["citations"] = ["foreign-or-missing-evidence"]
            output["statements"].append(
                {
                    "text": "This fixture deliberately cites foreign evidence.",
                    "kind": "FACT",
                    "evidence_ids": ["foreign-or-missing-evidence"],
                }
            )
        elif fixture == "invalid_structure":
            output.pop("summary")
        elif fixture != "default":
            raise ValueError(f"unknown assistant fixture: {fixture}")
        return deepcopy(output)

    @staticmethod
    def _evidence_checklist(
        snapshot: AssistantInput, first_id: str | None
    ) -> dict[str, Any]:
        missing = sorted(set(snapshot.missing_fields))
        statements = []
        if first_id is not None:
            statements.append(
                {
                    "text": "At least one current evidence item is available for review.",
                    "kind": "FACT",
                    "evidence_ids": [first_id],
                }
            )
        return {
            "summary": "补证清单已按当前材料确定性整理。",
            "dimensions": {},
            "statements": statements,
            "citations": [first_id] if first_id else [],
            "unknowns": missing,
            "counterevidence": [],
            "assumptions": [],
            "recommendations": [f"补充 {field} 的有效来源" for field in missing],
        }

    @staticmethod
    def _evaluation_organizer(
        snapshot: AssistantInput, first_id: str | None
    ) -> dict[str, Any]:
        dimensions = {
            name: {
                "summary": "有待人工复核" if first_id is None else "已整理当前证据",
                "impact": "UNKNOWN" if first_id is None else "MIXED",
            }
            for name in ("demand", "competition", "differentiation", "supply_cost", "risk")
        }
        statements = []
        if first_id is not None:
            statements.append(
                {
                    "text": "The organizer used the current candidate evidence snapshot.",
                    "kind": "FACT",
                    "evidence_ids": [first_id],
                }
            )
        return {
            "summary": "五维材料已整理，结论仍需分析人与负责人复核。",
            "dimensions": dimensions,
            "statements": statements,
            "citations": [first_id] if first_id else [],
            "unknowns": sorted(set(snapshot.missing_fields)),
            "counterevidence": [],
            "assumptions": [],
            "recommendations": ["人工复核未知项和反证后再提交"],
        }

    @staticmethod
    def _outcome_review(snapshot: AssistantInput, first_id: str | None) -> dict[str, Any]:
        statements = []
        if first_id is not None:
            statements.append(
                {
                    "text": "The review retained the cited input as its basis.",
                    "kind": "FACT",
                    "evidence_ids": [first_id],
                }
            )
        return {
            "summary": "偏差复盘建议已生成，规则变化必须由负责人确认。",
            "dimensions": {},
            "statements": statements,
            "citations": [first_id] if first_id else [],
            "unknowns": sorted(set(snapshot.missing_fields)),
            "counterevidence": [],
            "assumptions": [],
            "recommendations": ["核对窗口、币种与成本口径后再考虑下一轮规则"],
        }
