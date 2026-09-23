from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from app.pilot.auth import ControlStore
from scripts.pilot_backup import BackupError, create_backup, restore_backup


def _database(path: Path, job_state: str = "QUEUED") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as db:
        db.executescript(
            """
            CREATE TABLE jobs (
                id TEXT PRIMARY KEY, state TEXT NOT NULL, input_version INTEGER NOT NULL
            );
            INSERT INTO jobs VALUES ('job-1', 'QUEUED', 4);
            CREATE TABLE candidates (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            INSERT INTO candidates VALUES ('candidate-1', 'Pilot sample');
            """
        )
        db.execute("UPDATE jobs SET state = ? WHERE id = 'job-1'", (job_state,))


def test_backup_restore_preserves_unfinished_jobs_and_schema(tmp_path: Path) -> None:
    data = tmp_path / "data"
    _database(data / "control.sqlite3")
    _database(data / "workspaces" / "team-a.sqlite3", "RUNNING")
    backup = tmp_path / "backup"

    create_backup(data, backup, stopped=True)
    restored = restore_backup(backup, tmp_path / "restored")

    with sqlite3.connect(restored / "control.sqlite3") as db:
        assert db.execute("SELECT state, input_version FROM jobs").fetchone() == ("QUEUED", 4)
    with sqlite3.connect(restored / "workspaces" / "team-a.sqlite3") as db:
        assert db.execute("SELECT state FROM jobs").fetchone() == ("RUNNING",)

    manifest = json.loads((backup / "manifest.json").read_text())
    assert manifest["database_count"] == 2
    assert all(entry["integrity_check"] == "ok" for entry in manifest["files"])


def test_backup_requires_explicit_stopped_assertion(tmp_path: Path) -> None:
    data = tmp_path / "data"
    _database(data / "control.sqlite3")
    with pytest.raises(BackupError, match="--stopped"):
        create_backup(data, tmp_path / "backup")


def test_restore_rejects_corruption_and_existing_destination(tmp_path: Path) -> None:
    data = tmp_path / "data"
    _database(data / "control.sqlite3")
    backup = tmp_path / "backup"
    create_backup(data, backup, stopped=True)

    database = backup / "control.sqlite3"
    database.write_bytes(database.read_bytes() + b"corruption")
    with pytest.raises(BackupError, match="checksum mismatch"):
        restore_backup(backup, tmp_path / "restored")
    assert not (tmp_path / "restored").exists()

    repaired = tmp_path / "backup-repaired"
    create_backup(data, repaired, stopped=True)
    destination = tmp_path / "existing"
    destination.mkdir()
    with pytest.raises(BackupError, match="existing destination"):
        restore_backup(repaired, destination)


def test_restore_relocates_control_registry_and_preserves_workspace_job(tmp_path: Path) -> None:
    data = tmp_path / "original"
    control = ControlStore(data / "control.sqlite3", data / "workspaces")
    workspace = control.init_workspace("team-a", "Team A")
    with control.workspace_store(workspace.id).transaction() as tx:
        tx.add("job", {"state": "RUNNING", "input_version": 7}, project_id=None)

    backup = tmp_path / "backup"
    create_backup(data, backup, stopped=True)
    original_manifest = (backup / "manifest.json").read_bytes()
    restored = restore_backup(backup, tmp_path / "restored")

    recovered_control = ControlStore(restored / "control.sqlite3", restored / "workspaces")
    recovered_workspace = recovered_control.list_workspaces()[0]
    assert recovered_workspace.business_db_path == restored / "workspaces/team-a.sqlite3"
    with recovered_control.workspace_store(recovered_workspace.id).transaction() as tx:
        assert tx.list("job")[0]["state"] == "RUNNING"
        assert tx.list("job")[0]["input_version"] == 7
    relocation = json.loads((restored / "restore-relocation.json").read_text())
    assert (restored / "manifest.json").read_bytes() == original_manifest
    assert relocation["source_manifest_sha256"]
    assert relocation["relocations"][0]["new_path"].endswith("workspaces/team-a.sqlite3")
