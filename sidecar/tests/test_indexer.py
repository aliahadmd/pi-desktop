"""Indexer tests: incremental indexing, corruption resilience, removal."""
import json
import os
import sqlite3
import time
from pathlib import Path

from app import indexer


def _session_file(sessions_dir: Path) -> Path:
    return next(sessions_dir.rglob("*.jsonl"))


def test_incremental_indexes_new_files(db: sqlite3.Connection, sessions_dir: Path) -> None:
    result = indexer.run_incremental(db, sessions_dir)
    assert result["indexed_files"] == 1
    assert result["rows"] >= 3  # user + assistant(thinking/text/toolcall) + toolResult
    count = db.execute("SELECT COUNT(*) AS n FROM messages_fts").fetchone()["n"]
    assert count == result["rows"]


def test_unchanged_files_are_skipped(db: sqlite3.Connection, sessions_dir: Path) -> None:
    indexer.run_incremental(db, sessions_dir)
    again = indexer.run_incremental(db, sessions_dir)
    assert again["indexed_files"] == 0
    assert again["rows"] == 0


def test_changed_file_is_reindexed(db: sqlite3.Connection, sessions_dir: Path) -> None:
    indexer.run_incremental(db, sessions_dir)
    target = _session_file(sessions_dir)
    entry = {
        "type": "message",
        "id": "e9",
        "parentId": "e3",
        "timestamp": 1700000009000,
        "message": {"role": "user", "content": "unique-zebra-content"},
    }
    with target.open("a") as f:
        f.write("\n" + json.dumps(entry))
    stat = target.stat()
    os.utime(target, (stat.st_atime, stat.st_mtime + 2))
    time.sleep(0.01)

    result = indexer.run_incremental(db, sessions_dir)
    assert result["indexed_files"] == 1
    hits = indexer.search(db, "unique-zebra-content")
    assert len(hits) == 1
    assert hits[0]["entry_id"] == "e9"


def test_deleted_file_is_removed_from_index(db: sqlite3.Connection, sessions_dir: Path) -> None:
    indexer.run_incremental(db, sessions_dir)
    for path in sessions_dir.rglob("*.jsonl"):
        path.unlink()
    result = indexer.run_incremental(db, sessions_dir)
    assert result["removed"] >= 1
    assert indexer.indexed_count(db) == 0


def test_search_returns_snippets_with_metadata(db: sqlite3.Connection, sessions_dir: Path) -> None:
    indexer.run_incremental(db, sessions_dir)
    hits = indexer.search(db, "auth module")
    assert len(hits) >= 1
    hit = hits[0]
    assert hit["session_id"] == "sess-1"
    assert "<mark>" in hit["snippet"]
    assert hit["cwd"] == "/tmp/test"


def test_malformed_query_returns_empty_not_crash(db: sqlite3.Connection, sessions_dir: Path) -> None:
    indexer.run_incremental(db, sessions_dir)
    assert indexer.search(db, '"unclosed AND (') == []
