# Pi Desktop

macOS Electron client for the [Pi coding agent](../pi/README.md) — session management,
streaming chat, file attachments, an embedded terminal, a package marketplace, and
usage analytics, without losing any of pi's capability.

See [aboutproject.md](aboutproject.md) for the architecture narrative and full
timeline, and [AGENTS.md](AGENTS.md) for the working rulebook.

## Status

**Phases 1–7 complete (chapters 1–33)** · master `6dcb187` · pi pinned at `0.84.2`

| Phase | Scope | Detail |
|---|---|---|
| 1 (ch 1–8) | Foundation → release pipeline: typed IPC, SDK + RPC backends, chat UI, SQLite persistence, Python sidecar, models/auth/settings, workspace features, hardening | [chapter status docs](docs/) |
| 2 (ch 9–13) | Advanced pi features: session trees, providers deep, skills/packages/prompt templates, desktop tools, compaction + trust UI | `piplan/Phase-2/STATUS.md` |
| 3 (ch 14–18) | UI/UX redesign: three-column layout, sessions sidebar, composer v2, grouped tool rows, motion system | `piplan/Phase-3/STATUS.md` |
| 4 (ch 19–24) | Stability, attachments, icon dock, embedded terminal, sound system | `piplan/Phase-4/STATUS.md` |
| 5 (ch 25–27) | Permission modes: the five-mode autonomy ladder with live per-session state | `piplan/Phase-5/STATUS.md` |
| 6 (ch 28–30) | Projects: pinning, sort, create/open, sidebar project rows, top app bar | `piplan/Phase-6/STATUS.md` |
| 7 (ch 31–33) | Appearance: theme engine (5 presets incl. light), UI scale, transparency, theme-aware syntax highlighting, richer history rows | `piplan/Phase-7/STATUS.md` |

Verification at this commit: typecheck clean · **198 unit** tests (30 files) ·
**34 e2e** · **14 sidecar pytest**.

Five audit cycles are recorded in `pibugs/`; open items from the latest are
listed under "Current state" in [aboutproject.md](aboutproject.md).

> `piplan/` and `pibugs/` are gitignored working directories — present locally,
> not part of the published tree.

## Docs

| Doc | Purpose |
|---|---|
| [docs/security.md](docs/security.md) | Threat model, boundaries, secrets handling |
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
src/shared/    IPC contract (81 channels: types + typebox schemas), theme presets
               — no electron/node imports
src/main/      Main process: router, event bus, pi backends, store, sidecar mgr
src/preload/   contextBridge surface (window.piDesktop)
src/renderer/  React 19 + Tailwind 4 UI (pages, components, zustand stores)
sidecar/       Python FastAPI service: FTS5 search + analytics
tests/unit/    vitest unit tests (27 files)
tests/e2e/     Playwright _electron tests
docs/          security.md, privacy, release, troubleshooting, ch1–8 status
```

## Native modules

`better-sqlite3` and `node-pty` are compiled against Electron's ABI, with
`asarUnpack` entries in `electron-builder.yml`. If the terminal fails with
`posix_spawnp` errors after an Electron or Node upgrade, the ABI no longer
matches — run `./scripts/setup-native.sh` rather than debugging app code.
