"""Analytics aggregations over core-owned tables (READ-ONLY access)."""
import sqlite3
import time
from typing import Any


def usage_daily(conn: sqlite3.Connection, days: int = 30) -> list[dict[str, Any]]:
    since_ms = time.time() * 1000 - days * 86_400_000
    rows = conn.execute(
        """
        SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cost_usd) AS cost_usd,
               COUNT(*) AS requests
        FROM usage_events WHERE ts >= ?
        GROUP BY day ORDER BY day DESC
        """,
        (since_ms,),
    ).fetchall()
    return [dict(r) for r in rows]


def top_sessions(
    conn: sqlite3.Connection, by: str = "cost", limit: int = 10
) -> list[dict[str, Any]]:
    order = "cost_usd DESC" if by == "cost" else "(input_tokens + output_tokens) DESC"
    rows = conn.execute(
        f"""
        SELECT id, name, cwd, model_provider, model_id,
               message_count,
               input_tokens + output_tokens AS tokens,
               cost_usd
        FROM sessions ORDER BY {order} LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]
