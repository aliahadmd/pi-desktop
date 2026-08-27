"""Indexer transaction safety (audit 6 M-13).

Writes commit per batch of files; a failure mid-run must roll back only the
in-flight batch — never leave a half-written batch committed, never undo
batches that already committed, and never hold the WAL write lock past the
failure.
"""
import json
import sqlite3
from pathlib import Path

import pytest

from app import indexer
from app.db import connect


def _write_session(sessions_dir: Path, name: str, term: str) -> None:
    entries = [
        {
            "type": "session",
            "id": f"s-{term}",
            "parentId": None,
            "timestamp": 1700000000000,
            "cwd": "/tmp/batch",
            "version": 3,
        },
        {
            "type": "message",
            "id": f"e-{term}",
            "parentId": None,
            "timestamp": 1700000001000,
            "message": {"role": "user", "content": f"content {term}"},
        },
    ]
    (sessions_dir / name).write_text("\n".join(json.dumps(e) for e in entries))


def _db_path(db: sqlite3.Connection) -> Path:
    return Path(str(db.execute("PRAGMA database_list").fetchone()[2]))


def _indexed_paths(conn: sqlite3.Connection) -> set[str]:
    return {row["file_path"] for row in conn.execute("SELECT file_path FROM index_state")}


def test_failed_batch_rolls_back_but_earlier_batches_stay_committed(
    db: sqlite3.Connection, sessions_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    batch_size = 8
    for i in range(24):
        _write_session(sessions_dir, f"f{i:02}.jsonl", f"batchterm{i}")

    real_index_file = indexer.index_file

    def boom(conn: sqlite3.Connection, path: Path) -> int:
        if path.name == "f19.jsonl":
            raise RuntimeError("simulated mid-run failure")
        return real_index_file(conn, path)

    monkeypatch.setattr(indexer, "index_file", boom)

    with pytest.raises(RuntimeError, match="simulated mid-run failure"):
        indexer.run_incremental(db, sessions_dir, batch_size=batch_size)

    committed = _indexed_paths(db)
    # At least one full batch committed before the failure, and only whole
    # batches commit — the in-flight batch containing f19 rolled back.
    assert len(committed) >= batch_size
    assert len(committed) % batch_size == 0
    assert not any(p.endswith("f19.jsonl") for p in committed)
    # Files indexed into the failed batch before f19 must be gone too.
    assert not any(p.endswith("f18.jsonl") for p in committed)
    # No orphaned FTS rows without their index_state marker (half-batch proof).
    orphans = db.execute(
        "SELECT COUNT(*) AS n FROM messages_fts "
        "WHERE file_path NOT IN (SELECT file_path FROM index_state)"
    ).fetchone()["n"]
    assert orphans == 0

    # A second connection sees exactly the same committed state: the failed
    # batch was rolled back on disk, not just in this connection's view.
    other = connect(_db_path(db))
    try:
        assert _indexed_paths(other) == committed
    finally:
        other.close()

    # The next run re-indexes the rolled-back files; the index self-heals.
    monkeypatch.setattr(indexer, "index_file", real_index_file)
    result = indexer.run_incremental(db, sessions_dir, batch_size=batch_size)
    assert result["indexed_files"] == 25 - len(committed)
    assert len(_indexed_paths(db)) == 25  # 24 written + 1 fixture file


def test_per_batch_commits_cover_every_file(db: sqlite3.Connection, sessions_dir: Path) -> None:
    for i in range(20):
        _write_session(sessions_dir, f"g{i:02}.jsonl", f"allterm{i}")
    result = indexer.run_incremental(db, sessions_dir, batch_size=8)
    # 20 written files + the conftest fixture file.
    assert result["indexed_files"] == 21
    assert len(_indexed_paths(db)) == 21

    # Everything is committed, visible from a second connection (WAL readers
    # never see the run's intermediate state).
    other = connect(_db_path(db))
    try:
        assert len(_indexed_paths(other)) == 21
        hits = indexer.search(other, "allterm7")
        assert len(hits) == 1
    finally:
        other.close()
