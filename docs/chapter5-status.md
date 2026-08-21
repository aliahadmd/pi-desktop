# Chapter 5 Status — Python Sidecar: COMPLETE

Date: 2026-08-22 · Owner: py · Gate: passed

## What was built

```
sidecar/
  pyproject.toml         uv-managed: fastapi, uvicorn, pydantic (dev: pytest, mypy, httpx)
  app/
    config.py            Paths + per-boot token from env (PI_DESKTOP_*)
    db.py                sqlite3 connect (WAL, check_same_thread=False, busy_timeout),
                         owns messages_fts (FTS5) + index_state
    indexer.py           Incremental JSONL tree indexer -> FTS5; corruption-resilient;
                         query sanitizer (quotes terms; hyphens would parse as NOT)
    analytics.py         Daily usage + top-sessions aggregations (READ-ONLY core tables)
    main.py              FastAPI: /health, /index/rebuild, /search, /analytics/*
  tests/                 11 pytest tests (indexer, analytics, HTTP API + token auth)
src/main/sidecar/
  manager.ts             Spawn (PyInstaller bin > dev uvicorn), free-port pick, per-boot
                         token, health polling 2s, 3 restarts w/ exponential backoff,
                         authenticated fetch helpers, graceful-degradation null returns
```

## Verification log

```
cd sidecar && uv run pytest -q   11/11 PASS
cd sidecar && uv run mypy app/   Success (strict)
npm run typecheck                PASS
npm test                         35/35 PASS (incl. 4 live sidecar-manager tests:
                                 real uvicorn spawn, health, 401 w/o token, search)
npm run e2e                      17/17 PASS
electron-builder                 Pi Desktop.app produced
```

## Key implementation notes

1. **FTS5 gotchas hit and fixed**:
   - `CREATE INDEX` on an FTS5 virtual table is illegal ("virtual tables may not be
     indexed") — FTS5 maintains its own.
   - The FTS table must be `CREATE VIRTUAL TABLE ... USING fts5(...)`; a regular table
     with UNINDEXED keywords silently accepts inserts but MATCH fails with
     "no such column".
   - Hyphens in user queries parse as NOT (`unique-zebra` → unique NOT zebra);
     `sanitize_query()` quotes every term.
2. **Table ownership enforced by convention**: sidecar owns `messages_fts` +
   `index_state`; reads core tables via LEFT JOIN for cwd/name metadata. WAL +
   `busy_timeout=3000` keeps both writers safe.
3. **Auth**: loopback-only bind + `X-Pi-Desktop-Token` header; token regenerated per
   app boot, never persisted.
4. **Graceful degradation**: every manager request returns null when unhealthy;
   renderer falls back to SQL LIKE search and local usage aggregation. Status badge
   on the Sessions page shows starting/healthy/degraded/stopped.
5. **Dev mode** runs `sidecar/.venv/bin/uvicorn` (created once via `uv sync`); chapter 8
   adds the PyInstaller binary path (checked first by resolveLaunch).

## Deferred

- PyInstaller bundling in CI → chapter 8 (packaging).
- Semantic/embedding search → post-v1 backlog.
- `group_by` param on /analytics/usage reserved (only daily aggregation in v1).
