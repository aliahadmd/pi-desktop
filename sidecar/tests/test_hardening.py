"""Sidecar hardening (audit 6 L-9): token enforcement, no schema/docs surface,
query sanitizing, and snippet-delimiter stripping at index time."""
import json
import os
import sqlite3
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import indexer
from app import main as main_module
from app.main import app


def test_refuses_to_start_without_token(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The packaged run.py refuses an empty token; the app itself must too,
    otherwise the dev uvicorn path silently serves every route unauthenticated."""
    monkeypatch.setattr(main_module.config, "token", "")
    with pytest.raises(RuntimeError, match="PI_DESKTOP_TOKEN"):
        with TestClient(app):
            pass


def test_docs_and_schema_endpoints_are_disabled(db: sqlite3.Connection) -> None:
    # No lifespan entry needed: these routes must not exist at all.
    client = TestClient(app)
    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_sanitize_query_drops_quote_only_terms() -> None:
    assert indexer.sanitize_query('foo "" bar') == '"foo" "bar"'
    assert indexer.sanitize_query('""') == ""
    assert indexer.sanitize_query('"') == ""
    assert indexer.sanitize_query("") == ""
    # Real special chars are still quoted literally.
    assert indexer.sanitize_query("a-b (c)") == '"a-b" "(c)"'


def test_quote_only_term_no_longer_fails_the_whole_search(
    db: sqlite3.Connection, sessions_dir: Path
) -> None:
    """Previously 'auth \"\"' sanitized to '"auth" ""' — an FTS5 syntax error
    that zeroed the search. The empty phrase is dropped instead."""
    indexer.run_incremental(db, sessions_dir)
    hits = indexer.search(db, 'auth ""')
    assert len(hits) >= 1
    assert indexer.search(db, '""') == []


def test_indexed_text_strips_snippet_delimiters(db: sqlite3.Connection, sessions_dir: Path) -> None:
    """Session text containing \\x1e/\\x1f would be mis-parsed as match spans
    when snippets are split. The delimiters are reserved; strip them at index
    time."""
    target = next(sessions_dir.rglob("*.jsonl"))
    entry = {
        "type": "message",
        "id": "e-delim",
        "parentId": "e3",
        "timestamp": 1700000042000,
        "message": {"role": "user", "content": "before \x1e middle \x1f after delim-needle"},
    }
    with target.open("a") as f:
        f.write("\n" + json.dumps(entry))
    stat = target.stat()
    os.utime(target, (stat.st_atime, stat.st_mtime + 2))
    time.sleep(0.01)
    indexer.run_incremental(db, sessions_dir)

    stored = [
        row["text"]
        for row in db.execute("SELECT text FROM messages_fts WHERE entry_id = 'e-delim'")
    ]
    assert stored == ["before  middle  after delim-needle"]

    hits = indexer.search(db, "delim-needle")
    assert len(hits) == 1
    joined = "".join(str(seg["text"]) for seg in hits[0]["segments"])
    assert "\x1e" not in joined
    assert "\x1f" not in joined
    assert "delim-needle" in joined
