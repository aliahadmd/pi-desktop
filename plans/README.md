# Implementation Plans — pibugs4 cycle

Generated 2026-08-23 against commit `21dc8aa`, from the audit in
[`../pibugs/pibugs4.md`](../pibugs/pibugs4.md). (The pibugs3-cycle plans 001–007
that previously lived in this directory all landed on `master` and were removed
in `1d22b54` at the maintainer's direction; see that commit for the archive.)

Each plan is **self-contained**: an executor with no knowledge of this repo or
the audit should be able to work from the plan file plus the codebase alone.
Read the whole plan before starting, honor its STOP conditions rather than
improvising, and update your row in the table below when you finish.

## Execution order & status

| Plan | Title | Priority | Effort | Risk | Depends on | Status |
|------|-------|----------|--------|------|------------|--------|
| [008](008-window-reopen-event-bus.md) | Re-bind event bus when the window is recreated (H-1) | P1 | S | LOW | — | **DONE** — branch `fix/008-window-event-bus`, commit `88c598e`. Typecheck / 98 unit (4 new) / 30 e2e / audit / secrets green. Manual reopen matrix below still unverified. |
| [009](009-switch-session-cwd.md) | Propagate real cwd through session switch (H-2) | P1 | M | MED | — | **DONE** — branch `fix/009-switch-session-cwd`, commits `68f6b0c` + `7b5c03e`. Typecheck / 100 unit (2 new) / 30 e2e green. Deviation: used upstream `SessionManager.getCwd()` instead of header reads (plan's own STOP condition — a direct accessor exists in the pinned version, so no `cwd.ts` extraction was needed and no import cycle arose). Manual switch matrix below still unverified. |
| [010](010-commands-detail-path.md) | Commands detail view reachable: `path` + extension commands (C-1) | P1 | M | MED | — | **DONE** — branch `fix/010-commands-detail-path`, commits `91c2c57` + `899013a` + `3db2e35`. Typecheck / 112 unit (12 new) / 30 e2e green. Verified against the live agent dir (34 skills + 6 prompts, all with `.md` `filePath`). Also widened `backend.ts`'s `getCommands()` signature (plan allows this) and caught a real parser bug: the installed `/council` hint split into nine bogus argument inputs — bracketed groups are now single placeholders, pinned by a regression test. Manual detail-pane check (Step 4) still unverified. |
| [011](011-snippet-segments-no-raw-html.md) | Snippet segments instead of raw HTML (H-3) | P1 | M | MED | — | **DONE** — branch `fix/011-snippet-segments`, commits `3c6f4db` + `4c97d18` (+ `92bdbfb` hygiene). Sidecar 14 pytest / mypy clean / typecheck / 120 unit (8 new) / 30 e2e green. Verified end-to-end against the real search pipeline: `<img src=x onerror=alert(1)>` returns as segment text with no `<mark>` on the wire and no delimiter leakage. Also ported `test_api.py`'s highlight assertion (highlight-presence, not the vulnerability) and untracked 11 committed `.pyc` files. Manual sessions-search check still unverified. |
| [012](012-small-fixes-batch.md) | Four small fixes: editor fallback, onboarding memory, log retention, timer leak (M-1, M-4, M-6, M-7) | P2 | S | LOW | 008 soft (file overlap) | **DONE** — commits `47e13ca` + `154b825` + `f8e96a3` + `f488299` (landed on `fix/011-snippet-segments` alongside 011; the two touch disjoint files). Typecheck / 125 unit (5 new) / 30 e2e green. Deviation: plan assumed `sidecar-manager.test.ts` had child-process fakes — it spawns the real Python sidecar, so the interval test stubs the timer pair against the real class instead of adding a mock framework (STOP condition respected). Fix 3 gained test coverage the plan marked optional. All three testable fixes verified to fail without the change. Manual matrix (PATH-less editor open, skip-across-relaunch) still unverified. |

Status values: `TODO` · `IN PROGRESS` · `DONE` (commit) · `BLOCKED` (one-line
reason) · `REJECTED` (one-line rationale).

## Findings covered

| Plan | Audit 4 findings |
|---|---|
| 008 | H-1 |
| 009 | H-2 |
| 010 | C-1 (both halves: dead detail flow + missing extension commands) |
| 011 | H-3 |
| 012 | M-1, M-4, M-6, M-7 |

## Not planned — remaining audit 4 findings

Deliberately left unplanned, with the reasoning, so they don't look forgotten:

- **M-2 (rename chain half-wired)** — small, but it wants a product decision
  first: where session names should live in the UI (tab label? sidebar row?
  both?) now that the palette owns rename. Fold it into the next UX pass
  rather than patching the prefill alone. The `session_info_changed` swallow
  is a two-line fix whenever someone picks it up.
- **M-3 (hiding the dock kills terminals)** — behavior question: is
  hide-equals-kill acceptable if surfaced? The plan shape depends on the
  answer (confirm dialog vs keep-mounted). Needs the maintainer's call.
- **M-5 (explorer cache staleness)** — the right invalidation hook
  (`tool_execution_end` for edit/write vs a manual refresh control) is a UX
  choice; also interacts with plan 009's cwd changes. Schedule after 009 lands.
- **M-8 (approval-gate copy overstates scope)** — one-line hint edit, but the
  honest fix may include an RPC-session warning, which is copy + flow. Bundle
  with the next docs/security.md touch.
- **L-1…L-7** — polish/dead-code items; sweep them in a single cleanup commit
  whenever convenient. None blocks anything.

## Baseline & gates

All plans assume the standard gate battery from `AGENTS.md`:

```bash
npm run typecheck   # strict TS, exactOptionalPropertyTypes
npm test            # vitest unit suite (94 passing at plan time)
npm run e2e         # Playwright _electron, 30 tests
npm audit --omit=dev && ./scripts/check-secrets.sh
```

Plus, for plans touching the sidecar (011): `uv run pytest -q` and
`uv run mypy app/` from `sidecar/`.

Environment notes that have bitten before (from AGENTS.md — still true):
CleanMyMac-class tools deleting `out/`/`release/` mid-build; node-pty ABI
mismatches fixed by `./scripts/setup-native.sh`, not code.
