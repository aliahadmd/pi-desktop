"""Shared fixtures: in-memory-ish DB with seeded session files."""
import json
import sqlite3
from pathlib import Path

import pytest

from app.db import connect


@pytest.fixture()
def sessions_dir(tmp_path: Path) -> Path:
    root = tmp_path / "sessions" / "--tmp-test-"
    root.mkdir(parents=True)
    session = {
        "type": "session",
        "id": "sess-1",
        "parentId": None,
        "timestamp": 1700000000000,
        "cwd": "/tmp/test",
        "version": 3,
    }
    entries = [
        session,
        {
            "type": "message",
            "id": "e1",
            "parentId": None,
            "timestamp": 1700000001000,
            "message": {"role": "user", "content": "fix the login bug in the auth module"},
        },
        {
            "type": "message",
            "id": "e2",
            "parentId": "e1",
            "timestamp": 1700000002000,
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "look at auth.py"},
                    {"type": "text", "text": "I will fix the auth module now"},
                    {"type": "toolCall", "id": "c1", "name": "read", "arguments": {"path": "auth.py"}},
                ],
            },
        },
        {
            "type": "message",
            "id": "e3",
            "parentId": "e2",
            "timestamp": 1700000003000,
            "message": {
                "role": "toolResult",
                "toolCallId": "c1",
                "toolName": "read",
                "content": [{"type": "text", "text": "def login(): pass"}],
            },
        },
        # corrupt line to prove resilience
        "{not json",
    ]
    (root / "20260101_test.jsonl").write_text("\n".join(json.dumps(e) for e in entries))
    return root.parent


@pytest.fixture()
def db(sessions_dir: Path, monkeypatch: pytest.MonkeyPatch) -> sqlite3.Connection:
    db_path = sessions_dir.parent / "test.db"
    monkeypatch.setenv("PI_DESKTOP_DB", str(db_path))
    monkeypatch.setenv("PI_DESKTOP_SESSIONS", str(sessions_dir))
    monkeypatch.setenv("PI_DESKTOP_TOKEN", "test-token")
    # Re-import config with env applied
    import importlib

    import app.config as config_module

    importlib.reload(config_module)
    import app.main as main_module

    monkeypatch.setattr(main_module, "config", config_module.config)
    conn = connect(db_path)
    # Core-owned schema, mirroring src/main/store/db.ts migration 001.
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT,
            added_at INTEGER NOT NULL, last_opened_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, file_path TEXT NOT NULL UNIQUE,
            project_id TEXT REFERENCES projects(id), name TEXT, cwd TEXT,
            created_at INTEGER, updated_at INTEGER, message_count INTEGER DEFAULT 0,
            input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
            cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
            cost_usd REAL DEFAULT 0, model_provider TEXT, model_id TEXT,
            first_message TEXT, indexed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
            ts INTEGER NOT NULL, kind TEXT NOT NULL,
            input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
            cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0,
            model_provider TEXT, model_id TEXT
        );
        CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """
    )
    # Seed a core-owned row as the Electron app would (sidecar reads it).
    conn.execute(
        "INSERT INTO sessions (id, file_path, cwd, name, updated_at) VALUES (?, ?, ?, ?, ?)",
        ("sess-1", str(sessions_dir / "20260101_test.jsonl"), "/tmp/test", "test session", 1700000003000),
    )
    conn.commit()
    yield conn
    conn.close()
