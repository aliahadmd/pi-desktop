"""Pi Desktop sidecar: FTS5 search + analytics over the shared SQLite DB.

Loopback-only HTTP service with per-boot token auth. Owned tables:
messages_fts, index_state. Core tables (sessions, usage_events) are read-only.
"""
import asyncio
import logging
import sqlite3
import threading
from contextlib import asynccontextmanager, contextmanager
from typing import Any, AsyncIterator, Iterator

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

from . import analytics, indexer
from .config import config
from .db import check_wal, connect

logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")
log = logging.getLogger("sidecar")

VERSION = "0.1.0"

conn: sqlite3.Connection | None = None

# The single connection is shared between FastAPI's threadpool (endpoints run
# as plain `def`) and the periodic indexer (via asyncio.to_thread), so every
# use must be serialized: two concurrent DML streams in one implicit
# transaction could commit each other's half-finished writes (audit 6 M-14).
conn_lock = threading.Lock()


INDEX_INTERVAL_SECONDS = 60


async def _run_index_pass() -> dict[str, int] | None:
    """One indexing pass, run off the event loop so a long run cannot block
    /health and friends (audit 6 M-14). Serialized against request handlers
    via conn_lock."""
    c = conn
    if c is None:
        return None

    def _work() -> dict[str, int]:
        with conn_lock:
            return indexer.run_incremental(c, config.sessions_root)

    return await asyncio.to_thread(_work)


async def _periodic_index() -> None:
    while True:
        await asyncio.sleep(INDEX_INTERVAL_SECONDS)
        try:
            result = await _run_index_pass()
            if result is not None and (result["indexed_files"] > 0 or result["removed"] > 0):
                log.info("periodic index: %s", result)
        except Exception:  # noqa: BLE001 — indexing must never kill the sidecar
            log.exception("periodic index failed")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    global conn
    if not config.token:
        # run.py refuses to launch without a token; the dev uvicorn path must
        # refuse too, otherwise every data route silently serves
        # unauthenticated (audit 6 L-9).
        raise RuntimeError("PI_DESKTOP_TOKEN is required; refusing to start unauthenticated")
    conn = connect(config.db_path)
    if not check_wal(conn):
        log.warning("database is not in WAL mode; concurrent access may fail")
    # Build the index at startup so search works immediately.
    with conn_lock:
        initial = indexer.run_incremental(conn, config.sessions_root)
    log.info("initial index: %s", initial)
    index_task = asyncio.get_running_loop().create_task(_periodic_index())
    log.info("sidecar ready (db=%s)", config.db_path)
    yield
    index_task.cancel()
    c = conn
    if c is not None:
        # Close under the lock: cancelling the task does not stop an in-flight
        # to_thread worker, so wait out any running pass before closing.
        with conn_lock:
            c.close()
        conn = None
    log.info("sidecar stopped")


# No /docs, /redoc or /openapi.json: they are unauthenticated schema surface on
# a loopback RPC service that gains nothing from them (audit 6 L-9).
app = FastAPI(
    title="Pi Desktop Sidecar",
    version=VERSION,
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


def require_token(x_pi_desktop_token: str = Header(default="")) -> None:
    # config.token is guaranteed non-empty by the lifespan check.
    if not config.token or x_pi_desktop_token != config.token:
        raise HTTPException(status_code=401, detail="invalid token")


@contextmanager
def db_conn() -> Iterator[sqlite3.Connection]:
    """Yield the shared connection under its lock (see conn_lock)."""
    c = conn
    if c is None:
        raise HTTPException(status_code=503, detail="not ready")
    with conn_lock:
        yield c


class SnippetSegment(BaseModel):
    """One run of snippet text. `match` marks it as a search hit.

    Segments are plain data: the client renders each `text` into a text node,
    so session content can never re-enter the DOM as markup.
    """

    text: str
    match: bool


class SearchHit(BaseModel):
    session_id: str | None
    entry_id: str
    role: str
    segments: list[SnippetSegment]
    cwd: str | None
    session_name: str | None


@app.get("/health")
def health() -> dict[str, Any]:
    with db_conn() as c:
        return {
            "status": "ok",
            "version": VERSION,
            "indexed_sessions": indexer.indexed_count(c),
        }


@app.post("/index/rebuild")
def index_rebuild(_: None = Depends(require_token)) -> dict[str, Any]:
    with db_conn() as c:
        return indexer.run_incremental(c, config.sessions_root)


@app.get("/search")
def search(
    q: str,
    limit: int = 50,
    project: str | None = None,
    _: None = Depends(require_token),
) -> list[SearchHit]:
    with db_conn() as c:
        rows = indexer.search(c, q, limit=min(max(limit, 1), 200), project=project)
    return [SearchHit(**r) for r in rows]


@app.get("/analytics/usage")
def analytics_usage(
    days: int = 30, group_by: str = "day", _: None = Depends(require_token)
) -> list[dict[str, Any]]:
    # group_by reserved; v1 always aggregates per day.
    if group_by != "day":
        log.warning("unsupported group_by %r; returning daily", group_by)
    with db_conn() as c:
        return analytics.usage_daily(c, days=min(max(days, 1), 365))


@app.get("/analytics/top-sessions")
def analytics_top(
    by: str = "cost", limit: int = 10, _: None = Depends(require_token)
) -> list[dict[str, Any]]:
    with db_conn() as c:
        return analytics.top_sessions(c, by=by, limit=min(max(limit, 1), 100))
