# Pi Desktop

macOS Electron client for the [Pi coding agent](../pi/README.md). Built chapter-by-chapter
according to [../piplan/main.md](../piplan/main.md).

## Status

- **Chapter 1 — Foundation: complete** ([docs/chapter1-status.md](docs/chapter1-status.md))
- **Chapter 2 — Pi integration core: complete** ([docs/chapter2-status.md](docs/chapter2-status.md))
  Both backends (in-process SDK + `pi --mode rpc` subprocess) drive real pi sessions
  end-to-end through the typed IPC layer; verified by unit contract tests and e2e.
- **Chapters 3+4 — Chat UI & Sessions/SQLite: complete** ([docs/chapter3-4-status.md](docs/chapter3-4-status.md))
  Streaming chat with tool/diff/thinking rendering, session tabs, SQLite-backed session
  browser with usage tracking and live cost rollups.
- **Chapter 5 — Python sidecar: complete** ([docs/chapter5-status.md](docs/chapter5-status.md))
  FastAPI sidecar owns FTS5 full-text search + analytics over the shared DB; loopback-only
  with per-boot token auth; app degrades gracefully when it is not running.
- **Chapter 6 — Models, auth & settings: complete** ([docs/chapter6-status.md](docs/chapter6-status.md))
  Provider auth management with Keychain-backed API keys (safeStorage), OAuth login
  flows, model catalog with pricing, pi settings editor, first-run onboarding.
- **Chapter 7 — Workspace & power features: complete** ([docs/chapter7-status.md](docs/chapter7-status.md))
  File explorer (symlink-safe, root-scoped), diff review queue, embedded xterm terminal
  (node-pty), commands browser, tray + native menus + completion notifications, and a
  bundled approval extension (confirm-before-apply via pi's public extension API).
- **Chapter 8 — Hardening & release: complete** ([docs/chapter8-status.md](docs/chapter8-status.md))
  IPC fuzzing (found+fixed a real crash), secrets scanning, dependency audits clean,
  auto-update wiring, PyInstaller sidecar binary, CI + signed/notarized release
  pipelines, golden-path e2e.

## Docs

| Doc | Purpose |
|---|---|
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, boundaries, secrets handling |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Exactly what leaves your machine |
| [docs/RELEASE.md](docs/RELEASE.md) | Release checklist + rollback |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common issues (sidecar, keys, search…) |

### Sidecar (optional, enables FTS search + analytics)

```bash
cd sidecar && uv sync   # one-time venv setup
```

## Requirements

- Node.js ≥ 24, npm ≥ 12
- macOS (arm64 or x64)

> **Known environment issue:** if you run CleanMyMac 5 (or similar cleanup tools), add this
> project folder to its exclusion list. Its background assistants were observed removing
> freshly-built files under `out/`/`release/` mid-launch, which breaks dev/e2e runs.
> The e2e suite works around this by staging the app into a temp dir before launching.

## Getting started

```bash
npm install
npm run dev          # launch with HMR
```

Note: npm ≥ 12 blocks lifecycle scripts by default. Approve the two that need them:

```bash
npm install-scripts approve esbuild electron
node node_modules/esbuild/install.js && node node_modules/electron/install.js
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Dev app with renderer HMR |
| `npm run typecheck` | Strict TS across main/preload/renderer configs |
| `npm test` | Unit tests (vitest) |
| `npm run e2e` | Playwright Electron smoke suite (builds + stages app itself) |
| `npm run dist:mac` | Build + package unsigned `.app` (dir output) |
| `npm run dist:mac:dmg` | Build + unsigned dmg (arm64 + x64) |

## Layout

```
src/shared/    IPC contract (types + typebox schemas) — no electron/node imports
src/main/      Main process: router, event bus, services, window
src/preload/   contextBridge surface (window.piDesktop)
src/renderer/  React 19 + Tailwind 4 UI
tests/unit/    vitest unit tests
tests/e2e/     Playwright _electron smoke tests
docs/          security.md and per-chapter notes
```

## Native modules

Deferred to their chapters: `better-sqlite3` (ch4), `node-pty` (ch7). Both will require
`electron-rebuild`; `asarUnpack` entries are pre-staged in `electron-builder.yml`.
