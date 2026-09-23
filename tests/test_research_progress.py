from datetime import UTC, datetime
from pathlib import Path

from app.persistence.store import Store
from app.pilot.progress import candidate_provenance, research_progress


def test_manual_and_supplier_sources_do_not_borrow_comparator_facts(tmp_path: Path) -> None:
    with Store(tmp_path / "db.sqlite3").transaction(datetime.now(UTC)) as tx:
        project = tx.add("project", {"name": "research"})
        benchmark = tx.add("candidate", {"title": "comparator"}, project_id=project["id"])
        tx.add("source", {"batch_id": "market"}, candidate_id=benchmark["id"])
        candidate = tx.add(
            "candidate",
            {"title": "OEM", "sourcing_profile": {"benchmark_candidate_id": benchmark["id"]}},
            project_id=project["id"],
        )
        assert not candidate_provenance(tx, candidate)["traceable"]
        tx.add(
            "source", {"entry_kind": "MANUAL", "source_ref": "manual"}, candidate_id=candidate["id"]
        )
        assert not candidate_provenance(tx, candidate)["traceable"]
        tx.add(
            "sourcing_record",
            {
                "record_type": "QUOTE",
                "payload": {"supplier_name": "线下厂商"},
                "source_locator": "采购共享盘/报价单 2026-09-22",
            },
            candidate_id=candidate["id"],
        )
        assert candidate_provenance(tx, candidate)["references"][0]["kind"] == "SUPPLIER"
        manual = tx.add("candidate", {"title": "manual"}, project_id=project["id"])
        tx.add("source", {"source_url": "https://example.com/item"}, candidate_id=manual["id"])
        assert candidate_provenance(tx, manual)["traceable"]
        demo = tx.add("candidate", {"title": "demo", "is_demo": True}, project_id=project["id"])
        tx.add("source", {"source_url": "https://example.com/item"}, candidate_id=demo["id"])
        assert not candidate_provenance(tx, demo)["traceable"]


def test_research_cycle_uses_latest_real_conclusion_and_its_feedback(tmp_path: Path) -> None:
    with Store(tmp_path / "db.sqlite3").transaction(datetime.now(UTC)) as tx:
        project = tx.add("project", {"name": "research"})
        candidate = tx.add("candidate", {"title": "OEM"}, project_id=project["id"])
        cid = candidate["id"]
        provenance = {"traceable": True}
        conclusion = tx.add(
            "research_conclusion", {"data_origin": "REAL", "disposition": "HOLD"}, candidate_id=cid
        )
        feedback = tx.add(
            "feedback",
            {"research_conclusion_id": conclusion["id"], "status": "CONFIRMED"},
            candidate_id=cid,
        )
        next_project = tx.add("project", {"source_feedback_id": feedback["id"]})
        progress = research_progress(tx, candidate, [next_project], provenance)
        assert progress["complete"] and progress["disposition"] == "HOLD"
        assert not candidate.get("approval_id")
        tx.add(
            "research_conclusion", {"data_origin": "TEST", "disposition": "STOP"}, candidate_id=cid
        )
        assert not research_progress(tx, candidate, [next_project], provenance)["complete"]
        tx.add(
            "research_conclusion", {"data_origin": "REAL", "disposition": "STOP"}, candidate_id=cid
        )
        assert not research_progress(tx, candidate, [next_project], provenance)["stages"][
            "confirmed_feedback"
        ]
