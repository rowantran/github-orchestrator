"""SQLite is a run journal, not a second issue tracker. One local runner owns dispatch."""

from __future__ import annotations

import fcntl
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .domain import OrchestratorError, Run

ACTIVE = ("preparing", "running", "review", "published")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def lock_file(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise OrchestratorError(f"Another operation holds {path}. Wait for it to finish.") from exc
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def process_group_alive(pid: int | None) -> bool:
    if pid is None:
        return False
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # uncertainty is never permission to duplicate an agent


class Store:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = root / "runs.sqlite3"
        with self.db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
                INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
                CREATE TABLE IF NOT EXISTS approvals (
                    issue_url TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                    approved_at TEXT NOT NULL, snapshot TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS acknowledgments (
                    issue_url TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, acknowledged_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY, issue_url TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    status TEXT NOT NULL, branch TEXT NOT NULL UNIQUE, worktree TEXT NOT NULL UNIQUE,
                    base_commit TEXT NOT NULL, pid INTEGER, started_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, detail TEXT NOT NULL, pr_url TEXT, commit_sha TEXT,
                    metadata TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_active_issue ON runs(issue_url)
                    WHERE status IN ('preparing','running','review','published');
            """)
            version = db.execute("SELECT version FROM schema_version").fetchone()[0]
            if version != 1:
                raise OrchestratorError(f"Unsupported journal schema {version}; do not reset this database.")
        os.chmod(self.path, 0o600)

    @contextmanager
    def db(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA journal_mode=WAL")
            with db:
                yield db
        finally:
            db.close()

    def lock(self):
        return lock_file(self.root / "runner.lock")

    def approve(self, url: str, fingerprint: str, snapshot: dict) -> None:
        with self.db() as db:
            db.execute("INSERT OR REPLACE INTO approvals VALUES (?, ?, ?, ?)",
                       (url, fingerprint, now(), json.dumps(snapshot, ensure_ascii=False)))

    def approval(self, url: str) -> dict | None:
        with self.db() as db:
            row = db.execute("SELECT * FROM approvals WHERE issue_url=?", (url,)).fetchone()
        if row is None:
            return None
        return {**dict(row), "snapshot": json.loads(row["snapshot"])}

    def revoke(self, url: str) -> None:
        with self.db() as db:
            db.execute("DELETE FROM approvals WHERE issue_url=?", (url,))

    def acknowledge(self, url: str, fingerprint: str) -> None:
        with self.db() as db:
            db.execute("INSERT OR REPLACE INTO acknowledgments VALUES (?, ?, ?)", (url, fingerprint, now()))

    def acknowledgment(self, url: str) -> str | None:
        with self.db() as db:
            row = db.execute("SELECT fingerprint FROM acknowledgments WHERE issue_url=?", (url,)).fetchone()
        return row[0] if row else None

    def create(self, run: Run) -> None:
        run.started_at = run.updated_at = now()
        data = run.as_dict()
        data["commit_sha"] = data.pop("commit")
        data["metadata"] = json.dumps(data["metadata"])
        try:
            with self.db() as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute(f"INSERT INTO runs ({','.join(data)}) VALUES ({','.join('?' for _ in data)})",
                           tuple(data.values()))
        except sqlite3.IntegrityError as exc:
            raise OrchestratorError("An active run, branch or worktree already exists; no duplicate launched.") from exc

    def update(self, run_id: str, **changes) -> Run:
        allowed = {"status", "pid", "base_commit", "detail", "pr_url", "commit", "metadata"}
        if not changes or not set(changes) <= allowed:
            raise ValueError("Invalid run update")
        changes["updated_at"] = now()
        if "commit" in changes:
            changes["commit_sha"] = changes.pop("commit")
        if "metadata" in changes:
            changes["metadata"] = json.dumps(changes["metadata"])
        with self.db() as db:
            result = db.execute(f"UPDATE runs SET {','.join(k+'=?' for k in changes)} WHERE id=?",
                                (*changes.values(), run_id))
            if result.rowcount != 1:
                raise OrchestratorError(f"Unknown run: {run_id}")
        return self.get(run_id)

    @staticmethod
    def _run(row: sqlite3.Row) -> Run:
        data = dict(row)
        data["commit"] = data.pop("commit_sha")
        data["metadata"] = json.loads(data["metadata"])
        return Run(**data)

    def get(self, run_id: str) -> Run:
        with self.db() as db:
            row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if row is None:
            raise OrchestratorError(f"Unknown run: {run_id}")
        return self._run(row)

    def runs(self) -> list[Run]:
        with self.db() as db:
            rows = db.execute("SELECT * FROM runs ORDER BY started_at DESC, id DESC").fetchall()
        return [self._run(row) for row in rows]

    def latest(self, url: str) -> Run | None:
        return next((run for run in self.runs() if run.issue_url == url), None)

    def retry(self, run_id: str) -> Run:
        run = self.get(run_id)
        if run.status not in {"failed", "blocked", "interrupted"}:
            raise OrchestratorError("Only failed, blocked or interrupted attempts can be retried.")
        if process_group_alive(run.pid):
            raise OrchestratorError("The previous process group still exists; refusing a duplicate worker.")
        return self.update(run_id, status="superseded", detail="Operator authorized a fresh attempt; old work retained.")
