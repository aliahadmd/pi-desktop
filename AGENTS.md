# AGENTS.md — orientation for coding agents working on Pi Desktop

Pi Desktop is a macOS Electron client for the [Pi coding agent](../pi/README.md).
`aboutproject.md` is the narrative overview (architecture, decisions, timeline);
this file is the working rulebook. Read both before changing anything.

## Read in this order

1. `docs/security.md` — threat model and trust boundaries. Never weaken them.
2. `src/shared/pi.ts` — every IPC channel with its typebox schema (85 today).
   This is the map of what the app can do.
3. `aboutproject.md` — why the architecture is what it is.
4. `pibugs/` — audit findings and their remediation state; six audits, with
   the reasoning for rejections recorded. Audit 6's open items are listed in
   its "Post-audit status summary" (audit 5's remain open where noted).
5. Upstream docs when touching pi integration: `../pi/packages/coding-agent/docs/`
   (`sdk.md`, `rpc.md`, `session-format.md`, `extensions.md`).

## Gates (all must pass before you claim done)

```bash
npm run typecheck   # strict TS, exactOptionalPropertyTypes
npm test            # vitest unit suite (70 files, 380 passing as of 2026-08-27)
npm run e2e         # Playwright _electron, 34 tests; builds and stages itself
npm audit --omit=dev && ./scripts/check-secrets.sh
cd sidecar && uv run pytest -q && uv run mypy app/   # 26 passing
```

Environment notes: cleanup tools (CleanMyMac-class) have been observed deleting
files under `out/`/`release/` mid-build — one packaging failure is probably
that, two in a row is real. Terminals failing with `posix_spawnp failed` are
almost always node-pty's `spawn-helper` shipping without its execute bit
(microsoft/node-pty#850), NOT an ABI mismatch: the app now repairs it at boot
and retries once on spawn failure (`src/main/pty-native.ts`), and
`npm run fix:pty` fixes a checkout by hand. Reach for
`./scripts/setup-native.sh` only when the native module genuinely fails to
*load* (a real Electron ABI mismatch), not when it loads and then fails to
spawn.

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
- **Colors come from theme tokens, never hardcoded ramps.** Every color is a
  preset token in `src/shared/theme.ts` (`ThemeVars`), applied to the DOM as
  `--pi-<kebab-case>` by `lib/apply-theme.ts`. Tailwind ramp classes
  (`bg-red-800`, `text-amber-400`…) must be remapped in the `@theme inline`
  block of `index.css`; `tests/unit/theme-ramp-coverage.test.ts` fails the
  build on any unmapped `(bg|text|border|ring)-<ramp>-<step>` in components.
  Adding a color means adding a token to all five presets.
- **Icons are lucide-react only** — never emoji or text glyphs (`▸ ✓ ⚙ 📦`).
  Sizes 10–16, `strokeWidth` ~2; icon-only buttons carry `aria-label`.
- Settings UI is a grouped two-pane layout (section list + panel); new settings
  join an existing group rather than appending to a flat list.

## Process

- Conventional commits (`fix:`, `feat:`, `docs:`). Do not push or open PRs.
- Pi version is pinned exactly (`@earendil-works/*`); upstream breaks APIs
  between minors. Before bumping, run `scripts/check-pi-updates.sh`.
- The approval-gate extension ships via public ExtensionAPI — do not fork pi.
- The `../pi` clone tracks upstream `main` and sits **ahead** of the pinned
  version. Diff against the tag you depend on (`git diff v0.84.2..HEAD`), not
  `HEAD`, or you will read code the app does not run.
- `piplan/`, `pibugs/`, and `plans/` are gitignored working directories, not
  deliverables. Phase work lands as `piplan/Phase-N/{main,planNN,STATUS}.md`.
