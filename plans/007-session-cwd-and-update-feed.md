# Plan 007: Stop guessing a session's cwd, and stop pointing auto-update at someone else's repo

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> ```
> git diff --stat 02fbaf0..HEAD -- src/main/pi/service.ts src/shared/pi.ts src/renderer/src/components/shell/Sidebar.tsx src/renderer/src/pages/SessionsPage.tsx src/main/updater.ts electron-builder.yml
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 002 should land first if it is going to — it edits
  `service.ts` and `Sidebar.tsx`. Not a logical dependency.
- **Category**: bug (correctness + supply-chain hygiene)
- **Planned at**: commit `02fbaf0`, 2026-08-22

## Why this matters

Two unrelated main-process defects, grouped because both are small, both are
outside the renderer, and neither has UI to verify.

**Part A — resuming a session guesses its working directory, and guesses wrong.**
`deriveCwdFromSessionPath()` decodes pi's session-directory name by replacing
every `-` with `/`. Pi's encoder is lossy by construction, so any project folder
containing a hyphen — `pi-desktop`, `my-app`, most repos — decodes to a path
that does not exist. That bogus cwd is then handed to the session runtime, to
`SettingsManager`, registered as a file-bridge root, and used to scope the file
explorer and the embedded terminal.

The guess is also **unnecessary**: pi writes the true cwd into the session
file's own header, and both UI call sites already hold the correct value.

**Part B — auto-update points at a repository this project does not own.**
The `publish` block names owner `earendil-works` (upstream pi's org) while the
updater runs with `autoDownload: true` and `autoInstallOnAppQuit: true`. Today
that fails silently by design. If `earendil-works/pi-desktop` is ever created
and publishes releases, an auto-downloading client would fetch and install
binaries from a third party. The repo has no git remote at all, so there is no
correct owner to substitute — the honest fix is to stop pretending there is a
feed.

## Current state

### Part A

**`src/main/pi/service.ts:387-395`** — the guess:

```ts
/** ~/.pi/agent/sessions/--Users-foo-bar/<file>.jsonl → /Users/foo/bar (best effort). */
export function deriveCwdFromSessionPath(sessionPath: string): string {
	const parts = sessionPath.split("/");
	const dirName = parts[parts.length - 2] ?? "";
	if (dirName.startsWith("--") && dirName.endsWith("--")) {
		const encoded = dirName.slice(2, -2);
		return `/${encoded.replaceAll("-", "/")}`;
	}
	return process.cwd();
}
```

**`src/main/pi/service.ts:284-296`** — its only caller:

```ts
	private async resumeSession(req: {
		sessionPath: string;
		backend?: "sdk" | "rpc";
	}): Promise<SessionOpenedResponse> {
		// Derive cwd from the session file location (sessions live under
		// ~/.pi/agent/sessions/--<encoded-cwd>--/); the backend re-derives precisely.
		const cwd = deriveCwdFromSessionPath(req.sessionPath);
		return this.startSession({
			cwd,
			kind: req.backend ?? "sdk",
			sessionPath: req.sessionPath,
		});
	}
```

The comment's claim that "the backend re-derives precisely" is **false** —
`SdkPiBackend.getCwd()` returns `this.options.cwd`, i.e. the guess, and
`main/index.ts` registers exactly that value as a file-bridge root in its
`onSessionOpened` hook.

**Why the encoder is lossy** —
`pi/packages/coding-agent/src/core/session-manager.ts:476-480`:

```ts
function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}
```

A hyphen inside a path segment is indistinguishable from a separator after
encoding. Real evidence from this machine's `~/.pi/agent/sessions/`:

```
--private-var-folders-lh-mcd0l9xs031_hc5st564q2f40000gn-T-pidesktop-ws-proj-22467--
```

which the current code decodes to
`/private/var/folders/lh/.../T/pidesktop/ws/proj/22467`, where the true path was
`.../T/pidesktop-ws-proj-22467`. **No decoder can be correct here** — the
information is gone. The fix must get cwd from somewhere else.

**Two better sources, both already available:**

1. **The callers already know it.** Both renderer call sites hold the true cwd,
   sourced from `SessionManager.listAll()` → `info.cwd`:
   - `src/renderer/src/components/shell/Sidebar.tsx:90-96` —
     `openSession(s: SidebarSession)`, where `SidebarSession.cwd: string | null`
     (declared at `Sidebar.tsx:9-18`):
     ```ts
			const result = await window.piDesktop.invoke({
				type: "session.resume",
				sessionPath: s.filePath,
			});
     ```
   - `src/renderer/src/pages/SessionsPage.tsx:138-151` —
     `resume(session: IndexedSession)`, where `IndexedSession.cwd: string | null`
     (declared in `src/shared/pi.ts`):
     ```ts
			const result = await window.piDesktop.invoke({
				type: "session.resume",
				sessionPath: session.filePath,
			});
     ```

2. **The session file stores it.** Every session JSONL begins with a
   `SessionHeader`. From the installed
   `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts`:
   ```ts
   {
       version?: number;
       id: string;
       timestamp: string;
       cwd: string;
   }
   ```
   and `SessionManager.open(path, sessionDir?, cwdOverride?)` documents
   `cwdOverride` as "Optional cwd override **instead of the session header
   cwd**" — confirming the header is the authoritative source.

**The IPC schema to extend** — `src/shared/pi.ts:226-230`:

```ts
export const sessionResumeRequestSchema = Type.Object({
	type: Type.Literal("session.resume"),
	sessionPath: Type.String({ minLength: 1 }),
	backend: Type.Optional(Type.Union([Type.Literal("sdk"), Type.Literal("rpc")])),
});
```

### Part B

**`electron-builder.yml:19-23`**:

```yaml
publish:
  provider: github
  owner: earendil-works
  repo: pi-desktop
  releaseType: release
```

**`src/main/updater.ts:15-47`**:

```ts
export function setupAutoUpdater(logger: Logger): void {
	if (!app_isPackaged()) {
		logger.info("main", "auto-update skipped (dev build)");
		return;
	}

	autoUpdater.logger = null; // we do our own logging
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;
	// … event handlers …
	void autoUpdater.checkForUpdatesAndNotify().catch(() => {});
	const interval = setInterval(() => {
		void autoUpdater.checkForUpdatesAndNotify().catch(() => {});
	}, 6 * 60 * 60 * 1000);
	interval.unref?.();
}
```

Context that determines the right fix:

- `git remote -v` in this repo returns **nothing** — there is no GitHub remote,
  so there is no correct owner to substitute.
- `electron-builder.yml` sets `mac.identity: null` (unsigned), and
  electron-updater cannot validate an unsigned build's signature on macOS.
- `docs/RELEASE.md` describes signing and notarization as future work.

So the correct change is to **disable the updater until there is a real,
owned, signed feed** — not to guess a different owner.

### Repo conventions

- **Strict TypeScript**, `exactOptionalPropertyTypes` on: spread optional
  properties conditionally (`...(x !== undefined ? { x } : {})`), never assign
  `undefined`.
- Tabs for indent, double-quoted strings.
- IPC request schemas live in `src/shared/pi.ts` using `typebox`
  (`Type.Object`, `Type.Optional`); the file must stay free of node/electron
  imports. New optional fields are additive and need no response-type change.
- Main-process logging: `logger.info("main", "…")`.
- Store/session failures are failure-isolated — see the `guard()` pattern in
  `src/main/store/service.ts`. Never let a persistence or parsing problem break
  a session.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | exit 0, 53 passed at baseline |
| E2E | `npm run e2e` | exit 0, 30 passed |
| Package | `npm run dist:mac` | exit 0 |

## Scope

**In scope**:

- `src/shared/pi.ts` — add one optional field to the resume schema
- `src/main/pi/service.ts` — `resumeSession`, `deriveCwdFromSessionPath`
- `src/renderer/src/components/shell/Sidebar.tsx` — pass the known cwd
- `src/renderer/src/pages/SessionsPage.tsx` — pass the known cwd
- `src/main/updater.ts`
- `electron-builder.yml` — the `publish:` block only
- `docs/RELEASE.md` — record the updater's disabled state
- `tests/unit/session-cwd.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):

- `mac.identity`, `hardenedRuntime`, or anything else in the signing config.
  Signing is `docs/RELEASE.md`'s job and is a prerequisite *for* re-enabling the
  updater, not part of this plan.
- `electron-builder.yml`'s `icon:` key — that is plan 001.
- `src/main/pi/sdk-backend.ts` / `rpc-backend.ts` — they consume
  `options.cwd`; fixing the value passed in is sufficient.
- `src/main/fs-bridge.ts` root registration — it is correct, it was just being
  fed a bad path.
- The `db.sessions.*` handlers — they already carry the true cwd.

## Git workflow

- Branch: `advisor/007-session-cwd-and-update-feed`
- Commits, conventional style:
  - `fix: use the session's real cwd on resume instead of decoding the path`
  - `fix: disable auto-update until a real signed feed exists`
- Do NOT push or open a PR.

## Steps

### Step 1: Allow the resume request to carry a known cwd

In `src/shared/pi.ts`, add one optional field to `sessionResumeRequestSchema`:

```ts
export const sessionResumeRequestSchema = Type.Object({
	type: Type.Literal("session.resume"),
	sessionPath: Type.String({ minLength: 1 }),
	backend: Type.Optional(Type.Union([Type.Literal("sdk"), Type.Literal("rpc")])),
	/**
	 * True working directory, when the caller knows it (session list rows carry
	 * it). Pi's session-directory encoding is lossy, so it cannot be recovered
	 * from `sessionPath` — see resolveResumeCwd in main/pi/service.ts.
	 */
	cwd: Type.Optional(Type.String({ minLength: 1 })),
});
```

This is additive; no response type changes.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "resolveResumeCwd" src/shared/pi.ts` → `1` (in the comment)

### Step 2: Resolve cwd from real sources, in priority order

In `src/main/pi/service.ts`, add a resolver and use it in `resumeSession`.

Priority: **caller-supplied → session-file header → lossy derivation (last
resort)**.

```ts
/**
 * Resolve the working directory for a resumed session.
 *
 * Pi encodes cwd into the session directory name with
 * `cwd.replace(/[/\\:]/g, "-")`, which is lossy — a hyphen inside a path
 * segment is indistinguishable from a separator, so `--Users-me-my-app--`
 * could be /Users/me/my-app or /Users/me/my/app. Never trust the decode when a
 * real source is available.
 */
export function resolveResumeCwd(
	sessionPath: string,
	suppliedCwd: string | undefined,
	readHeaderCwd: (path: string) => string | undefined = readSessionHeaderCwd
): string {
	if (suppliedCwd !== undefined && suppliedCwd.length > 0) return suppliedCwd;
	const headerCwd = readHeaderCwd(sessionPath);
	if (headerCwd !== undefined && headerCwd.length > 0) return headerCwd;
	return deriveCwdFromSessionPath(sessionPath);
}

/**
 * Read `cwd` from a session file's header (its first JSONL line). Returns
 * undefined for unreadable files or pre-cwd sessions — callers fall back.
 */
export function readSessionHeaderCwd(sessionPath: string): string | undefined {
	try {
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const firstLine = readFileSync(sessionPath, "utf8").split("\n", 1)[0] ?? "";
		if (firstLine.length === 0) return undefined;
		const header = JSON.parse(firstLine) as { type?: string; cwd?: unknown };
		if (header.type !== "session") return undefined;
		return typeof header.cwd === "string" && header.cwd.length > 0 ? header.cwd : undefined;
	} catch {
		return undefined;
	}
}
```

> **On reading the whole file**: `readFileSync(...).split("\n", 1)` reads the
> entire session file into memory to take one line. Session JSONL files can be
> multi-megabyte. If that is a concern, read a bounded prefix instead — open the
> file, read the first 64 KB into a buffer, and split that. Either is acceptable;
> prefer the bounded read if it is straightforward in this codebase.

Then update `resumeSession`, deleting the now-false comment:

```ts
	private async resumeSession(req: {
		sessionPath: string;
		backend?: "sdk" | "rpc";
		cwd?: string;
	}): Promise<SessionOpenedResponse> {
		const cwd = resolveResumeCwd(req.sessionPath, req.cwd);
		return this.startSession({
			cwd,
			kind: req.backend ?? "sdk",
			sessionPath: req.sessionPath,
		});
	}
```

Finally, retitle `deriveCwdFromSessionPath`'s docstring so nobody trusts it:

```ts
/**
 * LAST RESORT ONLY — pi's session-directory encoding is lossy and this decode
 * is wrong for any path segment containing a hyphen. Prefer resolveResumeCwd.
 */
```

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "the backend re-derives precisely" src/main/pi/service.ts` → `0`
- `grep -c "LAST RESORT ONLY" src/main/pi/service.ts` → `1`

### Step 3: Pass the known cwd from both call sites

**`Sidebar.tsx`**, in `openSession(s)`:

```ts
			const result = await window.piDesktop.invoke({
				type: "session.resume",
				sessionPath: s.filePath,
				...(s.cwd !== null ? { cwd: s.cwd } : {}),
			});
```

**`SessionsPage.tsx`**, in `resume(session)`:

```ts
			const result = await window.piDesktop.invoke({
				type: "session.resume",
				sessionPath: session.filePath,
				...(session.cwd !== null ? { cwd: session.cwd } : {}),
			});
```

Both fields are `string | null`, so the conditional spread is required by
`exactOptionalPropertyTypes` — do not pass `cwd: s.cwd` directly.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "cwd: s.cwd" src/renderer/src/components/shell/Sidebar.tsx` → `1`
- `grep -c "cwd: session.cwd" src/renderer/src/pages/SessionsPage.tsx` → `1`

### Step 4: Stop the updater pointing at a repo this project does not own

**`electron-builder.yml`** — comment out the whole `publish` block with the
reason, rather than substituting a guessed owner:

```yaml
# No auto-update feed yet. The previous config pointed at
# earendil-works/pi-desktop — upstream pi's org, not this project's. Re-enable
# only when (a) this repo has its own GitHub remote and (b) builds are signed
# and notarized (mac.identity is currently null, so electron-updater cannot
# verify an update's signature). See docs/RELEASE.md.
# publish:
#   provider: github
#   owner: <your-org>
#   repo: <your-repo>
#   releaseType: release
```

**`src/main/updater.ts`** — bail out explicitly instead of relying on the feed
lookup failing. Add a guard right after the existing dev-build check:

```ts
	// Auto-update is disabled until this project has its own signed release
	// feed. Without this guard, autoDownload would install whatever the
	// configured publish target serves — see docs/RELEASE.md.
	if (process.env.PI_DESKTOP_ENABLE_UPDATER !== "1") {
		logger.info("main", "auto-update disabled (no signed release feed configured)");
		return;
	}
```

The env-var escape hatch keeps the rest of the function live and testable for
whoever re-enables it, without shipping an active updater. Leave everything
below the guard unchanged.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "^publish:" electron-builder.yml` → `0`
- `grep -c "earendil-works" electron-builder.yml` → `1` (only inside the
  explanatory comment)
- `npm run dist:mac` → exit 0 (electron-builder must not require a publish block)

> If `npm run dist:mac` fails because `publish` is absent, restore a minimal
> block with `provider: generic` and a placeholder URL rather than a github
> owner, keep the updater guard, and note the deviation. Do **not** restore the
> `earendil-works` owner.

### Step 5: Document it

In `docs/RELEASE.md`, add a short subsection stating that auto-update is
disabled, why (no owned remote, unsigned builds), and the three things needed to
re-enable it: an owned GitHub repo, Developer ID signing plus notarization, and
setting `PI_DESKTOP_ENABLE_UPDATER=1`. Two or three sentences; do not
restructure the document.

**Verify**:
- `grep -c "PI_DESKTOP_ENABLE_UPDATER" docs/RELEASE.md` → `1`
- `./scripts/check-secrets.sh` → exit 0

## Test plan

**`tests/unit/session-cwd.test.ts`** (create; model on
`tests/unit/fs-bridge.test.ts`, which uses `node:fs` and temp dirs without
Electron). Import `resolveResumeCwd` and `deriveCwdFromSessionPath` from
`src/main/pi/service.ts`.

1. `"prefers the caller-supplied cwd"` — `resolveResumeCwd(path, "/real/my-app", () => "/other")`
   returns `/real/my-app`.
2. `"falls back to the session header cwd"` — supplied `undefined`, stub reader
   returns `/real/my-app`; result is `/real/my-app`.
3. `"falls back to derivation when neither is available"` — supplied
   `undefined`, stub reader returns `undefined`; result is the derived value.
4. `"ignores an empty supplied cwd"` — `""` must not win over the header.
5. `"reads cwd from a real session header"` — write a temp `.jsonl` whose first
   line is `{"type":"session","version":1,"id":"s1","timestamp":"…","cwd":"/tmp/my-app"}`,
   call `readSessionHeaderCwd`, expect `/tmp/my-app`.
6. `"returns undefined for a malformed header"` — first line is `not json`.
7. **`"documents that path derivation is lossy"`** — assert
   `deriveCwdFromSessionPath(".../--Users-me-my-app--/s.jsonl")` returns
   `/Users/me/my/app`. This test asserts the *wrong* answer on purpose, to pin
   the reason the fallback must stay last. Comment it as such so nobody
   "fixes" it.

**Same file, `tests/unit/session-cwd.test.ts`** — add these source guards
alongside the behavioral tests above. Do **not** append them to
`tests/unit/regressions.test.ts`: three earlier plans all did that and produced
a three-way merge conflict whose hunks interleave badly. One test file per plan.

8. `"resume no longer trusts path derivation"` — read `service.ts`, assert it
   contains `resolveResumeCwd` and not `the backend re-derives precisely`.
9. `"auto-update has no third-party feed"` — read `electron-builder.yml`,
   assert it does **not** contain a line matching `^publish:`, and that
   `src/main/updater.ts` contains `PI_DESKTOP_ENABLE_UPDATER`.

**Verification**: `npm test` → exit 0, roughly `62 passed` (53 + 7 + 2).

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with the new tests passing
- [ ] `npm run e2e` exits 0, 30 passed
- [ ] `grep -c "^publish:" electron-builder.yml` → `0`
- [ ] `grep -c "the backend re-derives precisely" src/main/pi/service.ts` → `0`
- [ ] `grep -c "PI_DESKTOP_ENABLE_UPDATER" src/main/updater.ts docs/RELEASE.md` →
      `1` each
- [ ] `npm run dist:mac` exits 0
- [ ] `./scripts/check-secrets.sh` exits 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 007 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The session header's first line is **not** a `{"type":"session", …}` object in
  real files on this machine. Inspect one with
  `head -c 400 ~/.pi/agent/sessions/*/*.jsonl | head -5`. If the shape differs
  from the `SessionHeader` type quoted above, the reader in step 2 needs a
  different parse — report the actual shape rather than guessing.
- Adding the optional `cwd` field breaks IPC schema validation (the router
  parses with typebox `Parse`, which rejects unknown properties in some
  configurations). Symptom: resume starts failing with `invalid_request`. If so,
  report — do not work around it by loosening the schema.
- `npm run dist:mac` fails twice for a reason other than the known
  cleanup-tool interference documented in the README.
- You are tempted to put a real GitHub owner in `publish:`. Do not guess one —
  the repo has no remote and the owner is the user's decision.

## Maintenance notes

- **For the reviewer**: the important property is the **priority order** in
  `resolveResumeCwd`. Caller-supplied must beat the header, because a session
  moved between directories will have a stale header while the index row is
  refreshed from `SessionManager.listAll()`. Derivation must stay last and must
  never be reachable when either better source exists.
- Test 7 deliberately asserts an incorrect decode. If someone later "fixes"
  `deriveCwdFromSessionPath` to pass that test differently, they have
  misunderstood — the encoding is not invertible. The comment on the test needs
  to survive.
- Sessions created before pi recorded `cwd` in the header have `cwd: ""`
  (documented on `SessionInfo` as "Empty string for old sessions"). Those still
  fall through to derivation, so old hyphenated projects remain wrong. Accepted:
  there is no recoverable source for them.
- **Re-enabling the updater** needs all three of: an owned GitHub repo in
  `publish`, Developer-ID signing plus notarization (`mac.identity` is currently
  `null`, and `electron-builder.yml` already carries a warning that
  signed-but-unnotarized builds were being deleted by local security software),
  and `PI_DESKTOP_ENABLE_UPDATER=1`. Doing fewer than all three ships a client
  that either cannot verify updates or fetches them from the wrong place.
