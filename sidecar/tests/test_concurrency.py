"""Shared-connection serialization (audit 6 M-14).

One sqlite3 connection is used by FastAPI's threadpool (endpoints) and by the
periodic indexer (via asyncio.to_thread). These tests pin that both paths go
through the module-level conn_lock, and that indexing runs off the event loop.
"""
import asyncio
import sqlite3
import threading
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import indexer
from app import main as main_module


@pytest.fixture(autouse=True)
def _shared_conn(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the module-global connection at the seeded fixture DB."""
    monkeypatch.setattr(main_module, "conn", db)


def test_health_endpoint_waits_for_conn_lock(db: sqlite3.Connection) -> None:
    """A request handler must not touch the connection while the lock is held
    (e.g. by a periodic indexing pass)."""
    finished: list[dict[str, object]] = []
    main_module.conn_lock.acquire()
    try:
        thread = threading.Thread(target=lambda: finished.append(main_module.health()))
        thread.start()
        thread.join(timeout=1.0)
        assert not finished, "health() touched the connection without the lock"
    finally:
        main_module.conn_lock.release()
    thread.join(timeout=5.0)
    assert len(finished) == 1
    assert finished[0]["status"] == "ok"


def test_index_pass_waits_for_conn_lock(sessions_dir: Path) -> None:
    """The periodic indexing path serializes against request handlers too."""
    finished: list[dict[str, int] | None] = []
    main_module.conn_lock.acquire()
    try:
        thread = threading.Thread(
            target=lambda: finished.append(asyncio.run(main_module._run_index_pass()))
        )
        thread.start()
        thread.join(timeout=1.0)
        assert not finished, "indexing pass touched the connection without the lock"
    finally:
        main_module.conn_lock.release()
    thread.join(timeout=10.0)
    assert len(finished) == 1
    assert finished[0] is not None
    assert finished[0]["indexed_files"] == 1


def test_index_pass_runs_off_the_calling_thread(
    sessions_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """asyncio.to_thread must actually move run_incremental to a worker thread
    so long runs stop blocking the event loop (and /health)."""
    seen_threads: list[int] = []
    real_run = indexer.run_incremental

    def spy(
        conn: sqlite3.Connection, root: Path, batch_size: int = 32
    ) -> dict[str, int]:
        seen_threads.append(threading.get_ident())
        return real_run(conn, root, batch_size=batch_size)

    monkeypatch.setattr(main_module.indexer, "run_incremental", spy)

    result = asyncio.run(main_module._run_index_pass())
    assert result is not None
    assert result["indexed_files"] == 1
    assert len(seen_threads) == 1
    assert seen_threads[0] != threading.get_ident()


def test_index_pass_is_a_noop_without_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main_module, "conn", None)
    assert asyncio.run(main_module._run_index_pass()) is None


def test_db_conn_raises_503_without_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main_module, "conn", None)
    with pytest.raises(HTTPException) as excinfo:
        with main_module.db_conn():
            pass
    assert excinfo.value.status_code == 503
