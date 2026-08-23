# Plan 009: Propagate the real cwd through session switch (and keep fork/clone/navigate honest)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> ```
> git diff --stat 21dc8aa..HEAD -- src/main/pi/service.ts src/main/pi/sdk-backend.ts src/main/pi/rpc-backend.ts src/renderer/src/stores/pi-sessions.ts tests/unit/session-cwd.test.ts
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 — the newest shipped feature (⌘K palette switch) half-works
- **Effort**: M
- **Risk**: MED — touches the session-replacement path shared by fork/clone/switch
- **Depends on**: none
- **Category**: bug (audit 4 finding H-2)
- **Planned at**: commit `21dc8aa`, 2026-08-23

## Why this matters

"Switch session file…" in the ⌘K palette swaps another session into the open
tab. The transcript re-hydrates correctly — but every cwd-scoped system keeps
pointing at the *previous* project: `PiService`'s registry entry, the
`session_replaced` event's `cwd`, the fs-bridge roots, the FileExplorer root,
the git strip, and new-terminal cwds. After a switch across projects, browsing
shows the wrong folder, `fs.read` rejects the new project's files, terminals
open in the old directory, and `desktop_open_path` refuses paths that belong to
the now-active session.

The same stale-cwd reporting also affects navigate/fork/clone within a session
(those don't change cwd, so they're cosmetically fine), but the fix below makes
all of them read from one source of truth instead of a boot-time snapshot.

## Current state

### Upstream behavior (ground truth)

Upstream's `AgentSessionRuntime.switchSession(sessionPath)` rebuilds the whole
runtime at the target session's cwd (`agent-session-runtime.ts:196-221`: opens
the SessionManager, reads its header cwd via `sessionManager.getCwd()`, calls
`createRuntime({ cwd: … })`). So after a switch, `backend.getState()` is
correct and `session.sessionFile` points at the new file. The desktop layer
simply never refreshes its snapshot.

### PiService records cwd once, reports it forever

`src/main/pi/service.ts`:

```ts
// line 332 — set once at open time
this.sessions.set(id, { id, cwd: opts.cwd, backend });

// lines 238-251 — re-fired after clone/switch
private async notifySessionOpened(appSessionId: string): Promise<void> {
	const entry = this.sessions.get(appSessionId);
	if (entry === undefined) return;
	const state = await entry.backend.getState().catch(() => undefined);
	for (const hooks of this.hooksList) {
		hooks.onSessionOpened?.({
			appSessionId,
			piSessionId: state?.sessionId,
			sessionFile: state?.sessionFile ?? entry.backend.getSessionFile(),
			cwd: entry.cwd,          // ← stale snapshot
			backend: entry.backend.kind,
		});
	}
}
```

### The backend echoes options.cwd, not reality

`src/main/pi/sdk-backend.ts`:

```ts
// lines 370-375
async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
	if (this.runtime === null) throw new Error("runtime not available");
	const result = await this.runtime.switchSession(sessionPath);
	await this.notifyReplaced();
	return { cancelled: result.cancelled };
}

// lines 381-389
private async notifyReplaced(): Promise<void> {
	const session = this.requireSession();
	this.options.onEvent({
		type: "session_replaced",
		sessionId: session.sessionId,
		...(session.sessionFile !== undefined ? { sessionFile: session.sessionFile } : {}),
		cwd: this.options.cwd,   // ← boot-time value
	});
}
```

(`getCwd()` at sdk-backend.ts:161-163 returns `this.options.cwd` too.)

### The renderer trusts the event

`src/renderer/src/stores/pi-sessions.ts:240` applies
`...(event.cwd !== undefined ? { cwd: event.cwd } : {})` during
`session_replaced` handling. The event carries the stale cwd, so the UI
"updates" to the same wrong value.

### Existing machinery you must reuse

`src/main/pi/service.ts` already contains, with unit coverage in
`tests/unit/session-cwd.test.ts`:

```ts
export function resolveResumeCwd(
	sessionPath: string,
	suppliedCwd: string | undefined,
	readHeaderCwd: (path: string) => string | undefined = readSessionHeaderCwd
): string { … }
```

and `readSessionHeaderCwd(sessionPath)` does a bounded 64 KB first-line read.
Upstream's `SessionHeader` (`session-manager.ts:32-40`) guarantees `cwd` on
v1+ sessions.

## Repo conventions to match

- Tabs, double quotes, strict TS, conditional spreads for optional props.
- `deriveCwdFromSessionPath` is documented LAST RESORT / lossy — do not add new
  call sites for it.
- One test file per concern; extend `tests/unit/session-cwd.test.ts` rather
  than creating a near-duplicate file (its subject *is* cwd resolution).
- Conventional commits; do not push or open PRs.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | exit 0, 94 passed before your changes |
| Single file | `npx vitest --run tests/unit/session-cwd.test.ts` | exit 0 |
| E2E | `npm run e2e` | exit 0, 30 passed |

## Scope

**In scope**:

- `src/main/pi/service.ts`
- `src/main/pi/sdk-backend.ts`
- `src/main/pi/rpc-backend.ts`
- `src/main/pi/backend.ts` (only if you widen an interface signature)
- `tests/unit/session-cwd.test.ts` (extend)
- `tests/unit/rpc-backend.test.ts` (extend, if the fake supports switch)

**Out of scope** (do NOT touch):

- `AgentSessionRuntime` usage beyond reading post-switch state — no upstream
  API changes, no forking pi.
- The palette UI (`CommandPalette.tsx`) — it already calls the channel
  correctly; this is a main-process data bug.
- Resume-path cwd resolution — `resolveResumeCwd` is correct as-is.
- Multi-root workspace support (`workspace.roots` allowlist semantics).

## Git workflow

- Branch: `fix/009-switch-session-cwd`
- Suggested commits:
  - `fix: track live cwd per session instead of a boot-time snapshot`
  - `fix: report fresh cwd in session_replaced events`
- Do NOT push or open a PR.

## Steps

### Step 1: Make the SDK backend report the switched-to cwd

In `src/main/pi/sdk-backend.ts`, derive cwd from the live session instead of
`options.cwd`. Upstream sessions know their cwd through their SessionManager;
if `session` exposes it directly use that. Otherwise resolve from the session
file's directory encoding — but prefer the robust path: after any replacement,
read the cwd from the new session's header using `readSessionHeaderCwd`
(import it from `./service`; move it to a shared module if importing creates a
cycle — see STOP conditions).

Concretely:

```ts
import { readSessionHeaderCwd } from "./service"; // or extract to ./cwd.ts

/** Best-effort live cwd: session manager value → session header → options fallback. */
private currentCwd(): string {
	const session = this.session;
	if (session !== null) {
		const headerCwd =
			session.sessionFile !== undefined ? readSessionHeaderCwd(session.sessionFile) : undefined;
		if (headerCwd !== undefined && headerCwd.length > 0) return headerCwd;
	}
	return this.options.cwd;
}
```

Then:

- `getCwd(): string` → `return this.currentCwd();`
- `notifyReplaced()` → `cwd: this.currentCwd(),`

Header-read cost is a bounded 64 KB synchronous read per replacement event —
negligible at fork/switch frequency. If profiling ever says otherwise, cache
per `sessionId` and invalidate on replacement.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "cwd: this.options.cwd" src/main/pi/sdk-backend.ts` → `0` matches

### Step 2: Update PiService's registry entry after switch

In `src/main/pi/service.ts`, the `session.switch` handler knows the target
path; use it:

```ts
router.handle("session.switch", async (req) => {
	const result = await this.backend(req.sessionId).switchSession(req.sessionPath);
	// The runtime rebuilt itself at the new session's cwd — refresh the
	// registry entry so scoping (roots, dock cwd) follows the switch.
	const entry = this.sessions.get(req.sessionId);
	if (entry !== undefined) {
		entry.cwd = resolveResumeCwd(req.sessionPath, undefined);
	}
	await this.notifySessionOpened(req.sessionId);
	return result;
});
```

`resolveResumeCwd(path, undefined)` = supplied(∅) → header → last-resort decode,
which is exactly the right precedence here. Mutating `entry` in place is fine —
`SessionEntry` fields are not frozen and the map value is internal.

Also apply the same two-line refresh inside `notifySessionOpened` as belt-and-
braces? No — do it only in the handler. `notifySessionOpened` is shared with
`clone`, where the cwd genuinely doesn't change, and double-resolution there
adds a second file read for nothing. Keep the fix at the call site that has
the information.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "entry.cwd = resolveResumeCwd" src/main/pi/service.ts` → 1 match

### Step 3: Keep the RPC backend honest

`src/main/pi/rpc-backend.ts` has the same `notifyReplaced` shape
(lines ~334-346) but cannot read headers reliably (its session file may be
remote-relative). It currently sets `cwdInfo` from `getState().sessionFile`.
Leave the sessionFile logic, but stop implying cwd knowledge: the RPC variant
of `session_replaced` should omit `cwd` entirely rather than send a stale one
(the renderer treats absent cwd as "no change", which is correct for RPC until
a follow-up adds a real source).

Change:

```ts
	private async notifyReplaced(): Promise<void> {
		let sessionFile: string | undefined;
		try {
			const state = (await this.getState()) as PiSessionState;
			sessionFile = state.sessionFile;
		} catch {
			sessionFile = undefined;
		}
		this.options.onEvent({
			type: "session_replaced",
			...(sessionFile !== undefined ? { sessionFile } : {}),
		});
	}
```

(The variable previously named `cwdInfo` held a session file path — rename it;
that misnaming is how the staleness hid.)

Note for the maintainer recorded here, not acted on: RPC-mode switches leave
PiService's `entry.cwd` stale because Step 2's header read works on local
paths only. That is acceptable — `resolveResumeCwd` falls back lossily — and
RPC sessions are explicitly second-class today. Documented; do not build more.

**Verify**:
- `npm run typecheck` → exit 0

### Step 4: Full gate + manual check

**Verify**:
- `npm test` → exit 0, all pass including new tests below
- `npm run e2e` → exit 0, 30 passed

Manual matrix (dev run):
1. Open session A in project A. Note FileExplorer root + git strip.
2. ⌘K → "Switch session file…" → pick a session from project B.
3. Transcript shows B's history **and**: explorer root is B, git strip shows
   B's branch, opening a terminal lands in B, `fs.read` succeeds on a B file.

Before the fix, steps 3's items all still showed A.

## Test plan

Extend `tests/unit/session-cwd.test.ts` (it already unit-tests
`resolveResumeCwd` / `readSessionHeaderCwd` with temp files). Add cases for the
new wiring at the pure-function level:

1. `"switch handler refreshes the registry cwd from the session header"` —
   construct a `PiService` with a stub backend whose `switchSession` resolves
   `{cancelled:false}` and whose `getState` returns the new `sessionFile`;
   point the header reader at a fixture file whose first line is a valid
   session header carrying `cwd:"/tmp/projB"` (follow the existing temp-file
   pattern in this test file); invoke the registered `session.switch` handler
   through the router; assert a subsequent `getSessionCwd(appSessionId)`
   returns `/tmp/projB`. If `PiService`'s handlers are not reachable without
   heavy stubbing, test the extracted helper instead (see STOP conditions).

2. `"sdk notifyReplaced reports header cwd, not options cwd"` — instantiate
   `SdkPiBackend` is heavy; prefer extracting `currentCwd`'s logic into an
   exported pure helper `liveCwd(sessionFile: string | undefined, optionsCwd:
   string): string` and unit-test that directly (undefined file → options;
   file with header → header value; file without header → options).

If the injection seams make either test impractical without refactoring beyond
this plan, implement the helper extraction in step 2's description (it is
in-scope — small, mechanical) and cover that.

**Verification**: `npm test` → exit 0, ≥96 passed.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with new tests passing
- [ ] `npm run e2e` exits 0, 30 passed
- [ ] `grep -c "cwd: this.options.cwd" src/main/pi/sdk-backend.ts` → `0`
- [ ] Manual switch matrix (Step 4) all green
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 009 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Importing `readSessionHeaderCwd` from `service.ts` into `sdk-backend.ts`
  creates an import cycle (extract both helpers to a new
  `src/main/pi/cwd.ts` first — that refactor is pre-approved; anything bigger
  is not).
- Upstream `AgentSession` exposes a direct cwd accessor in the pinned version —
  use it instead of header reads and note it in the PR body (check
  `node_modules/@earendil-works/pi-coding-agent/dist` typings before assuming).
- An existing test encodes `session_replaced` carrying `options.cwd` for RPC
  mode deliberately; read before editing assertions.
- The e2e suite fails on `pi-integration.e2e.ts` in a way that involves session
  replacement ordering — that may be your change surfacing a real race; capture
  the failure output and stop.

## Maintenance notes

- The renderer's `session_replaced` handling stays untouched: it already does
  the right thing when `cwd` is present-or-absent.
- `entry.cwd` mutation means `SessionEntry` is now mutable state; if a future
  plan makes sessions immutable snapshots, carry the refresh along.
- When RemotePiBackend becomes real, its `notifyReplaced` must source cwd from
  the server snapshot (`SessionSnapshot.cwd`) — this plan's RPC omission is the
  placeholder.
