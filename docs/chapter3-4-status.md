# Chapters 3+4 Status — Chat UI & Sessions/SQLite: COMPLETE

Date: 2026-08-22 · Owners: ui (ch3) + core (ch4) · Gate: passed

## Chapter 3 — Chat experience

```
src/renderer/src/
  lib/ingest.ts               Pure event→transcript logic (fully unit-tested)
  stores/pi-sessions.ts       Zustand store: rAF-batched event ingestion, session tabs
  components/chat/
    Transcript.tsx            Virtualized (@tanstack/react-virtual), stick-to-bottom
    Blocks.tsx                User / Assistant / Tool / Notice blocks
    Markdown.tsx              react-markdown + GFM, shiki highlighting (lazy), safe links
    Composer.tsx              Auto-grow, Enter=send, steer/followUp toggle, Esc-free abort
    StatusBar.tsx             Model, thinking-level dropdown, phase, tokens/cost
    DialogModal.tsx           Extension dialogs (select/confirm/input/editor)
  pages/ChatPage.tsx          Session tabs + composition
  pages/SessionsPage.tsx      Chapter 4 browser UI
```

Features delivered: streaming text/thinking with cursor, tool calls with live output
(replace-not-append semantics), unified-diff rendering for edit/write tools, ANSI tool
output, retry/compaction notices, queue indicator, optimistic user blocks, hydration from
`get_messages` on attach, image paste, abort, model/thinking display, per-message usage.

## Chapter 4 — Sessions & SQLite

```
src/main/store/
  db.ts         better-sqlite3 (N-API — works under Node tests AND Electron without
                ABI-specific rebuilds), WAL, foreign keys, user_version migrations
  repos.ts      SessionsRepo (upsert w/ COALESCE+MAX semantics, search, reconcile-remove),
                UsageRepo (events + rollups + daily summary), ProjectsRepo, SettingsRepo
  service.ts    StoreService: session registration, live usage capture from PiService
                hooks, 5-min reconciliation indexer, db.*/app.settings IPC channels
```

Schema: `projects`, `sessions` (token/cost rollups), `usage_events` (append-only),
`app_settings` (JSON KV). Window geometry persists via `app_settings`.

## Verification log

```
npm run typecheck   PASS (strict + exactOptionalPropertyTypes, both configs)
npm test            31/31 unit tests PASS
  - ingest (6): streaming assembly, contentIndex separation, tool lifecycle,
    diff extraction, retry notice add/remove, hydration
  - store (8): upsert semantics, search, reconcile, usage rollups, settings KV
  - + all chapter 1-2 suites (23)
npm run e2e         17/17 PASS
  - smoke (3): sandbox, IPC round-trip, payload rejection
  - pi-integration (8): real pi via RPC + SDK backends, full IPC stack
  - ui-store (6): shell tabs, chat render, sessions browser, settings/indexer/usage
electron-builder    Pi Desktop.app produced (420 MB incl. pi + native sqlite)
```

## Key implementation notes

1. **better-sqlite3 v13 is N-API**: one build works under both Node (vitest) and
   Electron — no electron-rebuild dance needed at test time. `@electron/rebuild` is
   available for packaging if a future dep needs it; `npmRebuild: false` stays.
2. **Usage capture is failure-isolated**: every store op wrapped in guard(); a DB
   problem logs a warning and never touches the agent session.
3. **Rollup semantics**: `usage_events` is append-only; `sessions` holds running
   totals updated per event (input/output/cache/cost).
4. **Ephemeral sessions** (`noSession`) skip DB registration entirely.
5. **typebox gotcha found**: `Type.Union(array.map(...))` loses tuple inference →
   `Static` = never. Unions must be literal arrays (fixed in PiThinkingLevelSchema).
6. **exactOptionalPropertyTypes discipline**: conditional spreads for optional props
   throughout renderer code; `stripUndefined` helpers on the main side.

## Deferred (per plan)

- FTS5 search + analytics move to the Python sidecar (chapter 5); SQL LIKE search
  covers the interim.
- Context-window percentage needs model contextWindow plumbed into state (ch6).
- Session tree visualizer (get_tree) lands with chapter 7's workspace view.
