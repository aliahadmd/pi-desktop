# Implementation Plans

Generated 2026-08-22 against commit `02fbaf0`, from the audit in
[`../pibugs/pibugs3.md`](../pibugs/pibugs3.md).

Each plan is **self-contained**: an executor with no knowledge of this repo or
the audit should be able to work from the plan file plus the codebase alone.
Read the whole plan before starting, honor its STOP conditions rather than
improvising, and update your row in the table below when you finish.

**Status as of 2026-08-23:** all seven plans have landed on `master`. Plans
002–004 were executed on their own branches and merged; plans 001, 005, 006
and 007 were implemented together in commit `81e6513`, which also fixed the
unplanned findings M-6, M-7, M-8, M-10 and L-1/L-2/L-3. The C-2 channel sweep
— deliberately unplanned pending a product call — has since been resolved via
a ⌘K command palette plus inline affordances (see §C-2 below).

## Execution order & status

| Plan | Title | Priority | Effort | Risk | Depends on | Status |
|------|-------|----------|--------|------|------------|--------|
| [001](001-app-and-tray-icons.md) | App icon + repair blank tray icon | P1 | S | LOW | — | **DONE** — commit `81e6513`. |
| [002](002-six-high-severity-oneliners.md) | Six high-severity one-liners | P1 | S | LOW | — | **DONE** — reviewed, approved; branch `advisor/002-high-severity-oneliners`, 6 commits, head `3665f5c`. |
| [003](003-fix-escaped-absolute-positioning.md) | Anchor escaped `absolute` elements | P1 | S | LOW | — | **DONE** — reviewed, approved; branch `advisor/003-absolute-positioning`, commit `b0a03c5`. Manual visual check still outstanding. |
| [004](004-wire-the-approval-gate.md) | Wire the approval gate | P1 | M | MED | — | **DONE** — reviewed, approved; branch `advisor/004-approval-gate`, 3 commits, head `28ca09c`. Feature itself unverified — see below. |
| [005](005-persist-terminal-tabs.md) | Persist terminal tabs across switches | P2 | M | MED | 002, 003 | **DONE** — commit `81e6513`; manual pty protocol below still unverified. |
| [006](006-transcript-streaming-and-row-state.md) | Transcript follow + row state + keys | P2 | M | MED | 002 (soft) | **DONE** — commit `81e6513` (also covered out-of-scope M-6/M-7); manual checks below still unverified. |
| [007](007-session-cwd-and-update-feed.md) | Real session cwd + disable stray update feed | P2 | S | LOW | 002 (soft) | **DONE** — commit `81e6513`. |

Status values: `TODO` · `IN PROGRESS` · `DONE` · `BLOCKED` (one-line reason) ·
`REJECTED` (one-line rationale).

## Findings covered

| Plan | Audit findings |
|---|---|
| 001 | C-3 |
| 002 | H-1, H-2, H-3, H-4, H-5, M-9 |
| 003 | H-7 |
| 004 | C-1 (and the docs half of it) |
| 005 | H-6, M-11 |
| 006 | M-1, M-2, M-3 |
| 007 | M-4, M-5 |

## Not planned — needs a product decision from the maintainer

**RESOLVED 2026-08-23.** The decision taken was the **⌘K palette** shape
(audit direction #2, matching UX-GAPS #8): `CommandPalette.tsx` now surfaces
rename / clone / switch-session-file / abort-bash / set-model (which together
make `session.rename`, `session.clone`, `session.switch`, `session.abort_bash`,
`session.set_model`, and `session.models` reachable), plus open-session
switching, dock tabs, sheets, and pi commands. The two affordances the audit
said a palette cannot cover landed inline: a **stop button on running
`!`/`!!` bash blocks** (`session.abort_bash`) and an **"Open in editor"
button on file rows** (`workspace.open_in_editor`). ModelsPage gained
"Use in session" alongside "Set default". A new top-sessions panel in the
browse sheet surfaces `sidecar.top`. The OAuth input gap found by the
coverage lint is fixed: `auth_prompt` events now open an input modal that
answers via `auth.respond_login`. Remaining channels without UI are pinned by
`tests/unit/channel-coverage.test.ts` with documented reasons in its allowlist
(`session.steer`/`follow_up` deliberately dead, `session.list` superseded,
`session.entries` internal cursor, `db.projects.list` view deferred,
`session.stats` meter deferred, `workspace.roots` multi-root deferred,
`sidecar.status` push-covered).

<details><summary>Original decision request (kept for the record)</summary>

Writing one means deciding which channels get UI and where each affordance
lives — a session-header overflow menu, a command palette, per-file "Open"
buttons — and that is a product call, not a wiring one. The audit
(`../pibugs/pibugs3.md`, §C-2) lists all thirteen with what each would surface.
Two shapes worth weighing:

- **Per-affordance**: rename/clone/delete in a session header menu,
  `open_in_editor` on file rows, `abort_bash` next to the running command.
  Thorough, but ~6 separate UI additions.
- **One ⌘K palette** (audit direction #2): most of the thirteen become reachable
  through a single surface, and it also fixes discoverability generally.
  Cheaper overall, but leaves file-row and inline-cancel actions unaddressed.

Say which and it becomes a plan.
</details>

## Merging the three finished branches — DONE

**Merged into `master` on request. `master` is now `e88d851`.**
Pre-merge reset point: `02fbaf0`. All three branches are retained
(`advisor/002-…`, `advisor/003-…`, `advisor/004-…`) so any of them can still be
inspected or reverted individually.

Post-merge gate on `master`:

```
typecheck ✓    unit 66/66 ✓    e2e 30/30 ✓    secrets clean ✓
```

| Merge step | Result |
|---|---|
| `advisor/002-high-severity-oneliners` onto `02fbaf0` | clean (fast-forward) |
| `advisor/003-absolute-positioning` | **conflict** in `tests/unit/regressions.test.ts` — resolved block-aware |
| `advisor/004-approval-gate` | **conflict** in `tests/unit/regressions.test.ts` — resolved block-aware |

**Cause:** all three plans told their executor to extend the same file, and each
appended a new `describe` block plus imports at the top. That is a flaw in how
the plans were written, not in any executor's work.

**Do not resolve it by stripping conflict markers.** The hunks interleave, so a
naive union splices one `describe` into the middle of another and silently drops
closing braces — it produces a file that looks merged and does not parse.
Resolve block-aware instead: keep every `describe` whole, in order, and
de-duplicate the imports (`path`, `requestSchemaMap`) and the `const ROOT`
declaration, which two branches both introduce.

A correctly resolved copy is saved at
`<scratchpad>/regressions.merged.test.ts` — 13 `describe` blocks, balanced
braces, verified below.

**Combined state, after correct resolution:**

```
typecheck ✓    unit 66/66 ✓    e2e 30/30 ✓
```

So the merge is safe once the test file is resolved by hand. Suggested order:
002 → 003 → 004.

## Outstanding human verification

Executors cannot drive the GUI. These checks are the only real proof the
corresponding fix works, and they are **not** covered by any automated gate:

- **Plan 003** — with the window narrowed below 900px (sidebar collapsed) and
  2+ sessions open: clicking a session tab must switch sessions, and the rail's
  top area must still drag the window. Then: drop-overlay confined to the
  composer; review badge on the 🔍 button's corner; session context menu inside
  the sidebar column.
- **Plan 002** — the completion sound now fires from the store on
  `agent_settled`. Automated tests cover the phase logic but not audio. Confirm:
  sending a prompt plays exactly one tone (not two), a tone plays when the run
  actually finishes, and **resuming an existing session plays nothing** (the
  hydration path must stay silent). Also confirm typing in the sidebar search
  now filters the list.

- **Plan 004 — the most important one.** Nothing automated proves the gate
  actually gates; the four new tests only prove the wiring exists. Run the
  seven-step protocol in `004-wire-the-approval-gate.md` step 7. The check that
  matters: clicking **Cancel** on the "Allow bash?" dialog must *block* the tool
  (the agent should see "Denied by user in Pi Desktop."), not merely dismiss the
  dialog and let it run.

- **Plan 005** — run the eight-item manual pty protocol in
  `005-persist-terminal-tabs.md` step 5 (persistence across switches,
  long-running process survival, resize-on-show, close arithmetic, the
  8-terminal cap, no orphaned shells on quit).

- **Plan 006** — run the five manual checks in `006-transcript-streaming-and-row-state.md`
  step 6 (follow while streaming, scroll-up releases follow, row state survives
  scrolling, dismissal sticks, no animation flicker).

### Left over from plan 004

`aboutproject.md` still carries two stale claims and was **not** updated: it is
untracked in git, so it does not exist inside an executor worktree and could not
be reached from there.

- line 20 — "e.g. the approval gate extension" implies it was always active.
- line 37 — the source table still points at
  `resources/extensions/pi-desktop-approve.ts`, which plan 004 moved to
  `src/main/pi/approve-extension.ts`.

Both need a one-line edit in the main checkout after 004 merges. (Note this file
being untracked is itself why it drifted — see the repo-hygiene finding L-5.)

### Scope note carried from review

Plan 002's executor also edited `src/renderer/src/services/sound.ts`, which was
not in that plan's in-scope list. This was correct: the plan's own step 3
instructed adding `playSoundIfEnabled` to that file. The scope list was
incomplete, not the execution — recorded here so the diff doesn't look like
drift later.

## Dependency notes

- **001, 002, 003 and 004 are independent** and can be executed in any order or
  in parallel by separate executors. 001 and 004 barely touch the renderer;
  002 and 003 both touch `Sidebar.tsx`, `Composer.tsx` and `ChatPage.tsx` but at
  different lines.
- **005 depends on 002 and 003** for merge hygiene only, not logic. All three
  edit `ChatPage.tsx`, and 002 deletes ~31 lines from it (the duplicated Compact
  dialog), which shifts every line number after ~466. Landing 005 first means
  rebasing the other two onto moved line numbers.
- If you run 002 and 003 concurrently, land 002 first and rebase 003 — 003's
  affected sites in `ChatPage.tsx` (line 270) sit *above* 002's deletion, so the
  conflict surface is small either way.

## Convention: one test file per plan

**Every plan gets its own `tests/unit/<plan-topic>.test.ts`. Never tell an
executor to extend a shared test file.**

Learned the hard way: plans 002, 003 and 004 all appended to
`tests/unit/regressions.test.ts`, which turned three otherwise-clean branches
into a three-way conflict — and one whose hunks interleave, so the obvious
resolution silently produces a file that does not parse (see the merge section
above).

Applied to the unexecuted plans:

| Plan | Test file |
|---|---|
| 001 | `tests/unit/assets.test.ts` |
| 005 | `tests/unit/terminal-tabs.test.ts` |
| 006 | `tests/unit/transcript-ui.test.ts` |
| 007 | `tests/unit/session-cwd.test.ts` |

Plans 002–004 still say `regressions.test.ts` because they have already been
executed — their text is the record of what was done, and editing it now would
misdescribe the branches sitting in the worktrees.

## Verification gates (all plans)

Every plan uses the same commands. Confirmed working at planning time:

```bash
npm run typecheck   # strict TS across tsconfig.web.json + tsconfig.node.json
npm test            # vitest, 53 passing at baseline
npm run e2e         # Playwright _electron, 30 passing at baseline
```

Baseline at commit `02fbaf0`: typecheck clean, 53/53 unit, `npm audit --omit=dev`
reports 0 vulnerabilities. **Any plan that leaves these worse than baseline is
not done.**

Two environment notes carried into the plans:

- Local cleanup tools (CleanMyMac-class) have been observed deleting files under
  `out/` and `release/` mid-build. A single packaging failure is likely that; a
  second consecutive one is real.
- If terminals fail to spawn with `posix_spawnp` errors, run
  `./scripts/setup-native.sh` — that is the known `node-pty` Electron ABI
  mismatch, not a code defect.

## Findings considered and rejected

Recorded so nobody re-audits them (full reasoning in `../pibugs/pibugs3.md`):

- **Shiki `dangerouslySetInnerHTML` as an XSS sink** — shiki escapes code
  content and the anchor renderer already restricts hrefs to http/https.
- **Usage-capture field mismatch** — diffed against pi's `Usage` interface
  (`pi/packages/ai/src/types.ts:382`); every field matches exactly.
- **PTY id regex rejecting renderer ids** — the renderer's
  `pty-${Date.now()}-${base36}` format satisfies `/^[A-Za-z0-9_-]{1,64}$/`.
- **`Sheet.tsx` absolute positioning** — technically the same missing-`relative`
  pattern as H-7, but the viewport-relative result is the intended full-window
  layout. Folded into plan 003 as an explicitness fix rather than a bug.
- **`hydrate()` id collisions with `nextId()`** — prefixes differ (`a-`/`u-`/`t-`
  vs `asst-`/`notice-`); no collision is possible.
- **Dependency vulnerabilities** — `npm audit --omit=dev` reports zero.
- **`session.steer` / `session.follow_up` as unreachable channels** — they *are*
  unreachable, but by design: the composer routes both through `session.prompt`
  with `streamingBehavior`. Dead surface to delete deliberately, not a bug to
  fix. Deliberately excluded from the C-2 sweep.
