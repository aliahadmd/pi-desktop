"""Analytics tests over seeded core tables."""
import sqlite3

from app import analytics


def _seed_usage(conn: sqlite3.Connection, day_offset_days: int, cost: float) -> None:
    import time

    ts = (time.time() - day_offset_days * 86_400) * 1000
    conn.execute(
        """
        INSERT INTO usage_events (session_id, ts, kind, input_tokens, output_tokens,
            cache_read, cache_write, total_tokens, cost_usd, model_provider, model_id)
        VALUES ('sess-1', ?, 'assistant_message', 100, 50, 0, 0, 150, ?, 'anthropic', 'claude-test')
        """,
        (ts, cost),
    )


def test_usage_daily_aggregates(db: sqlite3.Connection) -> None:
    _seed_usage(db, 0, 0.10)
    _seed_usage(db, 0, 0.20)
    rows = analytics.usage_daily(db, days=30)
    assert len(rows) == 1
    assert rows[0]["requests"] == 2
    assert abs(rows[0]["cost_usd"] - 0.30) < 1e-9
    assert rows[0]["input_tokens"] == 200


def test_top_sessions_by_cost(db: sqlite3.Connection) -> None:
    db.execute(
        "UPDATE sessions SET cost_usd = 1.5, input_tokens = 500, output_tokens = 250 WHERE id = 'sess-1'"
    )
    db.commit()
    top = analytics.top_sessions(db, by="cost", limit=5)
    assert len(top) == 1
    assert top[0]["id"] == "sess-1"
    assert top[0]["tokens"] == 750
