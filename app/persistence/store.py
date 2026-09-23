"""Small transactional SQLite repository for the local demonstration workspace."""

from __future__ import annotations

import builtins
import json
import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

DEMO_NOW = datetime(2026, 9, 20, 8, tzinfo=UTC)
IMMUTABLE = frozenset(
    {
        "criteria",
        "evidence",
        "evaluation",
        "decision",
        "submission",
        "outcome",
        "override",
        "validation_conclusion",
        "node_run",
        "submission_invalidation",
        "outcome_review",
        "source",
        "reopen",
        "discovery_batch",
        "discovery_item",
    }
)
RESERVED = frozenset({"id", "kind", "version", "created_at", "project_id", "candidate_id"})


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


class Tx:
    def __init__(
        self,
        connection: sqlite3.Connection,
        now: datetime,
        *,
        mode: str = "demo",
        workspace_id: str | None = None,
    ):
        self.connection = connection
        self.now = now
        self.mode = mode
        self.workspace_id = workspace_id

    def get(self, entity_id: str, kind: str | None = None) -> dict[str, Any]:
        from app.core import DomainError

        row = self.connection.execute("SELECT * FROM entities WHERE id=?", (entity_id,)).fetchone()
        if row is None or (kind is not None and row["kind"] != kind):
            raise DomainError("NOT_FOUND", "记录不存在或类型不匹配", 404)
        return self._entity(row)

    @staticmethod
    def _entity(row: sqlite3.Row) -> dict[str, Any]:
        return {**json.loads(row["data"]), **{key: row[key] for key in RESERVED}}

    def list(
        self, kind: str, *, project_id: str | None = None, candidate_id: str | None = None
    ) -> list[dict[str, Any]]:
        sql, args = "SELECT * FROM entities WHERE kind=?", [kind]
        if project_id is not None:
            sql += " AND project_id=?"
            args.append(project_id)
        if candidate_id is not None:
            sql += " AND candidate_id=?"
            args.append(candidate_id)
        rows = self.connection.execute(sql + " ORDER BY rowid", args).fetchall()
        return [self._entity(row) for row in rows]

    def add(
        self,
        kind: str,
        data: dict[str, Any],
        *,
        entity_id: str | None = None,
        project_id: str | None = None,
        candidate_id: str | None = None,
    ) -> dict[str, Any]:
        entity_id = entity_id or str(uuid4())
        if RESERVED.intersection(data):
            raise ValueError("entity payload contains repository-owned metadata")
        self.connection.execute(
            "INSERT INTO entities VALUES (?,?,?,?,?,?,?)",
            (entity_id, kind, project_id, candidate_id, 1, self.now.isoformat(), encode(data)),
        )
        return self.get(entity_id)

    def update(self, entity_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        old = self.get(entity_id)
        if old["kind"] in IMMUTABLE:
            raise ValueError("immutable snapshots cannot be overwritten")
        if RESERVED.intersection(changes):
            raise ValueError("cannot overwrite repository-owned metadata")
        data = {key: value for key, value in old.items() if key not in RESERVED}
        data.update(changes)
        self.connection.execute(
            "UPDATE entities SET data=?,version=version+1 WHERE id=?", (encode(data), entity_id)
        )
        return self.get(entity_id)

    def audit(
        self, actor: str, action: str, entity_id: str | None, details: dict[str, Any] | None = None
    ) -> None:
        self.connection.execute(
            "INSERT INTO audit VALUES (?,?,?,?,?,?)",
            (str(uuid4()), actor, action, entity_id, self.now.isoformat(), encode(details or {})),
        )

    def activity(self, entity_id: str | None = None) -> builtins.list[dict[str, Any]]:
        sql = "SELECT * FROM audit"
        args: tuple[str, ...] = ()
        if entity_id:
            sql += " WHERE entity_id=?"
            args = (entity_id,)
        rows = self.connection.execute(sql + " ORDER BY rowid DESC", args).fetchall()
        return [{**dict(row), "details": json.loads(row["details"])} for row in rows]


class Store:
    def __init__(
        self,
        path: str | Path,
        *,
        mode: str = "demo",
        workspace_id: str | None = None,
    ):
        if mode not in {"demo", "pilot"}:
            raise ValueError("unknown workspace mode")
        self.mode = mode
        self.workspace_id = workspace_id
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connection()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                exists = conn.execute(
                    "SELECT name FROM sqlite_master WHERE name='schema_version'"
                ).fetchone()
                marked = conn.execute(
                    "SELECT name FROM sqlite_master WHERE name='workspace_metadata'"
                ).fetchone()
                if exists and not marked and mode == "pilot":
                    raise RuntimeError("试点不能打开未标记或历史演示数据库，请使用独立空目录")
                if not exists:
                    script = (
                        Path(__file__)
                        .with_name("migrations")
                        .joinpath("001_initial.sql")
                        .read_text()
                    )
                    # execute statements individually: executescript implicitly commits.
                    for statement in script.split(";"):
                        if statement.strip():
                            conn.execute(statement)
                versions = conn.execute("SELECT version FROM schema_version").fetchall()
                if [row[0] for row in versions] != [1]:
                    raise RuntimeError("不兼容的数据库版本；请使用匹配的代码或备份，未修改数据")
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS workspace_metadata "
                    "(singleton INTEGER PRIMARY KEY CHECK(singleton=1), "
                    "mode TEXT NOT NULL, workspace_id TEXT)"
                )
                row = conn.execute("SELECT * FROM workspace_metadata WHERE singleton=1").fetchone()
                if row is None:
                    conn.execute(
                        "INSERT INTO workspace_metadata VALUES (1,?,?)", (mode, workspace_id)
                    )
                elif row["mode"] != mode or row["workspace_id"] != workspace_id:
                    raise RuntimeError("数据库运行模式或工作区不匹配，未修改数据")
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            conn.execute("PRAGMA journal_mode=WAL")

    def _connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=10000")
        return conn

    @contextmanager
    def transaction(self, now: datetime | None = None) -> Iterator[Tx]:
        conn = self._connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield Tx(
                conn,
                now or (datetime.now(UTC) if self.mode == "pilot" else DEMO_NOW),
                mode=self.mode,
                workspace_id=self.workspace_id,
            )
            conn.commit()
        except Exception as exc:
            # Only explicit domain invalidation/failure records can survive a rejected command.
            if getattr(exc, "commit", False):
                conn.commit()
            else:
                conn.rollback()
            raise
        finally:
            conn.close()
