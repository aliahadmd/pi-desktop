# Plan 012: Four independent small fixes (editor fallback, onboarding loop, log retention, sidecar timer leak)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> ```
> git diff --stat 21dc8aa..HEAD -- src/main/index.ts src/renderer/src/App.tsx src/main/services/paths.ts src/main/sidecar/manager.ts tests/unit/sidecar-manager.test.ts
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S (each fix independently; S overall)
- **Risk**: LOW
- **Depends on**: none (008 touches `index.ts` too — if both run concurrently,
  land 008 first and rebase; the touched regions do not overlap)
- **Category**: bug batch (audit 4 findings M-1, M-4, M-6, M-7)
- **Planned at**: commit `21dc8aa`, 2026-08-23

## Why this matters

Four unrelated defects, each a few lines, each with a real user cost: "Open in
editor" silently does nothing for packaged launches, onboarding reappears on
every launch after "Skip for now", rotated logs accumulate forever, and each
sidecar restart leaks a polling interval. Grouped into one plan because they
are small, independent, and mostly in different files. **Each step is
independently verifiable and independently revertable** — if one turns out
harder than described, complete the rest and report the skipped one.

## Current state

### Fix 1 — M-1: spawn error bypasses the openPath fallback

`src/main/index.ts:150-171`:

```ts
		router.handle("workspace.open_in_editor", async (req) => {
			const scoped = await bridge.assertRealScoped(req.path);
			const line = req.line;
			try {
				const { spawn } = await import("node:child_process");
				const child = spawn("code", ["--goto", `${scoped}${line !== undefined ? `:${line}` : ""}`], {
					stdio: "ignore",
				});
				await new Promise<void>((resolve) => {
					child.on("error", () => resolve());      // ← resolves without fallback
					child.on("exit", (code) => {
						if (code !== 0) void shell.openPath(scoped);
						resolve();
					});
					setTimeout(() => resolve(), 3000);
				});
			} catch {
				await shell.openPath(scoped);
			}
			return null;
		});
```

Packaged macOS apps inherit a minimal PATH from launchd; `code` is usually
absent there. The spawn emits `error` (ENOENT), the handler resolves, and
neither VS Code nor the default app opens — a silent no-op.

### Fix 2 — M-4: onboarding has no dismissal memory

`src/renderer/src/App.tsx:59-68`:

```ts
	useEffect(() => {
		void window.piDesktop.invoke({ type: "auth.providers" }).then((r) => {
			setOnboardingChecked(true);
			if (!r.ok) return;
			const anyConfigured = (
				r.data as { providers: Array<{ configured: boolean }> }
			).providers.some((p) => p.configured);
			if (!anyConfigured) setShowOnboarding(true);
		});
	}, []);
```

and `Onboarding.tsx:112-119`:

```tsx
					<button type="button" onClick={onDone} …>
						Skip for now
					</button>
```

`onDone` only clears local state. Nothing persists the dismissal, so every
launch re-shows the modal until a provider is configured.

### Fix 3 — M-6: rotated logs escape pruning

`src/main/services/logging.ts:80-87` rotates by renaming:

```ts
	private rotateIfNeeded(filePath: string): void {
		try {
			if (statSync(filePath).size < MAX_LOG_BYTES) return;
			renameSync(filePath, `${filePath}.${Date.now()}.rotated`);
		} catch { … }
	}
```

while `src/main/services/paths.ts:36-47` prunes only `.log` suffixes:

```ts
		for (const name of readdirSync(logsDir)) {
			if (!name.endsWith(".log")) continue;
```

Every `pidesktop-YYYYMMDD.log.<ts>.rotated` file is immortal. Renderer console
output forwards through `log_write`, so volume can be substantial.

### Fix 4 — M-7: sidecar restarts stack health-poll intervals

`src/main/sidecar/manager.ts`:

```ts
	// exit handler (~110-115) → scheduleRestart → start()
	private startHealthPolling(): void {
		this.setStatus("starting");
		…
		this.healthTimer = setInterval(() => void poll(), 2_000);
		this.healthTimer.unref?.();
	}
```

Only `stop()` clears `healthTimer`. Each restart cycle creates a fresh interval
without clearing the previous one; dead-generation timers poll a dead port
forever (bounded at MAX_RESTARTS=3, but still a leak with a one-line fix).

## Repo conventions to match

- Tabs, double quotes, strict TS, conditional spreads.
- Settings access via `app.settings.get/set` channels or StoreService raw
  helpers (`getSettingRaw`) in main.
- Unit tests: vitest; `tests/unit/sidecar-manager.test.ts` already fakes child
  processes for this manager — extend it, don't duplicate.
- Conventional commits; do not push or open PRs.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | exit 0, 94 passed before your changes |
| Single file | `npx vitest --run tests/unit/sidecar-manager.test.ts` | exit 0 |

## Scope

**In scope**:

- `src/main/index.ts` (fix 1 only — the `workspace.open_in_editor` handler)
- `src/renderer/src/App.tsx` + `src/renderer/src/pages/Onboarding.tsx` (fix 2)
- `src/main/services/paths.ts` (fix 3)
- `src/main/sidecar/manager.ts` (fix 4)
- `tests/unit/sidecar-manager.test.ts` (extend)

**Out of scope** (do NOT touch):

- Anything else in `index.ts` — window/bus wiring is plan 008.
- `logging.ts` rotation logic itself — only pruning must learn the new names.
- Onboarding's provider flow / OAuth handling.
- `MAX_RESTARTS` policy or backoff timing.

## Git workflow

- Branch: `fix/012-small-fixes-batch`
- One commit per fix:
  - `fix: fall back to default app when code CLI cannot spawn`
  - `fix: remember onboarding dismissal across launches`
  - `fix: prune rotated log files past retention`
  - `fix: clear stale health-poll interval before respawning sidecar`
- Do NOT push or open a PR.

## Steps

### Step 1: Editor fallback survives spawn errors (fix 1)

Rewrite the promise so all three exits route through one decision:

```ts
				let spawned = false;
				await new Promise<void>((resolve) => {
					const child = spawn("code", ["--goto", `${scoped}${line !== undefined ? `:${line}` : ""}`], {
						stdio: "ignore",
					});
					child.on("error", () => resolve());
					child.on("spawn", () => {
						spawned = true;
					});
					child.on("exit", (code) => {
						if (code !== 0) spawned = false;
						resolve();
					});
					setTimeout(() => resolve(), 3000);
				}).finally(() => {
					if (!spawned) return shell.openPath(scoped);
				});
```

Simpler equivalent acceptable — the invariant to preserve is: **default-app
open happens unless `code` demonstrably launched successfully**. Note `exit`
with code 0 after successful launch must NOT double-open. Keep the outer
try/catch as-is.

Move the `spawn` call inside the Promise executor only if you keep behavior
identical otherwise; either shape passes review if the invariant holds and
typecheck is clean.

**Verify**:
- `npm run typecheck` → exit 0
- Manual: temporarily rename `code` off PATH (`PATH=/usr/bin:/bin npm run dev`
  from a shell without the CLI), trigger "Open in editor" on a file row → the
  file opens in the OS default app. Restore PATH afterwards.

### Step 2: Remember onboarding dismissal (fix 2)

1. In `App.tsx`'s boot effect, gate on the persisted flag:

```ts
	useEffect(() => {
		void (async () => {
			const dismissed = await window.piDesktop.invoke({
				type: "app.settings.get",
				key: "onboardingDismissed",
			});
			void window.piDesktop.invoke({ type: "auth.providers" }).then((r) => {
				setOnboardingChecked(true);
				if (!r.ok) return;
				const anyConfigured = (
					r.data as { providers: Array<{ configured: boolean }> }
				).providers.some((p) => p.configured);
				if (!anyConfigured && dismissed.data !== true) setShowOnboarding(true);
			});
		})();
	}, []);
```

2. Add an explicit dismiss path: change `Onboarding`'s props to include
   `onSkip(): void` alongside `onDone()`; wire "Skip for now" to it; in App:

```ts
			onDone={() => setShowOnboarding(false)}
			onSkip={() => {
				setShowOnboarding(false);
				void window.piDesktop.invoke({
					type: "app.settings.set",
					key: "onboardingDismissed",
					value: JSON.stringify(true),
				});
			}}
```

"Get started" success keeps using `onDone` — completing configuration means
the providers check alone governs future launches, no flag needed (and none
should be set).

**Verify**:
- `npm run typecheck` → exit 0
- Manual: fresh userData (or `onboardingDismissed` unset) shows onboarding →
  Skip → relaunch → not shown. Delete the key via any settings writer (or
  point `PI_DESKTOP_TEST_*` harness if available) → shown again.

### Step 3: Prune rotated logs too (fix 3)

In `src/main/services/paths.ts`, widen the match to the family:

```ts
		for (const name of readdirSync(logsDir)) {
			if (!name.startsWith("pidesktop-") || !name.includes(".log")) continue;
```

(Keeps the daily files *and* their `.log.<ts>.rotated` children; ignores
foreign files.) Age check stays mtime-based — correct for rotated chunks since
rename preserves mtime of last write.

**Verify**:
- `npm run typecheck` → exit 0
- Quick check: drop `pidesktop-20200101.log.123.rotated` into the logs dir,
  restart dev app, confirm deleted; drop `unrelated.txt`, confirm untouched.

### Step 4: Clear stale health-poll intervals (fix 4)

At the top of `startHealthPolling()` in `src/main/sidecar/manager.ts`:

```ts
	private startHealthPolling(): void {
		if (this.healthTimer !== null) clearInterval(this.healthTimer);
		this.healthTimer = null;
		this.setStatus("starting");
		…
```

**Verify**:
- `npm run typecheck` → exit 0
- Extend `tests/unit/sidecar-manager.test.ts`: existing fake-child pattern —
  add `"restart replaces the health poll interval"` — drive two consecutive
  `start()` calls (or start → simulated exit → restart per the file's existing
  helpers); assert via whatever clock/spy mechanism the file uses that only one
  interval is live after the second start (e.g., count active fake timers, or
  assert the manager cleared before reassigning by observing `clearInterval`
  spy called once between starts). Model the assertion style on the file's
  current tests rather than introducing a new mocking library.

**Verify**: `npx vitest --run tests/unit/sidecar-manager.test.ts` → green;
`npm test` → ≥95 passed.

### Step 5: Full gate

**Verify**:
- `npm test` → exit 0
- `npm run e2e` → exit 0, 30 passed (auth-settings e2e touches onboarding
  paths — if it asserts onboarding appears on a fresh profile it still will;
  if it skips after a prior dismissal within the same staged profile, read the
  failure before changing anything and consult STOP conditions)

## Test plan

Covered inline above (sidecar interval test). For fixes 1–3 the manual checks
are the verification — each is environment-dependent (PATH, filesystem, app
lifecycle) and not worth electron-harness machinery. If you want extra guard
rails, a source-level test asserting `paths.ts` prunes `.includes(".log")` is
acceptable in the same spirit as prior plans, but optional here.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 (≥95 passed including the new sidecar test)
- [ ] `npm run e2e` exits 0, 30 passed
- [ ] Manual matrix: editor-fallback fires without `code` on PATH · Skip
      survives relaunch · rotated fixture pruned on boot · second `start()`
      leaves one interval
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 012 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Fix 1: `shell.openPath` also fails in your environment (both fallbacks dead)
  — capture errors; that is an environment problem, not a code problem.
- Fix 2: `auth-settings.e2e.ts` depends on onboarding appearing when
  `onboardingDismissed` could be set in its staged profile — read the failing
  assertion first; report rather than weakening the e2e.
- Fix 3: logs directory contains non-pidesktop files matching the new glob —
  tighten to `/^pidesktop-.*\.log/` instead and note it.
- Fix 4: the existing test file's fakes cannot express interval counting —
  stop rather than adding a new mock framework.
- Any step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Fix 2 introduces the first renderer-controlled "don't show me again" flag;
  if other flows want the same (e.g. update-available banners), generalize
  then — don't build the abstraction now.
- Fix 3's glob intentionally matches any `pidesktop-*.log*`; if the filename
  prefix ever changes, `todayFile()` in logging.ts and this prune share the
  convention — keep them together.
