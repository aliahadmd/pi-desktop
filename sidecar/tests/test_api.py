"""HTTP API tests via the FastAPI test client (token auth + endpoints)."""
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from app import indexer
from app.main import app


def _client(db: sqlite3.Connection, token: str) -> TestClient:
    # The lifespan opens its own connection from config; tests reuse the
    # seeded fixture DB by pointing config at it.
    from app import config as config_module

    db_file = Path(str(db.execute("PRAGMA database_list").fetchone()[2]))
    config_module.config.db_path = db_file
    client = TestClient(app)
    client.__enter__()
    return client


def _with_token(client: TestClient, token: str) -> TestClient:
    client.headers.update({"X-Pi-Desktop-Token": token})
    return client


def test_health_requires_no_token_but_search_does(db: sqlite3.Connection, sessions_dir: Path) -> None:
    indexer.run_incremental(db, sessions_dir)
    client = _client(db, "test-token")
    try:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"

        no_token = client.get("/search", params={"q": "auth"})
        assert no_token.status_code == 401

        wrong = _with_token(client, "wrong").get("/search", params={"q": "auth"})
        assert wrong.status_code == 401

        good = _with_token(client, "test-token").get("/search", params={"q": "auth module"})
        assert good.status_code == 200
        results = good.json()
        assert len(results) >= 1
        assert "<mark>" in results[0]["snippet"]
    finally:
        client.__exit__(False, False, False)


def test_analytics_endpoints(db: sqlite3.Connection) -> None:
    db.execute(
        "INSERT INTO usage_events (session_id, ts, kind, input_tokens, output_tokens, total_tokens, cost_usd)"
        " VALUES ('sess-1', 1700000000000, 'assistant_message', 10, 5, 15, 0.01)"
    )
    db.commit()
    client = _with_token(_client(db, "test-token"), "test-token")
    try:
        usage = client.get("/analytics/usage", params={"days": 30})
        assert usage.status_code == 200
        top = client.get("/analytics/top-sessions", params={"by": "cost"})
        assert top.status_code == 200
        assert isinstance(top.json(), list)
    finally:
        client.__exit__(False, False, False)


def test_index_rebuild_endpoint(db: sqlite3.Connection, sessions_dir: Path) -> None:
    # Lifespan startup indexes the corpus already, so a rebuild is a no-op.
    client = _with_token(_client(db, "test-token"), "test-token")
    try:
        health = client.get("/health")
        assert health.json()["indexed_sessions"] >= 1

        result = client.post("/index/rebuild")
        assert result.status_code == 200
        body = result.json()
        assert set(body) == {"indexed_files", "rows", "removed"}
        assert body["indexed_files"] == 0

        hits = client.get("/search", params={"q": "auth module"})
        assert len(hits.json()) >= 1
    finally:
        client.__exit__(False, False, False)
