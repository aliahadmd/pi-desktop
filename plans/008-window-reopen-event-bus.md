# Plan 008: Re-bind the renderer event bus when the window is recreated

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> ```
> git diff --stat 21dc8aa..HEAD -- src/main/index.ts src/main/ipc/events.ts src/main/windows/main.ts
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 — breaks the primary macOS window lifecycle
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (audit 4 finding H-1)
- **Planned at**: commit `21dc8aa`, 2026-08-23

## Why this matters

Closing the Pi Desktop window and reopening it from the Dock or tray yields a
zombie UI: the new window renders whatever it can fetch synchronously, but
**every main→renderer event is silently dropped forever**. Streaming deltas,
`ui_dialog`s (including the approval-gate confirm), `backend_died`, sidecar
status, and auth prompts all vanish. Any agent run still in flight keeps
burning tokens invisibly.

The root cause is a two-line asymmetry in `src/main/index.ts`: the boot path
registers its window with the bus, and the `activate` path does not.

## Current state

### The bus drops events with no window

`src/main/ipc/events.ts` (entire class):

```ts
export class RendererEventBus {
	private window: BrowserWindow | null = null;

	setWindow(window: BrowserWindow | null): void {
		this.window = window;
	}

	send(event: IpcEvent): void {
		const target = this.window;
		if (target === null || target.isDestroyed()) return;
		target.webContents.send(IPC_EVENT_CHANNEL, event);
	}
}
```

The `target === null` guard is silent by design — producers must never need to
know whether a window exists. That makes the *registration* responsibility of
whoever creates windows.

### Boot registers; activate doesn't

`src/main/index.ts`, boot path (~lines 275-291):

```ts
		const window = createMainWindow({
			preloadPath: path.join(__dirname, "../preload/index.js"),
			rendererUrl: process.env.ELECTRON_RENDERER_URL,
			...(clampedBounds !== undefined ? { bounds: clampedBounds } : {}),
			onClosed: () => {
				bus.setWindow(null);
			},
		});
		bus.setWindow(window);
		window.on("close", () => {
			storeService?.setWindowState(window.getBounds());
		});
```

`src/main/index.ts`, activate path (~lines 329-337):

```ts
app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) {
		createMainWindow({
			preloadPath: path.join(__dirname, "../preload/index.js"),
			rendererUrl: process.env.ELECTRON_RENDERER_URL,
			onClosed: () => {},
		});
	}
});
```

The activate-created window never reaches `bus.setWindow`. Its `onClosed` is a
no-op, which also means closing *that* window leaves a destroyed-window
reference where a live one is expected (harmless only because `isDestroyed()`
is checked — but bounds persistence is lost too).

Also affected, same root cause: `second-instance` (~line 68) focuses
`getAllWindows()[0]`:

```ts
app.on("second-instance", () => {
	const [first] = BrowserWindow.getAllWindows();
	first?.focus();
});
```

In exactly the state that produces a second launch (no window), `first` is
`undefined` and the handler no-ops instead of recreating the window.

## Repo conventions to match

- Tabs for indent, double quotes.
- Optional properties spread conditionally (`exactOptionalPropertyTypes`).
- Main-process services stay electron-thin; wiring belongs in `index.ts`.
- Conventional commits; do not push or open PRs.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | exit 0, 94 passed before your changes |

(E2E cannot exercise Dock-icon reactivation; manual verification below covers
it.)

## Scope

**In scope**:

- `src/main/index.ts`
- `src/main/windows/main.ts` (only if you choose to move wiring into a factory
  per the fix sketch — both shapes are acceptable, pick one)

**Out of scope** (do NOT touch):

- `RendererEventBus` itself — its semantics are correct; registration is the bug.
- Tray logic, updater, PTY service.
- Multi-window support (a separate roadmap item).

## Git workflow

- Branch: `fix/008-window-event-bus`
- One commit, conventional-commit style:
  - `fix: register recreated windows with the renderer event bus`
- Do NOT push or open a PR.

## Steps

### Step 1: Extract a single window-spawning path

Refactor so boot and `activate` share one code path that (a) creates the
window, (b) calls `bus.setWindow(win)`, (c) persists bounds on close, and
(d) nulls the bus window on close. Recommended shape inside `whenReady`'s
scope (it needs `bus`, `storeService`, and the saved-bounds closure):

```ts
	function spawnMainWindow(): Electron.BrowserWindow {
		const savedBounds = storeService.getWindowState<Electron.Rectangle | undefined>(undefined);
		const clamped = savedBounds !== undefined ? clampBoundsToScreen(savedBounds) : undefined;
		const win = createMainWindow({
			preloadPath: path.join(__dirname, "../preload/index.js"),
			rendererUrl: process.env.ELECTRON_RENDERER_URL,
			...(clamped !== undefined ? { bounds: clamped } : {}),
			onClosed: () => bus.setWindow(null),
		});
		bus.setWindow(win);
		win.on("close", () => storeService?.setWindowState(win.getBounds()));
		return win;
	}

	let mainWindow: Electron.BrowserWindow | undefined;
	mainWindow = spawnMainWindow();
```

Then:

```ts
app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) {
		mainWindow = spawnMainWindow();
	}
});

app.on("second-instance", () => {
	const [first] = BrowserWindow.getAllWindows();
	if (first !== undefined) {
		first.focus();
	} else if (app.isReady()) {
		mainWindow = spawnMainWindow();
	}
});
```

If `spawnMainWindow` cannot close over what it needs at module scope (the bus
and store are created inside `whenReady`), declare it inside the `.then()` and
have the `activate`/`second-instance` handlers call a module-level
`let spawnMainWindowRef: (() => void) | undefined` assigned there. Do not move
service construction to module top level — boot ordering matters
(single-instance lock → hardenSession → services → window).

Note on `onClosed` vs `close`: keep the existing split exactly as boot has it —
bounds persist in `close` (which can be prevented), bus unregistration happens
in `closed` (which cannot). Do not merge them.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "bus.setWindow" src/main/index.ts` → exactly **2** matches
  (register + null)

### Step 2: Manual verification matrix

Run `npm run dev` and walk this table. Every cell that says "works" must work:

| Scenario | Before fix | After fix |
|---|---|---|
| Send prompt, stream visible | works | works |
| Close window (⌘W), reopen from Dock icon, send prompt, transcript streams | **dead** | works |
| Same reopen, then trigger an extension dialog / approval confirm | **never appears** | appears |
| Same reopen, kill a session's backend, banner shows | **no banner** | banner shows |
| Quit via ⌘Q while a window exists | quits cleanly | quits cleanly |
| Close window, quit via tray → Quit | quits cleanly | quits cleanly |

For the streaming check after reopen, any active session qualifies — resume one
from the sidebar if none is running.

**Verify**: all six rows behave as the "After fix" column describes. Capture
nothing; report the matrix result.

### Step 3: Full gate

**Verify**:
- `npm run typecheck` → exit 0
- `npm test` → exit 0, all pass

## Test plan

A behavioral unit test of BrowserWindow lifecycle requires the Electron
runtime, which unit tests deliberately avoid. Add a cheap source-level guard
instead, consistent with how plan 002 guarded the duplicate dialog:

**New file `tests/unit/window-wiring.test.ts`** (follow the style of other
unit files; vitest `describe/it/expect`, `node:fs` reads):

1. `"boot and activate share one window-registration path"` — read
   `src/main/index.ts` and assert:
   - `bus.setWindow(` occurs exactly twice (one register, one null);
   - the string `setWindow(win)` / `setWindow(mainWindow)` (whatever the single
     registration site is named) occurs inside a function whose body contains
     `createMainWindow` — i.e. registration lives next to creation, not in a
     second hand-rolled copy;
   - `onClosed` handler body references `setWindow(null)` exactly once.

2. `"second-instance recovers when no window exists"` — read the file, assert
   the `second-instance` handler contains a call into the shared spawner
   (matches `/spawnMainWindow\(\)/` or your chosen name) and does not merely
   call `first?.focus()` unguarded.

This is intentionally brittle to refactors of the file layout — that is the
point: it pins the invariant "creation and registration happen together."

**Verification**: `npm test` → exit 0, 96 passed (94 + 2).

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with the 2 new tests passing
- [ ] `grep -c "bus.setWindow" src/main/index.ts` → `2`
- [ ] Manual verification matrix completed, all six cells green
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 008 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `createMainWindow`'s signature no longer matches the excerpt (options object
  with `preloadPath` / `rendererUrl` / optional `bounds` / `onClosed`).
- You find additional window-creation sites beyond boot + `activate` (e.g. a
  notification click creating windows) — list them and stop; they all need the
  same treatment but that is a scope decision for the maintainer.
- Bounds restoration behaves differently after your refactor (window appears
  off-screen or at default size when it previously restored).
- Any step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The `isDestroyed()` guard in `events.ts` means a stale registration is
  harmless-but-dead; the failure mode of this bug was specifically the `null`
  set by the first window's `onClosed`. If someone later adds a second real
  window, this whole single-target bus design needs revisiting — see the
  multi-window roadmap item before extending.
- `second-instance` gaining a spawn path changes behavior on Windows/Linux
  too (single-instance lock focus). Those platforms are post-v1, but the
  behavior there is now "reopen a window," which is correct-by-accident — note
  it when platform builds start.
