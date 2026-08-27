"""Incremental indexer: pi session JSONL trees -> FTS5.

Pi session files (v3) are JSONL where each line is an entry with
{type, id, parentId, timestamp, message?}. We index the text of user and
assistant messages plus tool results (truncated), keyed by (file_path,
entry_id) so re-indexing a changed file is a delete+insert of its rows.
"""
import json
import logging
import sqlite3
from pathlib import Path
from typing import Any

from app.db import connect

log = logging.getLogger("sidecar.indexer")

MAX_TEXT_CHARS = 10_000

# Control characters used to delimit FTS match spans. They are stripped from
# session text at index time, so they can never collide with content the way
# `<mark>` does -- which is the whole point: `snippet()` does not escape the
# text it wraps, so emitting HTML here put raw session content straight into
# the DOM.
_MATCH_OPEN = "\x1e"
_MATCH_CLOSE = "\x1f"


def _text_from_content(content: Any) -> str:
    """Extract searchable text from pi content blocks (string or array)."""
    if isinstance(content, str):
        return content
    parts: list[str] = []
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype in ("text", "thinking"):
                text = block.get("text") or block.get("thinking")
                if isinstance(text, str):
                    parts.append(text)
            elif btype == "toolCall":
                name = block.get("name", "")
                args = json.dumps(block.get("arguments", {}))
                parts.append(f"[tool:{name} {args}]")
    return "\n".join(parts)


def parse_session_file(path: Path) -> list[dict[str, str]]:
    """Parse one JSONL session file into FTS rows. Skips corrupt lines."""
    rows: list[dict[str, str]] = []
    session_id = ""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for line_no, line in enumerate(f):
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    log.debug("skip corrupt line %s:%d", path, line_no)
                    continue
                if not isinstance(entry, dict):
                    continue

                # Session header carries the id.
                if entry.get("type") in ("session", "session_info") and not session_id:
                    sid = entry.get("id")
                    if isinstance(sid, str):
                        session_id = sid

                message = entry.get("message")
                if not isinstance(message, dict):
                    continue
                role = message.get("role", "")
                entry_id = entry.get("id")
                if not isinstance(entry_id, str):
                    continue
                text = _text_from_content(message.get("content"))
                if not text.strip():
                    continue
                # Drop the snippet delimiters from indexed text: session content
                # containing them would be mis-parsed as match spans on the way
                # out (mis-highlight only, but the markers are reserved).
                text = text.replace(_MATCH_OPEN, "").replace(_MATCH_CLOSE, "")
                rows.append(
                    {
                        "file_path": str(path),
                        "session_id": session_id,
                        "entry_id": entry_id,
                        "role": str(role),
                        "text": text[:MAX_TEXT_CHARS],
                    }
                )
    except OSError as e:
        log.warning("cannot read %s: %s", path, e)
    return rows


def index_file(conn: sqlite3.Connection, path: Path) -> int:
    """(Re)index one file. Returns number of rows indexed."""
    file_key = str(path)
    conn.execute("DELETE FROM messages_fts WHERE file_path = ?", (file_key,))
    rows = parse_session_file(path)
    conn.executemany(
        "INSERT INTO messages_fts (file_path, session_id, entry_id, role, text) "
        "VALUES (:file_path, :session_id, :entry_id, :role, :text)",
        rows,
    )
    stat = path.stat()
    conn.execute(
        "INSERT INTO index_state (file_path, mtime, size) VALUES (?, ?, ?) "
        "ON CONFLICT(file_path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size",
        (file_key, stat.st_mtime, stat.st_size),
    )
    return len(rows)


def remove_file(conn: sqlite3.Connection, file_key: str) -> None:
    conn.execute("DELETE FROM messages_fts WHERE file_path = ?", (file_key,))
    conn.execute("DELETE FROM index_state WHERE file_path = ?", (file_key,))


def run_incremental(
    conn: sqlite3.Connection,
    sessions_root: Path,
    batch_size: int = 32,
) -> dict[str, int]:
    """Walk sessions_root; index new/changed files; drop deleted ones.

    Writes commit per batch of ``batch_size`` files rather than once per run:
    the Electron main process writes to the same SQLite file, and holding the
    WAL write lock for a whole run stalls it until its busy_timeout fires. A
    failure mid-run rolls back only the in-flight batch (never a half-written
    file's rows) and releases the lock; already-committed batches stay.
    """
    result = {"indexed_files": 0, "rows": 0, "removed": 0}
    if not sessions_root.exists():
        return result

    current: set[str] = set()
    pending = 0
    try:
        for path in sorted(sessions_root.rglob("*.jsonl")):
            file_key = str(path)
            current.add(file_key)
            try:
                stat = path.stat()
            except OSError:
                continue
            row = conn.execute(
                "SELECT mtime, size FROM index_state WHERE file_path = ?", (file_key,)
            ).fetchone()
            if row is not None and abs(row["mtime"] - stat.st_mtime) < 1e-6 and row["size"] == stat.st_size:
                continue  # unchanged
            result["rows"] += index_file(conn, path)
            result["indexed_files"] += 1
            pending += 1
            if pending >= batch_size:
                conn.commit()
                pending = 0

        for row in conn.execute("SELECT file_path FROM index_state").fetchall():
            if row["file_path"] not in current:
                remove_file(conn, row["file_path"])
                result["removed"] += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return result


def sanitize_query(query: str) -> str:
    """Quote each whitespace-separated term so FTS5 special chars
    (hyphens, quotes, parens) are treated as literal text.

    Terms that are empty once their quotes are stripped (e.g. ``""``) are
    dropped: an empty quoted phrase is an FTS5 syntax error that would
    otherwise fail the whole search.
    """
    terms = [t.replace(chr(34), "") for t in query.split()]
    return " ".join(f'"{t}"' for t in terms if t)


def split_snippet(raw: str) -> list[dict[str, object]]:
    """Split delimiter-marked snippet text into ``{text, match}`` segments.

    Text is returned byte-for-byte as indexed, minus only the delimiters we
    inserted ourselves. Nothing is escaped or stripped: inertness comes from
    shipping data instead of markup, so the renderer can put every segment in a
    text node.

    Total by construction -- any input string yields a (possibly empty) list.
    """
    segments: list[dict[str, object]] = []
    for chunk_index, chunk in enumerate(raw.split(_MATCH_OPEN)):
        if chunk == "":
            continue
        # The first chunk precedes any open delimiter, so it is never a match.
        # Later chunks start with matched text up to the close delimiter.
        if chunk_index == 0:
            segments.append({"text": chunk, "match": False})
            continue
        matched, sep, trailing = chunk.partition(_MATCH_CLOSE)
        if matched != "":
            # A missing close delimiter means the snippet window cut the pair;
            # treat the remainder as ordinary text rather than guessing.
            segments.append({"text": matched, "match": sep != ""})
        if trailing != "":
            segments.append({"text": trailing, "match": False})
    return segments


def search(
    conn: sqlite3.Connection,
    query: str,
    limit: int = 50,
    project: str | None = None,
) -> list[dict[str, Any]]:
    """FTS5 search with snippets. Optionally filter to a project cwd via join."""
    query = sanitize_query(query)
    if not query.strip('"'):
        return []
    sql = """
        SELECT messages_fts.session_id AS session_id,
               messages_fts.entry_id AS entry_id,
               messages_fts.role AS role,
               snippet(messages_fts, 4, :open, :close, '…', 24) AS snippet_raw,
               s.cwd AS cwd, s.name AS session_name
        FROM messages_fts
        LEFT JOIN sessions s ON s.id = messages_fts.session_id
        WHERE messages_fts MATCH :query
    """
    params: dict[str, Any] = {
        "query": query,
        "open": _MATCH_OPEN,
        "close": _MATCH_CLOSE,
    }
    if project:
        sql += " AND s.cwd = :project"
        params["project"] = project
    sql += " ORDER BY rank LIMIT :limit"
    params["limit"] = limit
    try:
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.OperationalError as e:
        # Malformed FTS query syntax etc.
        log.warning("search failed for %r: %s", query, e)
        return []
    hits: list[dict[str, Any]] = []
    for row in rows:
        hit = dict(row)
        hit["segments"] = split_snippet(hit.pop("snippet_raw") or "")
        hits.append(hit)
    return hits


def indexed_count(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COUNT(DISTINCT file_path) AS n FROM index_state").fetchone()
    return int(row["n"]) if row else 0


# Re-export for app factory convenience.
connect_db = connect
