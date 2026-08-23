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
    assert hit["cwd"] == "/tmp/test"
    # Snippets ship as structured segments, never as HTML.
    assert "snippet" not in hit
    assert isinstance(hit["segments"], list)
    assert all(set(seg) == {"text", "match"} for seg in hit["segments"])


def test_snippets_split_into_match_segments(db: sqlite3.Connection, sessions_dir: Path) -> None:
    indexer.run_incremental(db, sessions_dir)
    hits = indexer.search(db, "auth")
    assert len(hits) >= 1
    segments = hits[0]["segments"]
    matched = [seg for seg in segments if seg["match"]]
    assert matched, "expected at least one matched segment"
    assert any("auth" in seg["text"].lower() for seg in matched)
    # Delimiters must never survive into the payload.
    assert all("\x1e" not in seg["text"] and "\x1f" not in seg["text"] for seg in segments)


def test_markup_in_content_stays_inert(db: sqlite3.Connection, sessions_dir: Path) -> None:
    """Session content containing HTML must round-trip as literal text.

    Inertness comes from the transport being data -- the text is NOT escaped or
    stripped, it simply never reaches the DOM as markup.
    """
    payload = '<img src=x onerror=alert(1)> unique-xss-needle'
    target = _session_file(sessions_dir)
    entry = {
        "type": "message",
        "id": "e42",
        "parentId": "e3",
        "timestamp": 1700000042000,
        "message": {"role": "user", "content": payload},
    }
    with target.open("a") as f:
        f.write("\n" + json.dumps(entry))
    stat = target.stat()
    os.utime(target, (stat.st_atime, stat.st_mtime + 2))
    time.sleep(0.01)
    indexer.run_incremental(db, sessions_dir)

    hits = indexer.search(db, "unique-xss-needle")
    assert len(hits) == 1
    segments = hits[0]["segments"]
    joined = "".join(str(seg["text"]) for seg in segments)
    # Text preserved verbatim: no escaping, no tag stripping.
    assert "<img" in joined
    assert "onerror=alert(1)" in joined
    assert "&lt;" not in joined
    # And no segment is secretly carrying our highlight markers as text.
    assert all("<mark>" not in str(seg["text"]) for seg in segments)


def test_split_snippet_is_total() -> None:
    """The splitter must never throw, whatever the snippet window produced."""
    assert indexer.split_snippet("") == []
    assert indexer.split_snippet("plain text") == [{"text": "plain text", "match": False}]
    assert indexer.split_snippet("\x1ehit\x1f") == [{"text": "hit", "match": True}]
    assert indexer.split_snippet("a\x1eb\x1fc") == [
        {"text": "a", "match": False},
        {"text": "b", "match": True},
        {"text": "c", "match": False},
    ]
    # Truncated pair (window cut the close delimiter): degrade to plain text.
    assert indexer.split_snippet("a\x1eb") == [
        {"text": "a", "match": False},
        {"text": "b", "match": False},
    ]
    # Stray close delimiter without an open one.
    assert indexer.split_snippet("a\x1fb") == [{"text": "a\x1fb", "match": False}]


def test_malformed_query_returns_empty_not_crash(db: sqlite3.Connection, sessions_dir: Path) -> None:
    indexer.run_incremental(db, sessions_dir)
    assert indexer.search(db, '"unclosed AND (') == []
