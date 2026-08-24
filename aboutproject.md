# Pi Desktop

A native macOS desktop application for the [Pi coding agent](../pi/README.md) — replacing the terminal as the primary way to drive pi, with a full GUI: session management, streaming chat, file attachments, embedded terminal, package marketplace, and usage analytics.

## What we built (and why)

Pi is a powerful coding agent that runs entirely in the terminal. Our motive was to make it accessible to developers who prefer a GUI — without losing any of pi's capability. The desktop app wraps pi's SDK (not the CLI) inside an Electron shell, giving us full type-safe access to every pi feature while adding visual tooling the terminal can't provide: clickable diffs, searchable history, cost tracking, drag-drop files, and a marketplace for community packages.

The architecture has three layers:

1. **Electron main process** (TypeScript) — hosts pi's SDK directly via `@earendil-works/pi-coding-agent`. Two interchangeable backends behind one `IPi` interface: **SDK mode** (in-process, default) and **RPC mode** (`pi --mode rpc` subprocess, isolation fallback). All IPC payloads are schema-validated at the boundary.
2. **Python sidecar** — FastAPI service sharing a SQLite database with the main process. Owns FTS5 full-text search and analytics tables; core tables are read-only to it. Loopback-only with per-boot token auth.
3. **React renderer** (sandboxed) — talks exclusively through a typed `window.piDesktop` bridge exposed by the preload script. No electron or node APIs leak.

## Architecture decisions (and why)

- **SDK-first, not CLI parsing** — pi ships an SDK (`createAgentSession`, `AgentSessionRuntime`, `ModelRuntime`) with full type safety. We use it in-process rather than spawning the CLI and parsing stdout. RPC mode exists as a fallback for process isolation.
- **Shared ModelRuntime** — one instance across all sessions so API keys set once apply everywhere. Keys stored via Electron safeStorage (Keychain), re-applied at boot.
- **SQLite owned jointly by table** — main process owns app tables; Python sidecar owns FTS/analytics tables in the same DB. WAL mode allows concurrent readers + single writer.
- **Extension-first** — features that pi could also benefit from ship through public ExtensionAPI (e.g. the approval gate, loaded in-process as an inline `ExtensionFactory`). No pi forks. Note the gate is SDK-mode only — an inline factory cannot cross the `pi --mode rpc` subprocess boundary.
- **No telemetry** — by explicit design. The app makes exactly two kinds of network calls: LLM provider traffic (when you prompt) and model catalog/update checks.

## Key source files (for orientation)

| Path | What |
|---|---|
| `src/shared/pi.ts` | All IPC schemas + types (single source of truth, no node imports) |
| `src/main/ipc/router.ts` | Typed IPC router with schema validation at the boundary |
| `src/main/pi/backend.ts` | `IPiBackend` interface — SDK/RPC/Remote implementations |
| `src/main/pi/sdk-backend.ts` | In-process pi SDK backend (default); uses `AgentSessionRuntime` |
| `src/main/pi/rpc-backend.ts` | Subprocess backend (`pi --mode rpc`); strict JSONL framing |
| `src/main/pi/auth.ts` | Shared ModelRuntime, API keys (safeStorage), OAuth flows |
| `src/main/store/db.ts` | SQLite (better-sqlite3, WAL) migrations |
| `src/main/store/repos.ts` | Session index, usage events, projects, settings repos |
| `src/main/sidecar/manager.ts` | Python sidecar lifecycle (spawn, health poll, restart) |
| `sidecar/app/indexer.py` | FTS5 incremental indexer over pi session JSONL files |
| `src/main/pi/approve-extension.ts` | Approval gate extension (public pi extension API; on by default, SDK mode only) |
| `src/renderer/src/lib/ingest.ts` | Pure event→transcript logic (rAF-batched streaming) |
| `src/renderer/src/stores/pi-sessions.ts` | Zustand store: session registry, event routing |

## Testing & verification

```bash
npm run typecheck          # strict TS across all configs
npm test                   # 53 unit tests (vitest)
npm run e2e                # 30 e2e tests (Playwright _electron)
cd sidecar && uv run pytest -q   # 11 pytest
cd sidecar && uv run mypy app/   # strict type check
./scripts/check-secrets.sh       # credential scan
npm audit --omit=dev             # dependency audit
```

## What we did (timeline)

### Phase 1 (ch 1–8): Foundation → Release pipeline
Electron scaffold with typed IPC, security baseline (contextIsolation+sandbox),
logging, packaging skeleton → pi integration core (SDK + RPC backends, event
bridge, extension UI dialogs) → chat UI (virtualized transcript, markdown,
diffs, tool rendering, composer) → SQLite persistence (session index, usage
rollups, reconciliation indexer) → Python sidecar (FTS5 search, analytics,
PyInstaller bundling) → models/auth/settings (Keychain-backed keys, OAuth,
settings editor) → workspace features (file explorer, review queue, terminal,
commands browser, tray/notifications) → hardening (security audit, fuzzing,
notarization config, auto-update, upstream tracking).

### Phase 2 (ch 9–13): Advanced pi features
Session trees (getTree/getEntries/navigateTree/fork/clone/switch), providers
deep (models.json editor, llama.cpp preset, subscription auth UX), skills/packages/
prompt templates (marketplace UI, argument-hint forms, trust interstitial),
desktop tools (notify/clipboard/open_path custom tools), compaction controls
(dialog with instructions), trust management UI, keybindings viewer.

### Bug fix cycles
Two full audit cycles: `.pibugs/pibugs1.md` (22 findings, phase-1 code) and
`.pibugs/pibugs2.md` (22 findings, phase-2 code). All fixed. Notable: IPC
credential exposure (C-1), session replacement re-hydration (H-2), trust store
data corruption (H-1), double extension binding (H-3).

### Phase 3 (ch 14–18): UI/UX redesign
Three-column layout (sidebar | center | dock), sessions sidebar grouped by
project with live status dots, composer v2 (git strip, model chip, "/"
palette), transcript v2 (grouped tool rows "Ran N commands ▸"), motion system
(motion/react primitives, reduced-motion support), full-window sheets with
traffic-light clearance, responsive sidebar auto-collapse.

### Phase 4 (ch 19–24): Stability, attachments, terminal, dock, sound
Stability pass (error dismiss, reconnect, race conditions, focus management),
file/photo attachment pipeline (drag-drop, paste, thumbnails, text-file
inlining), icon rail dock (Files/Review/Commands/Tree/Terminal icons), sound
system (Web Audio generated tones for complete/error/sent/notification),
minimalist sweep (spacing normalization, progressive disclosure).

## What we will do next (Phase 2 plans in `piplan/Phase-2/`)

These are planned but not yet implemented:

1. **Remote pi-server sessions** — connect to a pi daemon over Unix socket or
   SSH tunnel using pi's CBOR protocol (`pi-client`/`pi-server`). The
   `RemotePiBackend` stub exists in `src/main/pi/remote-backend.ts`.
2. **Windows/Linux builds** — architecture permits; needs platform-specific
   packaging, keychain alternatives, and PTY handling.
3. **Semantic session search** — embedding-based similarity search in the
   Python sidecar (beyond FTS5 keyword matching).
4. **Multi-window support** — separate BrowserWindows per project.
5. **Light-theme audit** — theme bridge exists; visual polish pass needed.
6. **Path-scoped permission allowlists** — "always allow writes under src/**";
   the session-level always-allow memory covers the common case today.

## Permission modes (Phase 5 architecture)

Agent autonomy is a five-mode ladder, not a boolean: **Plan** (read-only),
**Always Ask**, **Ask Before Edits** (default), **Accept File Edits**, and
**Bypass**. State lives in `src/main/pi/permissions.ts` — a mutable store the
permission extension reads synchronously inside each `tool_call` handler, so
switching modes applies mid-session without re-registering extensions.
Session overrides reset on close; the default persists in StoreService under
`permissionMode` (migrated once from the legacy `confirmBeforeApply` toggle).

The extension (`src/main/pi/approve-extension.ts`) uses only upstream's public
`tool_call` veto: returning `{ block: true, reason }` stops the tool and feeds
`reason` back to the model, so Plan-mode blocks instruct the agent to present
a plan instead of executing. Gated calls prompt via `ctx.ui.select`
(Allow once / Always allow this command / Deny); "always allow" is remembered
per exact command for the session. Read-only tools (read/grep/find/ls) are
never gated. The composer's ModePicker and the Settings radio group both talk
to this store over IPC; the transcript styles blocked calls with a ListTodo
icon by matching `PERMISSION_BLOCK_REASONS` from `src/shared/pi.ts`.

## For a new coding agent picking this up

1. Read `docs/SECURITY.md` first (threat model, boundaries).
2. Read `src/shared/pi.ts` — every IPC channel is defined there with its
   schema. This is your map of what the app can do.
3. Read `docs/chapter*-status.md` for implementation details per chapter.
4. Run `scripts/setup-native.sh` to set up native modules (node-pty must match
   Electron ABI).
5. Run `npm run dev` to start developing; `npm test` and `npm run e2e` to verify.
6. If you need to understand how pi works internally, read the cloned repo at
   `../pi/packages/coding-agent/docs/` — especially `sdk.md` and `rpc.md`.
7. `.pibugs/pibugs1.md` and `.pibugs/pibugs2.md` document two full audit
   cycles (44 findings, all fixed) — read them to understand known pitfalls.
8. The pi version is pinned exactly in package.json (`@earendil-works/*`);
   bump carefully and run the contract battery (`scripts/check-pi-updates.sh`).
