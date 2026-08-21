"""SQLite access for the sidecar.

Ownership rules (enforced by convention, see docs/chapter3-4-status.md):
- Sidecar OWNS: messages_fts, index_state
- Sidecar READS ONLY: sessions, usage_events, projects (core-owned tables)
- WAL mode allows concurrent readers alongside the main-process writer.
"""
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS index_state (
    file_path TEXT PRIMARY KEY,
    mtime REAL NOT NULL,
    size INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    file_path UNINDEXED,
    session_id UNINDEXED,
    entry_id UNINDEXED,
    role UNINDEXED,
    text
);
-- NOTE: FTS5 virtual tables cannot have regular indexes; FTS5 maintains its own.
"""


def connect(db_path: Path) -> sqlite3.Connection:
    """Open the shared DB. Creates it if missing (first boot before Electron)."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=5.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=3000")
    conn.executescript(SCHEMA)
    return conn


def check_wal(conn: sqlite3.Connection) -> bool:
    row = conn.execute("PRAGMA journal_mode").fetchone()
    return bool(row) and str(row[0]).lower() == "wal"
