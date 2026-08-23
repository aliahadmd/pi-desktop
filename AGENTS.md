# AGENTS.md — orientation for coding agents working on Pi Desktop

Pi Desktop is a macOS Electron client for the [Pi coding agent](../pi/README.md).
`aboutproject.md` is the narrative overview (architecture, decisions, timeline);
this file is the working rulebook. Read both before changing anything.

## Read in this order

1. `docs/SECURITY.md` — threat model and trust boundaries. Never weaken them.
2. `src/shared/pi.ts` — every IPC channel with its typebox schema. This is the
   map of what the app can do.
3. `aboutproject.md` — why the architecture is what it is.
4. `plans/README.md` + `pibugs/pibugs3.md` — current remediation state; three
   audits' findings are all fixed, with the reasoning for rejections recorded.
5. Upstream docs when touching pi integration: `../pi/packages/coding-agent/docs/`
   (`sdk.md`, `rpc.md`, `session-format.md`, `extensions.md`).

## Gates (all must pass before you claim done)

```bash
npm run typecheck   # strict TS, exactOptionalPropertyTypes
npm test            # vitest unit suite (94 passing as of 2026-08-23)
npm run e2e         # Playwright _electron, 30 tests; builds and stages itself
npm audit --omit=dev && ./scripts/check-secrets.sh
```

Environment notes: cleanup tools (CleanMyMac-class) have been observed deleting
files under `out/`/`release/` mid-build — one packaging failure is probably
that, two in a row is real. If terminals fail with `posix_spawnp` errors, run
`./scripts/setup-native.sh` (node-pty/Electron ABI mismatch), don't debug code.

## Conventions

- TypeScript strict everywhere; tabs for indent, double quotes.
- All IPC request shapes live in `src/shared/pi.ts` as typebox schemas; that
  file must stay free of node/electron imports. Handlers never throw across
  the wire — results travel as `IpcResult<T>` envelopes.
- New channels need a renderer caller: `tests/unit/channel-coverage.test.ts`
  fails when a contract channel has no UI caller or documented allowlist entry.
- One test file per concern/plan. Never append to a shared regressions file —
  three plans did that once and produced an interleaved three-way conflict.
- Renderer state: zustand stores (`stores/pi-sessions.ts` for session data,
  `stores/transcript-ui.ts` for per-row transcript UI). Keep `lib/ingest.ts`
  pure — no React, no Electron.
- Virtualized transcript rows unmount on scroll: any per-row UI state belongs
  in `transcript-ui`, keyed `${sessionId}:${blockId}`, never in useState.

## Process

- Conventional commits (`fix:`, `feat:`, `docs:`). Do not push or open PRs.
- Pi version is pinned exactly (`@earendil-works/*`); upstream breaks APIs
  between minors. Before bumping, run `scripts/check-pi-updates.sh`.
- The approval-gate extension ships via public ExtensionAPI — do not fork pi.
