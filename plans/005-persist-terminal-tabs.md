# Plan 005: Keep terminal tabs alive across switches instead of killing the shell

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> ```
> git diff --stat 02fbaf0..HEAD -- src/renderer/src/pages/ChatPage.tsx src/renderer/src/components/workspace/TerminalPanel.tsx src/main/pty-service.ts
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: 002 and 003 should land first — all three edit `ChatPage.tsx`,
  and 002 deletes ~31 lines from it. Not a logical dependency, purely to avoid
  conflicts.
- **Category**: bug
- **Planned at**: commit `02fbaf0`, 2026-08-22

## Why this matters

Pi Desktop presents a terminal **tab strip** with a "+" button, which promises
several independent shells. It does not deliver one. Only the active tab's
`TerminalPanel` is mounted, and unmounting kills its pty — so switching tabs
destroys the shell: scrollback, shell history, `cd` state, environment, and any
running process (a dev server, a long build, a watch task) are all lost.
Switching back silently starts a brand-new shell that looks like the old one
until you notice everything is gone.

For a coding-agent client, "I started a dev server in tab 1" is a completely
ordinary thing to do, and it currently cannot survive clicking tab 2.

There is a second, smaller defect in the same block: closing a tab clamps the
active index rather than adjusting it, so closing a tab positioned before the
active one leaves `activeTermTab` pointing past the end of the array.

After this plan, terminals persist for as long as their tab exists, and closing
a tab selects the right neighbour.

## Current state

### Only one panel is mounted — `ChatPage.tsx:368-374`

```tsx
										<div className="min-h-0 flex-1">
											<TerminalPanel
												key={terminalTabs[activeTermTab]?.id ?? "term-1"}
												cwd={active.cwd}
											/>
										</div>
```

`key` changes when the active tab changes, so React unmounts the old panel and
mounts a new one.

### Unmount kills the pty — `TerminalPanel.tsx:57-64`

```tsx
		return () => {
			observer.disconnect();
			unsubscribe();
			window.piDesktop.pty.kill(ptyId);
			term.dispose();
			termRef.current = null;
		};
	}, [cwd]);
```

The full component, for context:

```tsx
export function TerminalPanel({ cwd }: { cwd: string }): React.JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const ptyIdRef = useRef<string>(`pty-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

	useEffect(() => {
		const container = containerRef.current;
		if (container === null) return;
		const term = new Terminal({ fontSize: 11, /* … */ cursorBlink: true });
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		termRef.current = term;
		fitRef.current = fit;

		const ptyId = ptyIdRef.current;
		term.onData((data) => window.piDesktop.pty.write(ptyId, data));
		const unsubscribe = window.piDesktop.pty.onData(ptyId, (data) => term.write(data));

		function fitNow(): void {
			const el = containerRef.current;
			if (el !== null && el.clientWidth > 0 && el.clientHeight > 0) {
				fit.fit();
				window.piDesktop.pty.resize(ptyId, term.cols, term.rows);
			}
		}
		fitNow();
		window.piDesktop.pty.create({ id: ptyId, cwd, cols: term.cols, rows: term.rows });

		const observer = new ResizeObserver(() => fitNow());
		observer.observe(container);

		return () => { /* … kill … */ };
	}, [cwd]);

	return <div ref={containerRef} className="h-full w-full p-1" />;
}
```

Note the `clientWidth > 0 && clientHeight > 0` guard inside `fitNow()` — this
matters for the fix, because a hidden panel measures zero and must not be fitted
until it is shown again.

### The close-index bug — `ChatPage.tsx:336-348`

```tsx
														onClick={(e) => {
															e.stopPropagation();
															if (terminalTabs.length > 1) {
																setTerminalTabs((prev) => prev.filter((_, j) => j !== i));
																setActiveTermTab((prev) => Math.min(prev, terminalTabs.length - 2));
															}
														}}
														onKeyDown={(e) => {
															if (e.key === "Enter" && terminalTabs.length > 1) {
																setTerminalTabs((prev) => prev.filter((_, j) => j !== i));
															}
														}}
```

`Math.min(prev, length - 2)` clamps to the new last index but never accounts for
*which* index was removed. With three tabs and tab index 2 active, closing index
0 leaves `activeTermTab === 1` — which is now a *different* terminal than the
one the user was looking at. The `onKeyDown` path removes the tab without
touching `activeTermTab` at all.

### Tab state lives in ChatPage — `ChatPage.tsx:44-48`

```tsx
	const [terminalTabs, setTerminalTabs] = useState<Array<{ id: string; label: string }>>([
		{ id: "term-1", label: "Terminal 1" },
	]);
	const [activeTermTab, setActiveTermTab] = useState(0);
	const [nextTermNum, setNextTermNum] = useState(2);
```

Add handler — `ChatPage.tsx:355-364`:

```tsx
												onClick={() => {
													const num = nextTermNum;
													setTerminalTabs((prev) => [...prev, { id: `term-${num}-${Date.now()}`, label: `Terminal ${num}` }]);
													setActiveTermTab(terminalTabs.length);
													setNextTermNum(num + 1);
												}}
```

### The main-process side is fine — `src/main/pty-service.ts`

`PtyService` already caps concurrent terminals at 8:

```ts
const MAX_TERMINALS = 8;
```
```ts
			if (this.terms.size >= MAX_TERMINALS) {
				send(`\r\n[terminal limit reached (${String(MAX_TERMINALS)})]\r\n`);
				return;
			}
```

and it validates ids against `/^[A-Za-z0-9_-]{1,64}$/`, spawns
`process.env.SHELL || "/bin/zsh"` with `-l`, scopes cwd through the file bridge,
and cleans up on `onExit`. **No main-process change is required by this plan** —
keeping panels mounted is bounded by the existing cap.

### Repo conventions

- **Strict TypeScript**, `exactOptionalPropertyTypes` on.
- Tabs for indent, double-quoted strings.
- Tailwind 4 utilities; the codebase uses `hidden` for display-none elsewhere.
- Renderer components are function components with hooks; refs via `useRef`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | exit 0, 53 passed |
| E2E | `npm run e2e` | exit 0, 30 passed |
| Dev app | `npm run dev` | window opens |
| Native modules (if pty fails to spawn) | `./scripts/setup-native.sh` | exit 0 |

## Scope

**In scope**:

- `src/renderer/src/pages/ChatPage.tsx` — terminal tab strip and panel rendering only
- `src/renderer/src/components/workspace/TerminalPanel.tsx`
- `tests/unit/terminal-tabs.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):

- `src/main/pty-service.ts` — correct as-is, including `MAX_TERMINALS = 8`.
  Do **not** raise the cap; it is what makes keeping panels mounted safe.
- `src/preload/index.ts` — the `pty` bridge surface is complete.
- The four mispositioned `absolute` elements (plan 003) and the six one-liners
  (plan 002), even though several are in `ChatPage.tsx`.
- Shell selection (zsh/bash/fish picker) and per-tab cwd — both were listed as
  deferred in the Phase-4 notes and are separate features.
- Terminal session **persistence across app restarts**. Out of scope; the goal
  here is only surviving a tab switch.

## Git workflow

- Branch: `advisor/005-persist-terminal-tabs`
- Commits:
  - `fix: keep terminal panels mounted across tab switches`
  - `fix: select the correct terminal after closing a tab`
- Do NOT push or open a PR.

## Steps

### Step 1: Make TerminalPanel visibility-aware

Add an `active: boolean` prop. The component stays mounted at all times; the
prop only controls whether it is displayed and whether it refits.

Changes to `src/renderer/src/components/workspace/TerminalPanel.tsx`:

1. Signature:

```tsx
export function TerminalPanel({
	cwd,
	active,
}: {
	cwd: string;
	active: boolean;
}): React.JSX.Element {
```

2. Hide with CSS rather than unmounting. The container must keep its ref and its
   xterm instance:

```tsx
	return <div ref={containerRef} className={`h-full w-full p-1 ${active ? "" : "hidden"}`} />;
```

3. Refit when the panel becomes visible again. While hidden, `clientWidth` is 0
   and the existing guard inside `fitNow()` correctly skips fitting; when shown,
   the panel must re-fit to the current pane size. Add a second effect:

```tsx
	// Re-fit when this panel becomes visible: while hidden it measures 0x0, so
	// fitNow() correctly skipped it and xterm still holds stale dimensions.
	useEffect(() => {
		if (!active) return;
		const term = termRef.current;
		const fit = fitRef.current;
		const el = containerRef.current;
		if (term === null || fit === null || el === null) return;
		if (el.clientWidth === 0 || el.clientHeight === 0) return;
		fit.fit();
		window.piDesktop.pty.resize(ptyIdRef.current, term.cols, term.rows);
	}, [active]);
```

`termRef` and `fitRef` already exist and are already assigned in the main effect
— they are currently written but never read, which is why this is cheap.

> The existing `ResizeObserver` may also fire on the show transition. A double
> fit is harmless (idempotent), so do not try to suppress it.

**Verify**:
- `npm run typecheck` → **expect one error** in `ChatPage.tsx` (missing `active`
  prop). Step 2 resolves it.
- `grep -c "active" src/renderer/src/components/workspace/TerminalPanel.tsx` →
  at least `4`

### Step 2: Mount every terminal tab, show only the active one

In `src/renderer/src/pages/ChatPage.tsx`, replace the single keyed panel
(lines 368-374) with a mapped list:

```tsx
										<div className="min-h-0 flex-1">
											{terminalTabs.map((tab, i) => (
												<TerminalPanel
													key={tab.id}
													cwd={active.cwd}
													active={i === activeTermTab}
												/>
											))}
										</div>
```

Three things matter here:

- `key={tab.id}` — **not** the array index. A stable per-tab key is what keeps
  each panel mounted when its neighbours change.
- The key no longer depends on `activeTermTab`, so switching tabs no longer
  remounts anything.
- The wrapper needs `relative`-free simple stacking: since inactive panels are
  `hidden` (display: none), they take no space and no absolute positioning is
  required.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "terminalTabs.map" src/renderer/src/pages/ChatPage.tsx` → `2`
  (one for the tab strip, one for the panels)
- `grep -c 'key={terminalTabs\[activeTermTab\]' src/renderer/src/pages/ChatPage.tsx` → `0`

### Step 3: Fix the close-tab index arithmetic

Both close handlers must (a) remove the tab and (b) move the selection
correctly. Extract one function rather than duplicating the logic — the
`onKeyDown` path is currently wrong precisely because it was a partial copy.

Add near the other handlers in `ChatPage.tsx` (alongside `newSession` / `send`):

```tsx
	function closeTerminalTab(index: number): void {
		if (terminalTabs.length <= 1) return;
		setTerminalTabs((prev) => prev.filter((_, j) => j !== index));
		setActiveTermTab((prev) => {
			// Closing a tab before the active one shifts it left; closing the
			// active one selects its left neighbour. Clamp into the new range.
			const next = index < prev ? prev - 1 : prev;
			return Math.max(0, Math.min(next, terminalTabs.length - 2));
		});
	}
```

Then replace both handlers:

```tsx
														onClick={(e) => {
															e.stopPropagation();
															closeTerminalTab(i);
														}}
														onKeyDown={(e) => {
															if (e.key === "Enter") closeTerminalTab(i);
														}}
```

Note `terminalTabs.length - 2` is the last index **after** removal, and reading
`terminalTabs.length` from the closure is correct here because both state
updates are queued from the same render.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "Math.min(prev, terminalTabs.length - 2)" src/renderer/src/pages/ChatPage.tsx` → `0`
- `grep -c "closeTerminalTab" src/renderer/src/pages/ChatPage.tsx` → `3`
  (definition + two call sites)

### Step 4: Surface the terminal in the icon rail

Small, and in the same block — the rail was specified with five entries but
renders four, so Terminal is reachable only via a text button in the bottom row
and ⌘J. Worse, when the terminal *is* open the dock tab strip shows four tabs
with none highlighted, and clicking any of them silently leaves the terminal.

1. Add Terminal to the rail array (`ChatPage.tsx:250-256`):

```tsx
									{ tab: "terminal" as const, label: "▤", title: "Terminal" },
```

2. Add `"terminal"` to the dock tab strip array (`ChatPage.tsx:293`):

```tsx
									{(["files", "review", "commands", "tree", "terminal"] as const).map((t) => (
```

3. Remove the now-redundant "Terminal" button from the bottom control row
   (the one with `data-testid="toggle-terminal"`, around line 450) — **but
   first** check whether any e2e test uses that test id:

```bash
grep -rn "toggle-terminal" tests/
```

If a test references it, move the `data-testid="toggle-terminal"` attribute onto
the new rail button instead of deleting it, so the test keeps passing.

**Verify**:
- `npm run typecheck` → exit 0
- `npm run e2e` → exit 0, 30 passed
- `grep -c '"terminal"' src/renderer/src/pages/ChatPage.tsx` → at least `3`

### Step 5: Manual verification (this is the real test)

Automated tests cannot drive a pty through xterm. Verify by hand — item 2 is
the actual bug:

1. `npm run dev`, open a session, open the Terminal dock tab.
2. **Persistence.** In Terminal 1 run `cd /tmp && export MARKER=hello`. Press
   "+" for Terminal 2. Switch back to Terminal 1. Run `pwd` → must print
   `/tmp`; run `echo $MARKER` → must print `hello`. On current `main` both come
   back empty because the shell was killed and replaced.
3. **Long-running process.** In Terminal 1 run
   `while true; do date; sleep 1; done`. Switch to Terminal 2, wait ~5 seconds,
   switch back. The loop must still be printing. Ctrl-C to stop it.
4. **Resize on show.** With Terminal 2 active, drag the dock wider, then switch
   to Terminal 1. Its content must reflow to the new width, not stay clipped at
   the old one.
5. **Close arithmetic.** Open three terminals. Select Terminal 3. Close
   Terminal 1. The still-selected panel must be the one that was Terminal 3 —
   run `echo $MARKER`-style markers beforehand if needed to tell them apart.
6. **Close the active tab.** With three open, select Terminal 2 and close it.
   Selection must fall to its left neighbour and render a live shell.
7. **Cap.** Press "+" repeatedly past 8 terminals. The 9th must print
   `[terminal limit reached (8)]` in its pane rather than failing silently.
8. **Cleanup.** Quit the app. Confirm no orphaned login shells remain:
   `pgrep -fl "zsh -l"` should not list processes spawned by the app.

**Verify**: all eight behave as described.

## Test plan

The behavior here is pty lifecycle across React mount/unmount, which the unit
harness cannot exercise (no jsdom for these components, and `node-pty` needs the
Electron ABI). Add source-level guards, and rely on the manual protocol above
for behavior.

> **Put them in a NEW file, `tests/unit/terminal-tabs.test.ts`** — do not append
> to `tests/unit/regressions.test.ts`. Three earlier plans all appended to that
> one file and produced a three-way merge conflict whose hunks interleave; a
> naive resolution silently splices one `describe` into another and drops
> closing braces. One test file per plan avoids that entirely. Model the new
> file's structure on `tests/unit/fs-bridge.test.ts` (plain `describe`/`it`,
> `node:fs` reads, no Electron imports), and resolve paths from
> `import.meta.dirname` as `tests/unit/assets.test.ts` does.

1. `"terminal panels are keyed per tab, not by active tab"` — read
   `ChatPage.tsx`, assert `key={terminalTabs[activeTermTab]` is **absent** and
   `terminalTabs.map` appears at least twice.
2. `"TerminalPanel takes an active prop instead of being unmounted"` — read
   `TerminalPanel.tsx`, assert it contains `active: boolean`.
3. `"closing a terminal tab adjusts the active index"` — assert `ChatPage.tsx`
   contains `closeTerminalTab` and does **not** contain
   `Math.min(prev, terminalTabs.length - 2)`.
4. `"terminal is reachable from the icon rail"` — assert `ChatPage.tsx` contains
   `title: "Terminal"`.

Additionally, extract the index arithmetic so it *can* be unit-tested properly.
Move the selection math into a pure exported helper in `ChatPage.tsx`:

```tsx
/** New active index after closing `closed`, given the pre-close tab count. */
export function nextActiveTerminalTab(active: number, closed: number, count: number): number {
	const next = closed < active ? active - 1 : active;
	return Math.max(0, Math.min(next, count - 2));
}
```

and have `closeTerminalTab` call it. Then test it directly with the cases that
are currently wrong:

- `nextActiveTerminalTab(2, 0, 3)` → `1`
- `nextActiveTerminalTab(0, 2, 3)` → `0`
- `nextActiveTerminalTab(1, 1, 3)` → `1`
- `nextActiveTerminalTab(2, 2, 3)` → `1`
- `nextActiveTerminalTab(0, 0, 2)` → `0`

**Verification**: `npm test` → exit 0, `62 passed` (53 existing + 4 source
guards + 5 helper cases, depending on how you group them).

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with the new tests passing
- [ ] `npm run e2e` exits 0, 30 passed
- [ ] `grep -c 'key={terminalTabs\[activeTermTab\]' src/renderer/src/pages/ChatPage.tsx` → `0`
- [ ] `grep -c "Math.min(prev, terminalTabs.length - 2)" src/renderer/src/pages/ChatPage.tsx` → `0`
- [ ] `src/main/pty-service.ts` is **unmodified** (`git status`)
- [ ] Manual protocol step 5 passes, especially items 2, 3 and 5
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 005 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Terminals fail to spawn at all, with `posix_spawnp` errors in the log. That is
  the known `node-pty` ABI mismatch documented in the Phase-3 notes — run
  `./scripts/setup-native.sh` once. If it persists, stop: it is an environment
  problem, not this plan's.
- A hidden panel renders at the wrong size when shown and the step-1 refit
  effect does not fix it. Report the observed behavior; do **not** switch the
  hiding strategy to absolute positioning or opacity without saying so — those
  interact differently with xterm's measurement.
- Keeping panels mounted causes the 8-terminal cap to be hit in normal use.
  That would mean ptys are leaking rather than being reused — **do not raise
  `MAX_TERMINALS`**, report it.
- Any orphaned shell processes survive app quit (manual step 8). That means
  `disposeAll()` is not reaching the extra panels.
- `grep -rn "toggle-terminal" tests/` shows e2e dependencies you cannot satisfy
  in step 4. Skip step 4, complete the rest, and report — steps 1–3 are the
  substance of this plan.

## Maintenance notes

- **For the reviewer**: the key change is `key={tab.id}` in step 2. If anyone
  later "simplifies" that back to an index or to the active-tab id, the bug
  returns in full and no automated test will catch it beyond the source guard.
  Worth a comment in the code, which step 2 does not currently require — adding
  one is welcome.
- Panels now stay mounted, so **N terminals means N live shells**. That is the
  intended behavior, and `MAX_TERMINALS = 8` is the safety valve. Any future
  change that raises the cap should first confirm memory and process load with
  8+ real shells running.
- Terminal tab state (`terminalTabs`, `activeTermTab`, `nextTermNum`) lives in
  `ChatPage` and is therefore **per-window and shared across sessions** — the
  same terminals show for whichever session is active, and `cwd` is taken from
  the active session. That is pre-existing behavior this plan does not change,
  but it is odd, and per-session terminals would be the natural follow-up.
- **Deliberately deferred**: shell selection, per-tab cwd, restoring terminals
  after an app restart, and renaming tabs. All were listed as follow-ups in the
  Phase-4 notes and none are required for tabs to stop destroying their shells.
