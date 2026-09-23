#!/usr/bin/env python3
"""Create and restore self-describing, SQLite-consistent pilot backups.

The operator must stop both the API and worker before invoking this tool.  The
explicit ``--stopped`` assertion is intentional: a backup made while a writer
is running is not an acceptable recovery point for the pilot.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

MANIFEST_NAME = "manifest.json"
MANIFEST_VERSION = 1


class BackupError(RuntimeError):
    """Raised when a backup cannot be safely created or restored."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _sqlite_metadata(path: Path) -> tuple[str, str]:
    """Return integrity result and a stable hash of the schema."""
    try:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as connection:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()
            if not integrity or integrity[0] != "ok":
                raise BackupError(f"SQLite integrity check failed for {path}: {integrity}")
            rows = connection.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master "
                "WHERE sql IS NOT NULL ORDER BY type, name"
            ).fetchall()
        schema = "\n".join(
            "\x1f".join("" if value is None else str(value) for value in row) for row in rows
        )
        return "ok", hashlib.sha256(schema.encode("utf-8")).hexdigest()
    except sqlite3.Error as exc:
        raise BackupError(f"Cannot inspect SQLite database {path}: {exc}") from exc


def _database_files(data_dir: Path, excluded: Path | None = None) -> list[Path]:
    paths = []
    for path in data_dir.rglob("*.sqlite3"):
        if excluded and (path == excluded or excluded in path.parents):
            continue
        if path.is_file():
            paths.append(path)
    if not paths:
        raise BackupError(f"No *.sqlite3 databases found below {data_dir}")
    return sorted(paths)


def _atomic_sqlite_copy(source: Path, destination: Path) -> None:
    """Copy a database through SQLite's backup API, then atomically publish it."""
    temporary = destination.with_name(f".{destination.name}.tmp")
    try:
        with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as source_db:
            with sqlite3.connect(temporary) as destination_db:
                source_db.backup(destination_db)
                destination_db.commit()
        os.replace(temporary, destination)
    except sqlite3.Error as exc:
        temporary.unlink(missing_ok=True)
        raise BackupError(f"Cannot copy SQLite database {source}: {exc}") from exc


def create_backup(data_dir: str | Path, output: str | Path, *, stopped: bool = False) -> Path:
    """Create an atomic backup directory and return its path."""
    if not stopped:
        raise BackupError("refusing backup: pass --stopped after stopping API and worker")
    source = Path(data_dir).resolve()
    target = Path(output).resolve()
    if not source.is_dir():
        raise BackupError(f"data directory does not exist: {source}")
    if target.exists():
        raise BackupError(f"backup destination already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    databases = _database_files(source, target)

    temporary = Path(tempfile.mkdtemp(prefix=f".{target.name}.", dir=target.parent))
    entries: list[dict[str, Any]] = []
    try:
        for database in databases:
            relative = database.relative_to(source)
            destination = temporary / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            _atomic_sqlite_copy(database, destination)
            integrity, schema_hash = _sqlite_metadata(destination)
            entries.append(
                {
                    "path": relative.as_posix(),
                    "sha256": _sha256(destination),
                    "bytes": destination.stat().st_size,
                    "schema_sha256": schema_hash,
                    "integrity_check": integrity,
                }
            )
        manifest = {
            "format": "product-res-pilot-backup",
            "manifest_version": MANIFEST_VERSION,
            "created_at": datetime.now(UTC).isoformat(),
            "database_count": len(entries),
            "files": entries,
        }
        (temporary / MANIFEST_NAME).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        try:
            os.replace(temporary, target)
        except FileExistsError as exc:
            raise BackupError(f"backup destination appeared during backup: {target}") from exc
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return target


def _load_manifest(backup: Path) -> dict[str, Any]:
    try:
        manifest = json.loads((backup / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BackupError(f"invalid backup manifest: {backup}") from exc
    if (
        manifest.get("format") != "product-res-pilot-backup"
        or manifest.get("manifest_version") != MANIFEST_VERSION
    ):
        raise BackupError("unsupported backup manifest")
    files = manifest.get("files")
    if not isinstance(files, list) or manifest.get("database_count") != len(files):
        raise BackupError("backup manifest file list is invalid")
    return manifest


def _verify_backup(backup: Path, manifest: dict[str, Any]) -> None:
    seen: set[str] = set()
    for entry in manifest["files"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise BackupError("backup manifest contains an invalid file entry")
        relative = Path(entry["path"])
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or relative == Path(".")
            or relative.name != relative.name.strip()
        ):
            raise BackupError(f"unsafe backup path: {entry.get('path')!r}")
        key = relative.as_posix()
        if key in seen:
            raise BackupError(f"duplicate backup path: {key}")
        seen.add(key)
        database = backup / relative
        try:
            database.resolve().relative_to(backup.resolve())
        except ValueError as exc:
            raise BackupError(f"backup path escapes root: {relative}") from exc
        if (
            database.is_symlink()
            or not database.is_file()
            or _sha256(database) != entry.get("sha256")
        ):
            raise BackupError(f"backup checksum mismatch: {relative}")
        integrity, schema_hash = _sqlite_metadata(database)
        if integrity != entry.get("integrity_check") or schema_hash != entry.get("schema_sha256"):
            raise BackupError(f"backup metadata mismatch: {relative}")


def _relocate_control_registry(
    control_path: Path,
    runtime_data_dir: Path,
    manifest: dict[str, Any],
) -> list[dict[str, str]]:
    """Relink absolute workspace paths and revoke sessions after relocation."""
    manifest_paths = {str(entry["path"]) for entry in manifest["files"]}
    relocations: list[dict[str, str]] = []
    with sqlite3.connect(control_path) as connection:
        connection.row_factory = sqlite3.Row
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if "workspaces" in tables:
            rows = connection.execute(
                "SELECT id, slug, business_db_path FROM workspaces"
            ).fetchall()
            for row in rows:
                relative = f"workspaces/{row['slug']}.sqlite3"
                if relative not in manifest_paths:
                    raise BackupError(
                        f"workspace {row['id']} does not map to backup file {relative}"
                    )
                old_path = str(row["business_db_path"])
                new_path = str((runtime_data_dir / relative).resolve())
                connection.execute(
                    "UPDATE workspaces SET business_db_path=? WHERE id=?",
                    (new_path, row["id"]),
                )
                relocations.append(
                    {"workspace_id": str(row["id"]), "old_path": old_path, "new_path": new_path}
                )
        if "sessions" in tables:
            connection.execute(
                "UPDATE sessions SET revoked_at=? WHERE revoked_at IS NULL",
                (datetime.now(UTC).isoformat(),),
            )
        connection.commit()
    return relocations


def restore_backup(
    backup: str | Path,
    destination: str | Path,
    *,
    runtime_data_dir: str | Path | None = None,
) -> Path:
    """Verify a backup and restore it into a new, isolated directory."""
    source = Path(backup).resolve()
    target = Path(destination).resolve()
    if not source.is_dir():
        raise BackupError(f"backup directory does not exist: {source}")
    if target.exists():
        raise BackupError(f"refusing restore into existing destination: {target}")
    manifest = _load_manifest(source)
    _verify_backup(source, manifest)
    runtime_root = Path(runtime_data_dir or target).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{target.name}.", dir=target.parent))
    try:
        for entry in manifest["files"]:
            relative = Path(entry["path"])
            destination_file = temporary / relative
            destination_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / relative, destination_file)
        relocation = _relocate_control_registry(
            temporary / "control.sqlite3", runtime_root, manifest
        ) if (temporary / "control.sqlite3").is_file() else []
        # Preserve the source proof byte-for-byte; relocation metadata is kept
        # in a separate file so it cannot alter what was originally verified.
        shutil.copy2(source / MANIFEST_NAME, temporary / MANIFEST_NAME)
        (temporary / "restore-relocation.json").write_text(
            json.dumps(
                {
                    "format": "product-res-pilot-restore",
                    "source_manifest_sha256": _sha256(source / MANIFEST_NAME),
                    "runtime_data_dir": str(runtime_root),
                    "relocations": relocation,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        try:
            os.replace(temporary, target)
        except FileExistsError as exc:
            raise BackupError(f"restore destination appeared during restore: {target}") from exc
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    backup_parser = subparsers.add_parser("backup", help="create a verified backup")
    backup_parser.add_argument("--data-dir", required=True, type=Path)
    backup_parser.add_argument("--output", required=True, type=Path)
    backup_parser.add_argument("--stopped", action="store_true", help="API and worker are stopped")
    restore_parser = subparsers.add_parser(
        "restore", help="verify and restore into a new directory"
    )
    restore_parser.add_argument("--backup", required=True, type=Path)
    restore_parser.add_argument("--destination", required=True, type=Path)
    restore_parser.add_argument(
        "--runtime-data-dir",
        type=Path,
        help="data root visible to the restored runtime (defaults to destination)",
    )
    args = parser.parse_args()
    try:
        if args.command == "backup":
            result = create_backup(args.data_dir, args.output, stopped=args.stopped)
        else:
            result = restore_backup(
                args.backup, args.destination, runtime_data_dir=args.runtime_data_dir
            )
    except BackupError as exc:
        parser.error(str(exc))
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
