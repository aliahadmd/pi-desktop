# Plan 002: Fix six independent high-severity defects (search, duplicate modal, sound, stuck phase, bash status, mislabeled button)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> ```
> git diff --stat 02fbaf0..HEAD -- src/renderer/src/components/shell/Sidebar.tsx src/renderer/src/pages/ChatPage.tsx src/renderer/src/lib/ingest.ts src/main/pi/service.ts src/renderer/src/components/chat/Composer.tsx
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `02fbaf0`, 2026-08-22

## Why this matters

Six unrelated defects, each a few lines, each user-visible on the app's most
common paths: session search silently does nothing, the Compact dialog renders
twice on top of itself, the "task finished" sound plays at the wrong moment,
a manual compaction wedges the UI in a fake "streaming" state until the user
sends another prompt, failed shell commands display a green success checkmark,
and a button labelled "Open review" opens the Commands panel.

They are grouped into one plan because they are all small, all independent, and
all in the same two or three files — six separate branches would cost more in
overhead than the fixes themselves. **Each step is independently verifiable and
independently revertable.** If one step turns out to be harder than described,
complete the other five and report the one you skipped.

## Current state

Files involved:

- `src/renderer/src/components/shell/Sidebar.tsx` — sidebar: session list,
  search box, project grouping (fix 1)
- `src/renderer/src/pages/ChatPage.tsx` — chat surface: session tabs,
  transcript, dock, composer, compact dialog (fixes 2 and 3)
- `src/renderer/src/lib/ingest.ts` — pure event→transcript reducer, no React
  imports, fully unit-tested (fix 4)
- `src/main/pi/service.ts` — main-process session registry and `session.*` IPC
  handlers (fix 5)
- `src/renderer/src/components/chat/Composer.tsx` — prompt input, git strip,
  attachments (fix 6)

### Fix 1 — `Sidebar.tsx:44-50`, stale closure kills search

```ts
	const load = useCallback(async (): Promise<void> => {
		const result = await window.piDesktop.invoke({
			type: "db.sessions.search",
			query: filter,
		});
		if (result.ok) setSessions(result.data.sessions);
	}, []);
```

and the effect that drives it at `Sidebar.tsx:59-64`:

```ts
	useEffect(() => {
		void load();
		if (collapsed) return; // rail mode: no DB polling needed
		const timer = setInterval(() => void load(), 10_000);
		return () => clearInterval(timer);
	}, [filter, load, collapsed]);
```

`load` reads `filter` but declares `[]` dependencies, so the closure captures
the value from the first render — permanently `""`. The effect re-runs on every
keystroke but re-invokes the same stale function. The main-process handler
(`src/main/store/service.ts`, `db.sessions.search`) is correct and unit-tested;
only this caller is broken.

### Fix 2 — `ChatPage.tsx:466-496`, the Compact dialog is rendered twice

Two `{compactOpen && (…)}` blocks exist: one starting at line 466 (immediately
before `<Composer …>` at line 497) and a second starting at line 536 (after
`<StatusBar …>`). Both are `absolute inset-0 z-50` overlays with
`bg-black/60`, both contain a `data-testid="compact-confirm"` button.

The block at **466 is the stale copy**: it omits the `refreshState(active.id)`
call that the 536 block makes, and it contains the codebase's only `as any`
cast at line 485. The 536 block is the correct one and, being later in DOM
order at equal `z-index`, is the one that paints on top.

Line 466 begins:

```tsx
{compactOpen && (
<div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
<div className="w-[420px] rounded-xl border border-neutral-700 bg-neutral-900 p-5">
<h3 className="mb-1 text-sm font-semibold text-neutral-100">Compact context</h3>
<p className="mb-3 text-xs text-neutral-400">Summarizes older messages to free window space.</p>
```

and the block closes at line 496 with `)}` on its own line, directly above
`<Composer` on line 497. Note the stale copy is written with flattened
indentation (its JSX starts at column 0), which is how to tell the two apart at
a glance — the block at 536 is properly indented.

### Fix 3 — `ChatPage.tsx:125-149`, completion sound fires on acceptance

```ts
	function send(
		text: string,
		images: PiImageInput[],
		streamingBehavior?: "steer" | "followUp"
	): void {
		if (activeId === null) return;
		if (text.length > 0) addUserBlock(activeId, text);
		play("sent");
		void window.piDesktop
			.invoke({
				type: "session.prompt",
				sessionId: activeId,
				text,
				...(images.length > 0 ? { images } : {}),
				...(streamingBehavior !== undefined ? { streamingBehavior } : {}),
			})
			.then((result) => {
				if (!result.ok) {
					pushErrorNotice(activeId, `Prompt rejected: ${result.error.message}`);
					play("error");
				} else {
					play("complete");
					refreshState(activeId);
				}
			});
	}
```

`session.prompt` resolves **when the prompt is accepted, not when the run
completes**. This is stated explicitly in `src/main/pi/backend.ts:56-58`:

> `prompt/steer/followUp resolve when accepted (not when the run completes) —`
> `completion is observed through events (agent_settled).`

So `play("sent")` and `play("complete")` fire back-to-back at send time, and
nothing plays when the agent actually finishes. Confirmed: `agent_settled`
appears in the renderer only at `src/renderer/src/lib/ingest.ts:200`; no sound
call is attached to it.

The sound helper lives at `ChatPage.tsx:54-60`:

```ts
	const play = (event: SoundEvent): void => {
		void window.piDesktop
			.invoke({ type: "app.settings.get", key: "soundEnabled" })
			.then((r) => {
				if (r.ok && r.data !== false) playSound(event);
			});
	};
```

### Fix 4 — `ingest.ts:381-390`, compaction leaves the phase stuck

```ts
		case "compaction_end": {
			ctx.phase = "streaming";
			const ok = !event.aborted && event.errorMessage === undefined;
			ctx.blocks.push({
				kind: "notice",
				id: nextId(ctx, "notice"),
				text: ok ? "Context compacted." : `Compaction failed: ${event.errorMessage ?? "aborted"}`,
				level: ok ? "info" : "warn",
			});
			break;
		}
```

and the start case at `ingest.ts:373-380`:

```ts
		case "compaction_start":
			ctx.phase = "compacting";
			ctx.blocks.push({
				kind: "notice",
				id: nextId(ctx, "notice"),
				text: `Compacting context (${event.reason})…`,
				level: "info",
			});
			break;
```

Setting `"streaming"` on end is correct for automatic compaction (reason
`"threshold"` / `"overflow"`), which happens mid-run and will be followed by an
`agent_settled`. It is wrong for `reason: "manual"`, because the Compact button
is `disabled={active.phase !== "idle"}` (`ChatPage.tsx:422`) — a manual
compaction always starts from idle, so no `agent_settled` ever arrives to clear
the phase. The session then shows a pulsing "streaming" status, the composer
switches to the Steer/Follow-up toggle with a red Stop button, and Compact stays
disabled.

The `IngestContext` shape is at `ingest.ts:111-117`:

```ts
export interface IngestContext {
	blocks: Block[];
	streamingAssistantId: string | null;
	phase: "idle" | "streaming" | "compacting" | "retrying";
	retryNoticeId: string | null;
	seq: number;
}
```

and its factory at `ingest.ts:119-127` (`createContext()`).

### Fix 5 — `service.ts:150-178`, failed bash reports success

```ts
		router.handle("session.bash", async (req) => {
			try {
				return await this.backend(req.sessionId).bash(req.command, {
					...(req.excludeFromContext === true ? { excludeFromContext: true } : {}),
					...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
				});
			} finally {
				// Complete the streaming bash block in the transcript.
				this.bus.send({
					type: "pi_event",
					sessionId: req.sessionId,
					event: {
						type: "tool_execution_end",
						toolCallId: req.requestId,
						toolName: "bash",
						isError: false,
					},
				});
				for (const hooks of this.hooksList) {
					hooks.onSessionEvent?.(
						req.sessionId,
						{
							type: "tool_execution_end",
							toolCallId: req.requestId,
							toolName: "bash",
							isError: false,
						}
					);
				}
			}
		});
```

The `finally` runs on both paths with `isError: false` hardcoded — and the
event envelope is duplicated between the bus send and the hooks loop, so the
two can drift.

### Fix 6 — `Composer.tsx:203-208`, "Open review" opens Commands

```tsx
					<button
						type="button"
						onClick={onOpenPalette}
						className="ml-auto rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] text-neutral-300 hover:bg-neutral-700"
					>
						Open review
					</button>
```

`onOpenPalette` is wired by ChatPage at line 501 to
`onOpenPalette={() => setDockTab("commands")}`. The Composer prop list is at
`Composer.tsx:17-41`; `DockTab` is declared at `ChatPage.tsx:21`:

```ts
type DockTab = "files" | "review" | "commands" | "tree" | "terminal" | null;
```

### Repo conventions to match

- **Strict TypeScript**, no `any`. Both `tsconfig.node.json` and
  `tsconfig.web.json` must pass.
- Tabs for indent, double-quoted strings, semicolons.
- **Optional properties are spread conditionally**, never set to `undefined` —
  the codebase uses `...(x !== undefined ? { x } : {})` everywhere because
  `exactOptionalPropertyTypes` is on. Match this.
- `ingest.ts` is **pure**: no React, no Electron, no `window`. Keep it that way —
  that purity is what makes `tests/unit/ingest.test.ts` possible.
- Renderer store mutations go through Zustand (`src/renderer/src/stores/pi-sessions.ts`).
- Tests use `vitest` with `describe`/`it`/`expect`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | exit 0, `53 passed` before your changes |
| Single test file | `npx vitest --run tests/unit/ingest.test.ts` | exit 0 |
| E2E (slow, builds the app) | `npm run e2e` | exit 0, 30 passed |

## Scope

**In scope**:

- `src/renderer/src/components/shell/Sidebar.tsx`
- `src/renderer/src/pages/ChatPage.tsx`
- `src/renderer/src/lib/ingest.ts`
- `src/main/pi/service.ts`
- `src/renderer/src/components/chat/Composer.tsx`
- `src/renderer/src/stores/pi-sessions.ts` (fix 3 only — adding the settled hook)
- `tests/unit/ingest.test.ts` (extend)
- `tests/unit/regressions.test.ts` (extend)

**Out of scope** (do NOT touch, even though they look related):

- The four mispositioned `absolute` elements (`Sidebar.tsx:143`,
  `Sidebar.tsx:344`, `Composer.tsx:182`, `ChatPage.tsx:270`) — that is plan 003.
  You will be editing files that contain them; leave them exactly as they are.
- `TerminalPanel.tsx` and the terminal tab logic in `ChatPage.tsx:330-380` —
  that is plan 005.
- `PiService.setExtensionPaths` and anything extension-related — that is plan 004.
- The `session.steer` / `session.follow_up` IPC handlers. They are unused, but
  deleting dead channels is a separate decision.
- `src/main/store/service.ts` — the `db.sessions.search` handler is correct.
- Any change to `src/shared/pi.ts`. No IPC contract changes are needed here.

## Git workflow

- Branch: `advisor/002-high-severity-oneliners`
- One commit per fix, conventional-commit style (from `git log`:
  `fix: add hasInstallScript flag for better-sqlite3 dependency`). Suggested:
  - `fix: make sidebar session search actually filter`
  - `fix: remove duplicated compact dialog`
  - `fix: play completion sound on agent_settled, not prompt acceptance`
  - `fix: restore idle phase after manual compaction`
  - `fix: report failed bash commands as errors`
  - `fix: point Open review button at the review dock tab`
- Do NOT push or open a PR.

## Steps

### Step 1: Make sidebar search filter (fix 1)

In `src/renderer/src/components/shell/Sidebar.tsx`, add `filter` to the
`useCallback` dependency array at line 50:

```ts
	}, [filter]);
```

Then debounce the query. The effect at lines 59-64 currently fires a database
query on **every keystroke**; with search now actually working, that matters.
Restructure so the immediate `load()` is debounced ~200 ms while the 10-second
polling interval is preserved:

```ts
	useEffect(() => {
		const debounce = setTimeout(() => void load(), 200);
		if (collapsed) return () => clearTimeout(debounce);
		const timer = setInterval(() => void load(), 10_000);
		return () => {
			clearTimeout(debounce);
			clearInterval(timer);
		};
	}, [filter, load, collapsed]);
```

Note the collapsed branch must still clear the debounce timer — returning a
cleanup that only handles the interval leaks the timeout.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "}, \[filter\]);" src/renderer/src/components/shell/Sidebar.tsx` →
  one match at the `load` callback

### Step 2: Delete the duplicated Compact dialog (fix 2)

In `src/renderer/src/pages/ChatPage.tsx`, delete **lines 466 through 496
inclusive** — the flattened-indentation `{compactOpen && (…)}` block that sits
directly above `<Composer`. Keep the properly-indented block that follows
`<StatusBar …>`.

Confirm before deleting: the block you remove must be the one containing
`(r.data as any)`. The block you keep must contain `refreshState(active.id);`.

**Verify**:
- `grep -c "compactOpen && (" src/renderer/src/pages/ChatPage.tsx` → `1`
- `grep -c 'data-testid="compact-confirm"' src/renderer/src/pages/ChatPage.tsx` → `1`
- `grep -c "as any" src/renderer/src/pages/ChatPage.tsx` → `0`
- `grep -c "refreshState(active.id);" src/renderer/src/pages/ChatPage.tsx` → at least `1`
- `npm run typecheck` → exit 0

### Step 3: Play the completion sound when the agent settles (fix 3)

Two edits.

**3a.** In `ChatPage.tsx`, remove the `play("complete");` line from the
`.then()` success branch of `send()` (line 146). Keep `refreshState(activeId);`
and keep `play("error")` on the failure branch — a rejected prompt genuinely is
an immediate error.

**3b.** Play `"complete"` when an `agent_settled` event arrives for a session
that had a run in flight. The natural place is the renderer store, which already
routes every `PiEvent`: `src/renderer/src/stores/pi-sessions.ts`.

Requirements:

- Only fire when the session's phase was **not** already `"idle"` before the
  event — otherwise hydration or a stray settle plays a sound for nothing.
- Respect the `soundEnabled` setting, exactly as the existing `play` helper in
  `ChatPage.tsx:54-60` does (`app.settings.get` → play unless the value is
  literally `false`).
- Do **not** import `ChatPage` from the store; move the gated helper into
  `src/renderer/src/services/sound.ts` as an exported function so both call
  sites share it. Suggested addition to `sound.ts`:

```ts
/** Play a sound unless the user disabled sound effects in settings. */
export function playSoundIfEnabled(event: SoundEvent): void {
	void window.piDesktop
		.invoke({ type: "app.settings.get", key: "soundEnabled" })
		.then((r) => {
			if (r.ok && r.data !== false) playSound(event);
		});
}
```

  Then have `ChatPage`'s local `play` delegate to it, and call it from the
  store's event path on `agent_settled`.

> `sound.ts` currently has no `window.piDesktop` reference. Adding one is fine —
> it is a renderer-only module. If TypeScript complains that `window.piDesktop`
> is untyped there, the global is declared in
> `src/renderer/src/stores/pi-sessions.ts:13-17`; import the type rather than
> re-declaring the global twice.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n 'play("complete")' src/renderer/src/pages/ChatPage.tsx` → no matches
- `grep -rn "agent_settled" src/renderer/src/stores/pi-sessions.ts` → at least one match

### Step 4: Restore the phase after a manual compaction (fix 4)

In `src/renderer/src/lib/ingest.ts`:

1. Add a field to `IngestContext` (line 111) to remember the phase compaction
   interrupted:

```ts
	/** Phase to restore when compaction ends (compaction can start from idle). */
	phaseBeforeCompaction: IngestContext["phase"] | null;
```

2. Initialize it to `null` in `createContext()` (line 119).
3. In `case "compaction_start"`, record the current phase **before** overwriting
   it: `ctx.phaseBeforeCompaction = ctx.phase;`
4. In `case "compaction_end"`, restore instead of hardcoding:

```ts
			ctx.phase = ctx.phaseBeforeCompaction ?? "streaming";
			ctx.phaseBeforeCompaction = null;
```

The `?? "streaming"` fallback preserves today's behavior if a `compaction_end`
ever arrives without a matching start.

> **Why not branch on `event.reason`?** `compaction_end` does carry `reason`,
> and keying off `"manual"` would also work — but the recorded-phase approach is
> correct for every reason value without enumerating them, and it stays correct
> if pi adds a new reason. Use the recorded phase.

Check whether the store's `flush()` copies the new field: it spreads the context
(`src/renderer/src/stores/pi-sessions.ts:98-104`, `{ ...session.ctx, blocks: … }`),
so a new scalar field is carried automatically. No store change needed.

**Verify**:
- `npm run typecheck` → exit 0
- `npx vitest --run tests/unit/ingest.test.ts` → exit 0

### Step 5: Report failed bash commands as errors (fix 5)

In `src/main/pi/service.ts`, rewrite the `session.bash` handler so the emitted
`tool_execution_end` reflects the real outcome, and build the envelope once
instead of duplicating it:

```ts
		router.handle("session.bash", async (req) => {
			let isError = false;
			try {
				return await this.backend(req.sessionId).bash(req.command, {
					...(req.excludeFromContext === true ? { excludeFromContext: true } : {}),
					...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
				});
			} catch (error) {
				isError = true;
				throw error;
			} finally {
				// Complete the streaming bash block in the transcript.
				const event: PiEvent = {
					type: "tool_execution_end",
					toolCallId: req.requestId,
					toolName: "bash",
					isError,
				};
				this.bus.send({ type: "pi_event", sessionId: req.sessionId, event });
				for (const hooks of this.hooksList) {
					hooks.onSessionEvent?.(req.sessionId, event);
				}
			}
		});
```

`PiEvent` is already imported at the top of the file (`service.ts:13`). Rethrowing
from the `catch` preserves the existing behavior where the router converts the
throw into an `{ ok: false, error }` envelope.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "isError: false," src/main/pi/service.ts` → `0`
- `grep -c "toolName: \"bash\"," src/main/pi/service.ts` → `1` (was 2)

### Step 6: Point "Open review" at the review tab (fix 6)

Add an `onOpenReview(): void` prop to `Composer` (declare it in the props type
at `Composer.tsx:17-41` alongside `onOpenPalette`), use it for the git-strip
button's `onClick` at line 205, and pass it from `ChatPage.tsx` next to the
existing `onOpenPalette`:

```tsx
						onOpenReview={() => setDockTab("review")}
```

Do not reuse `onOpenPalette` for both — the `/` trigger in the textarea
(`Composer.tsx:219`) legitimately opens Commands and must keep doing so.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "onOpenReview" src/renderer/src/components/chat/Composer.tsx src/renderer/src/pages/ChatPage.tsx` →
  matches in both files

### Step 7: Full gate

**Verify**:
- `npm run typecheck` → exit 0
- `npm test` → exit 0, all pass including the new tests from the test plan
- `npm run e2e` → exit 0, 30 passed (the existing suite must not regress)

## Test plan

Two files to extend. Follow the existing structure in each — do not create new
test files.

**`tests/unit/ingest.test.ts`** (pattern: it builds a context with
`createContext()`, applies events with `applyEvent()`, and asserts on
`ctx.blocks` / `ctx.phase`). Add:

1. `"manual compaction from idle returns to idle"` — `createContext()`, apply
   `{type:"compaction_start", reason:"manual"}`, assert `ctx.phase === "compacting"`,
   apply `{type:"compaction_end", reason:"manual", aborted:false, willRetry:false}`,
   assert **`ctx.phase === "idle"`**. This is the regression test for fix 4 and
   fails on current `main`.
2. `"threshold compaction mid-run returns to streaming"` — apply
   `{type:"agent_start"}` first (phase becomes `"streaming"`), then
   `compaction_start`/`compaction_end` with `reason:"threshold"`, assert
   `ctx.phase === "streaming"`.

**`tests/unit/regressions.test.ts`** (pattern: each `it()` documents a specific
past bug, most operating on the Zustand store or pure helpers). Add:

3. `"failed bash emits tool_execution_end with isError true"` — construct a
   `PiService` with a stub backend whose `bash()` rejects, capture emitted
   events through a fake bus, invoke the handler, assert the emitted
   `tool_execution_end` has `isError: true`. Model the stub-backend setup on
   `tests/unit/rpc-backend.test.ts`, which already fakes a backend.
4. `"only one compact dialog is rendered"` — a source-level guard, cheap and
   sufficient: read `src/renderer/src/pages/ChatPage.tsx` with `node:fs` and
   assert `data-testid="compact-confirm"` occurs exactly once. (A DOM-level test
   would need the full Electron harness; this catches the actual regression.)

**Verification**: `npm test` → exit 0, `57 passed` (53 existing + 4 new).

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with 4 new tests passing
- [ ] `npm run e2e` exits 0, 30 passed
- [ ] `grep -c "compactOpen && (" src/renderer/src/pages/ChatPage.tsx` → `1`
- [ ] `grep -c 'data-testid="compact-confirm"' src/renderer/src/pages/ChatPage.tsx` → `1`
- [ ] `grep -c "as any" src/renderer/src/pages/ChatPage.tsx` → `0`
- [ ] `grep -c 'play("complete")' src/renderer/src/pages/ChatPage.tsx` → `0`
- [ ] `grep -c "isError: false," src/main/pi/service.ts` → `0`
- [ ] `grep -n "onOpenReview" src/renderer/src/pages/ChatPage.tsx` → at least one match
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 002 updated

## STOP conditions

Stop and report back (do not improvise) if:

- **Fix 2**: `grep -c "compactOpen && (" src/renderer/src/pages/ChatPage.tsx`
  does not return `2` before you start. If it already returns `1`, someone fixed
  it — skip step 2, note it, and continue.
- **Fix 4**: `tests/unit/ingest.test.ts` has existing assertions that depend on
  `compaction_end` producing `"streaming"` from idle. If an existing test breaks,
  read it before changing it — if it encodes the current behavior deliberately,
  stop and report rather than editing the assertion to match your change.
- **Fix 3**: you cannot make the store play a sound without importing renderer
  React code into `ingest.ts`. `ingest.ts` must stay pure — if the only path you
  can find violates that, stop and report.
- **Fix 5**: the `session.bash` handler no longer matches the excerpt above.
- Any step's verification fails twice after a reasonable fix attempt.
- `npm run e2e` fails on a test unrelated to your changes — that is a
  pre-existing problem, report it rather than fixing it here.

## Maintenance notes

- **For the reviewer**: the highest-risk change is fix 3, because it moves a
  side effect from a promise callback into the event stream. Check specifically
  that resuming an existing session does **not** play a completion sound —
  hydration replays history and must stay silent. The "phase was not already
  idle" guard is what prevents it.
- Fix 4 adds a field to `IngestContext`. Anything that constructs a context by
  hand rather than through `createContext()` will now be missing it; the strict
  compiler will catch that, but be aware when writing new tests.
- Fix 1 makes the sidebar issue a real query per search. If session counts grow
  large, the 200 ms debounce is the knob to tune, and `db.sessions.search`
  already caps at 100 results.
- **Deliberately deferred**: the duplicate-modal bug existed because there is no
  test coverage for the compact dialog at all. Test 4 in the plan is a
  source-level guard, not a behavioral one. A real e2e test that opens Compact
  and asserts a single visible dialog belongs in the broader test-coverage work
  (audit finding L-4), not here.
