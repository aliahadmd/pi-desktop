"""Pi Desktop sidecar: FTS5 search + analytics over the shared SQLite DB.

Loopback-only HTTP service with per-boot token auth. Owned tables:
messages_fts, index_state. Core tables (sessions, usage_events) are read-only.
"""
import asyncio
import logging
import sqlite3
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

from . import analytics, indexer
from .config import config
from .db import check_wal, connect

logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")
log = logging.getLogger("sidecar")

VERSION = "0.1.0"

conn: sqlite3.Connection | None = None


INDEX_INTERVAL_SECONDS = 60


async def _periodic_index() -> None:
    while True:
        await asyncio.sleep(INDEX_INTERVAL_SECONDS)
        if conn is None:
            continue
        try:
            result = indexer.run_incremental(conn, config.sessions_root)
            if result["indexed_files"] > 0 or result["removed"] > 0:
                log.info("periodic index: %s", result)
        except Exception:  # noqa: BLE001 — indexing must never kill the sidecar
            log.exception("periodic index failed")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    global conn
    conn = connect(config.db_path)
    if not check_wal(conn):
        log.warning("database is not in WAL mode; concurrent access may fail")
    # Build the index at startup so search works immediately.
    initial = indexer.run_incremental(conn, config.sessions_root)
    log.info("initial index: %s", initial)
    index_task = asyncio.get_running_loop().create_task(_periodic_index())
    log.info("sidecar ready (db=%s)", config.db_path)
    yield
    index_task.cancel()
    if conn is not None:
        conn.close()
    log.info("sidecar stopped")


app = FastAPI(title="Pi Desktop Sidecar", version=VERSION, lifespan=lifespan)


def require_token(x_pi_desktop_token: str = Header(default="")) -> None:
    if config.token and x_pi_desktop_token != config.token:
        raise HTTPException(status_code=401, detail="invalid token")


def get_conn() -> sqlite3.Connection:
    if conn is None:
        raise HTTPException(status_code=503, detail="not ready")
    return conn


class SearchHit(BaseModel):
    session_id: str | None
    entry_id: str
    role: str
    snippet: str
    cwd: str | None
    session_name: str | None


@app.get("/health")
def health() -> dict[str, Any]:
    c = get_conn()
    return {
        "status": "ok",
        "version": VERSION,
        "indexed_sessions": indexer.indexed_count(c),
    }


@app.post("/index/rebuild")
def index_rebuild(_: None = Depends(require_token)) -> dict[str, Any]:
    c = get_conn()
    return indexer.run_incremental(c, config.sessions_root)


@app.get("/search")
def search(
    q: str,
    limit: int = 50,
    project: str | None = None,
    _: None = Depends(require_token),
) -> list[SearchHit]:
    c = get_conn()
    rows = indexer.search(c, q, limit=min(max(limit, 1), 200), project=project)
    return [SearchHit(**r) for r in rows]


@app.get("/analytics/usage")
def analytics_usage(
    days: int = 30, group_by: str = "day", _: None = Depends(require_token)
) -> list[dict[str, Any]]:
    # group_by reserved; v1 always aggregates per day.
    if group_by != "day":
        log.warning("unsupported group_by %r; returning daily", group_by)
    c = get_conn()
    return analytics.usage_daily(c, days=min(max(days, 1), 365))


@app.get("/analytics/top-sessions")
def analytics_top(
    by: str = "cost", limit: int = 10, _: None = Depends(require_token)
) -> list[dict[str, Any]]:
    c = get_conn()
    return analytics.top_sessions(c, by=by, limit=min(max(limit, 1), 100))
