# Plan 004: Actually load the approval extension so "confirm before apply" works

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> ```
> git diff --stat 02fbaf0..HEAD -- src/main/pi/backend.ts src/main/pi/service.ts src/main/pi/sdk-backend.ts src/main/index.ts resources/extensions/pi-desktop-approve.ts
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug (safety-relevant) + docs
- **Planned at**: commit `02fbaf0`, 2026-08-22

## Why this matters

Pi Desktop's README (chapter 7), `aboutproject.md`, and `docs/security.md` all
describe a bundled **confirm-before-apply** approval gate as a shipped feature —
the one capability a GUI adds over pi's terminal UI. It does not exist. The
agent's `bash`, `edit`, and `write` tool calls execute with no confirmation
step, and three documents say otherwise.

The plumbing is broken at **two** levels, both of which this plan fixes:

1. `PiService.setExtensionPaths()` has **zero callers**, so `extensionPaths` is
   always `[]`.
2. Even if it were called, **neither backend reads it** — `SdkPiBackend` never
   passes it to pi, so the option is inert.

The good news: everything downstream already works. Pi's `tool_call` extension
hook supports blocking, and Pi Desktop's `SdkExtensionUiAdapter` already bridges
`ctx.ui.confirm()` to a real native-feeling dialog in the renderer
(`DialogModal`), including the `session.respond_ui` round-trip. **Only the
loading is missing.** That makes this smaller than it first appears.

## Current state

### The extension itself — `resources/extensions/pi-desktop-approve.ts`

Complete and correct. It is referenced by **nothing**: not `src/`, not `tests/`,
not `electron.vite.config.ts`, and not `electron-builder.yml`'s `files:` or
`extraResources:` — so it would not even ship in a packaged build.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ToolCallLike {
	toolName: string;
	input?: { command?: unknown; path?: unknown; file_path?: unknown };
}

function summarize(event: ToolCallLike): string {
	const input = event.input ?? {};
	if (event.toolName === "bash" && typeof input.command === "string") {
		return `$ ${input.command.slice(0, 400)}`;
	}
	const filePath =
		typeof input.path === "string" ? input.path
		: typeof input.file_path === "string" ? input.file_path
		: "(unknown file)";
	return `${event.toolName}: ${filePath}`;
}

export default function approveExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" && event.toolName !== "edit" && event.toolName !== "write") {
			return;
		}
		const ok = await ctx.ui.confirm(`Allow ${event.toolName}?`, summarize(event as ToolCallLike));
		if (!ok) {
			return { block: true, reason: "Denied by user in Pi Desktop." };
		}
	});
}
```

Verified against pi 0.84.2's own types — this contract is right:

- `ExtensionAPI.on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>)`
  (`pi/packages/coding-agent/src/core/extensions/types.ts:1258`)
- `ToolCallEventResult { block?: boolean; reason?: string; terminate?: boolean }`
  (same file, `:1087`)
- `ctx.ui.confirm(title, message, opts?): Promise<boolean>` (same file, `:136`)

### The dead setter — `src/main/pi/service.ts:46,71-73,312`

```ts
	private extensionPaths: string[] = [];
```
```ts
	/** Extension files loaded into every SDK session (e.g. approval gate). */
	setExtensionPaths(paths: string[]): void {
		this.extensionPaths = paths;
	}
```
```ts
			...(this.extensionPaths.length > 0 ? { extensionPaths: this.extensionPaths } : {}),
```

`grep -rn "setExtensionPaths" src/ tests/` returns only these declarations —
no call sites.

### The option that is never consumed — `src/main/pi/sdk-backend.ts:87-92`

`BackendOptions.extensionPaths` is declared (`src/main/pi/backend.ts:32`) and
`PiService` forwards it, but `SdkPiBackend.start()` builds services without it:

```ts
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				...(this.modelRuntime !== null ? { modelRuntime: this.modelRuntime } : {}),
				settingsManager,
			});
```

`grep -n "extensionPaths" src/main/pi/sdk-backend.ts src/main/pi/rpc-backend.ts`
returns nothing.

### How pi actually wants extensions passed

`createAgentSessionServices` accepts `resourceLoaderOptions`
(`pi/packages/coding-agent/src/core/agent-session-services.ts:44`):

```ts
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
```

and spreads it into the loader (`:148-153`). `DefaultResourceLoaderOptions`
(`pi/packages/coding-agent/src/core/resource-loader.ts:159-175`) offers two
routes:

```ts
	additionalExtensionPaths?: string[];
	extensionFactories?: InlineExtension[];
```

**Use `extensionFactories`, not `additionalExtensionPaths`.** The path route
would require shipping a `.ts` file, compiling or `jiti`-loading it at runtime,
and unpacking it from the asar archive — three failure modes for a file we
already control. Since Pi Desktop hosts the SDK **in-process**, the extension
can simply be imported as a function.

`InlineExtension` is exported from the package index
(`pi/packages/coding-agent/src/index.ts:96`) and is defined at
`core/extensions/types.ts:1544`:

```ts
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export type InlineExtension =
	| ExtensionFactory
	| { name: string; factory: ExtensionFactory; hidden?: boolean };
```

The existing `approveExtension` already **is** an `ExtensionFactory`.

### The bridge that already works — do not rebuild it

`src/main/pi/extension-ui.ts` (`SdkExtensionUiAdapter`) implements
`confirm(title, message, opts)` by emitting a `ui_dialog` event and awaiting
`session.respond_ui`; it resolves `false` on cancel or timeout
(`extension-ui.ts:39-41, 58-60, 144-160`). `SdkPiBackend.bindToSession()`
already installs it via `session.bindExtensions({ uiContext: … })`
(`sdk-backend.ts:122-126`). The renderer renders it in
`src/renderer/src/components/chat/DialogModal.tsx` (`data-testid="dialog-confirm"`),
and `ChatPage.tsx` routes the answer back. **This entire round-trip is built and
working.** Your job is only to get the extension loaded.

### Where main wires session-scoped capabilities — `src/main/index.ts:112`

`piService.setDesktopTools(createDesktopTools({ … }))` is the existing
precedent for injecting main-process capability into every session. Add the
extension wiring alongside it.

### The Settings toggle pattern — `src/renderer/src/pages/SettingsPage.tsx:212-244`

```tsx
function SoundToggle(): React.JSX.Element {
	const [enabled, setEnabled] = useState(true);

	useEffect(() => {
		void window.piDesktop
			.invoke({ type: "app.settings.get", key: "soundEnabled" })
			.then((r) => {
				if (r.ok && r.data !== null) setEnabled(r.data === true);
			});
	}, []);

	return (
		<button
			type="button"
			onClick={() => {
				const next = !enabled;
				setEnabled(next);
				void window.piDesktop.invoke({
					type: "app.settings.set",
					key: "soundEnabled",
					value: JSON.stringify(next),
				});
			}}
			className={`h-5 w-9 rounded-full transition ${enabled ? "bg-blue-600" : "bg-neutral-700"}`}
		>
			<span className={`block h-4 w-4 rounded-full bg-white transition ${enabled ? "ml-[18px]" : "ml-0.5"}`} />
		</button>
	);
}
```

used as:

```tsx
				<div className="mt-8 border-t border-neutral-800 pt-5">
					<div className="mb-2 text-sm text-neutral-200">Sound</div>
					<SettingRow label="Sound effects" hint="Task completion, errors, notifications">
						<SoundToggle />
```

Copy this shape exactly for the new toggle.

### Repo conventions

- **Strict TypeScript**, `exactOptionalPropertyTypes` on: optional properties
  are spread conditionally (`...(x !== undefined ? { x } : {})`), never assigned
  `undefined`.
- Main-process modules are ESM with `.ts` extensions omitted in imports; see
  neighbouring imports in `src/main/index.ts`.
- `src/main/pi/desktop-tools.ts` is the model for "a main-process capability
  injected into every session" — read it before writing step 3.
- Settings are persisted through `app.settings.get` / `app.settings.set` with
  JSON-encoded values (`src/main/store/service.ts`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | exit 0, 53 passed |
| E2E | `npm run e2e` | exit 0, 30 passed |
| Dev app | `npm run dev` | window opens |
| Secrets scan | `./scripts/check-secrets.sh` | exit 0 |

## Scope

**In scope**:

- `src/main/pi/approve-extension.ts` (create — moved from `resources/extensions/`)
- `resources/extensions/pi-desktop-approve.ts` (delete)
- `src/main/pi/backend.ts` — add `extensionFactories` to `BackendOptions`
- `src/main/pi/sdk-backend.ts` — consume it
- `src/main/pi/service.ts` — replace the dead `setExtensionPaths` with a working setter
- `src/main/index.ts` — wire it, gated on the setting
- `src/renderer/src/pages/SettingsPage.tsx` — add the toggle
- `tests/unit/regressions.test.ts` (extend)
- `README.md`, `docs/security.md`, `aboutproject.md` — correct the claims
- `plans/README.md` — status row

**Out of scope** (do NOT touch, even though they look related):

- `src/main/pi/extension-ui.ts` — the dialog bridge is complete and correct.
  Do not modify it. If confirmations do not appear, the bug is in your loading
  code, not here.
- `src/renderer/src/components/chat/DialogModal.tsx` — already renders confirm
  dialogs.
- `src/main/pi/rpc-backend.ts` — the RPC backend is a fallback; inline factories
  cannot cross a subprocess boundary. Leave it alone; step 3 documents the
  limitation instead.
- The `permissionMode` / `onPermissionModeChange` props on `Composer`
  (`Composer.tsx:40-41`). A three-way composer chip (Full access / Confirm /
  Read-only) is a **separate, larger** feature. This plan ships a binary
  on/off setting only. Do not build the chip.
- `src/shared/pi.ts` — no IPC contract change is needed; the existing
  `app.settings.*` channels carry the toggle.

## Git workflow

- Branch: `advisor/004-approval-gate`
- Commits, conventional style:
  - `feat: load the desktop approval extension into SDK sessions`
  - `feat: add confirm-before-apply setting`
  - `docs: correct approval-gate claims`
- Do NOT push or open a PR.

## Steps

### Step 1: Move the extension into the compiled main bundle

`git mv resources/extensions/pi-desktop-approve.ts src/main/pi/approve-extension.ts`

Moving it under `src/main/` means electron-vite compiles it into the main
process bundle — no separate build step, no asar unpacking, no runtime loader.

Change the export from a default export to a **named** export so the import site
reads clearly, and type it explicitly as pi's `ExtensionFactory`:

```ts
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

// … summarize() unchanged …

/** Confirm-before-apply gate: routes bash/edit/write through ctx.ui.confirm. */
export const approveExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.on("tool_call", async (event, ctx) => {
		// … body unchanged …
	});
};
```

Keep `summarize()` and the handler body exactly as they are — that logic is
correct and verified against pi's types.

**Verify**:
- `npm run typecheck` → exit 0
- `ls resources/extensions/` → directory is empty or gone
- `grep -n "ExtensionFactory" src/main/pi/approve-extension.ts` → one match

> If `ExtensionFactory` is not exported from the package root, fall back to
> typing it as `(pi: ExtensionAPI) => void`. Confirm with
> `grep -n "ExtensionFactory" node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts`.

### Step 2: Let a backend receive inline extensions

In `src/main/pi/backend.ts`, replace the unused `extensionPaths` field in
`BackendOptions` (line 32) with an inline-factory field:

```ts
	/** Desktop-owned extensions loaded into every session (e.g. the approval gate). */
	extensionFactories?: unknown[];
```

Use `unknown[]` and cast at the SDK boundary, matching how `desktopTools?: unknown[]`
(line 36) is already handled — this keeps `backend.ts` free of deep pi type
imports, which is the existing convention in that file.

**Verify**:
- `grep -c "extensionPaths" src/main/pi/backend.ts` → `0`
- `npm run typecheck` → **expect failures** in `service.ts` at this point (it
  still references `extensionPaths`). That is correct; step 4 resolves them.

### Step 3: Consume the factories in the SDK backend

In `src/main/pi/sdk-backend.ts`, mirror how `customTools` is handled
(`sdk-backend.ts:66`) — read the option near the top of `start()`:

```ts
		const extensionFactories = (this.options.extensionFactories ?? []) as
			import("@earendil-works/pi-coding-agent").InlineExtension[];
```

then pass it through `resourceLoaderOptions` in the services call:

```ts
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				...(this.modelRuntime !== null ? { modelRuntime: this.modelRuntime } : {}),
				settingsManager,
				...(extensionFactories.length > 0
					? { resourceLoaderOptions: { extensionFactories } }
					: {}),
			});
```

Add a comment recording the RPC limitation:

```ts
	// Inline extension factories are SDK-mode only: a function cannot cross the
	// `pi --mode rpc` subprocess boundary. RPC sessions run without the gate.
```

**Verify**:
- `grep -n "extensionFactories" src/main/pi/sdk-backend.ts` → at least two matches
- `npm run typecheck` → still failing only in `service.ts`

### Step 4: Replace the dead setter in PiService

In `src/main/pi/service.ts`:

- Rename the field (line 46): `private extensionFactories: unknown[] = [];`
- Replace `setExtensionPaths` (lines 71-73):

```ts
	/** Desktop-owned extensions injected into every SDK session. */
	setExtensionFactories(factories: unknown[]): void {
		this.extensionFactories = factories;
	}
```

- Update the `backendOptions` spread (line 312):

```ts
			...(this.extensionFactories.length > 0
				? { extensionFactories: this.extensionFactories }
				: {}),
```

**Verify**:
- `grep -rc "setExtensionPaths\|extensionPaths" src/` → `0` across all files
- `npm run typecheck` → exit 0 (all errors from steps 2–3 now resolved)

### Step 5: Wire it in main, gated on a setting

In `src/main/index.ts`, immediately after the existing
`piService.setDesktopTools(createDesktopTools({ … }))` block (starts line 112),
add the gate wiring. Requirements:

- Read the setting with `storeService.getSettingRaw("confirmBeforeApply")`.
- **Default to ON when unset.** A brand-new install should confirm; opting out
  must be a deliberate choice. `getSettingRaw` returns `null` when absent, so
  treat `null` as `true` and only disable on an explicit `false`.
- Import `approveExtension` at the top of the file with the other `./pi/*`
  imports.

```ts
		const confirmBeforeApply = storeService.getSettingRaw("confirmBeforeApply") !== false;
		piService.setExtensionFactories(
			confirmBeforeApply
				? [{ name: "pi-desktop-approve", factory: approveExtension }]
				: []
		);
		logger.info("main", `approval gate ${confirmBeforeApply ? "enabled" : "disabled"}`);
```

The `{ name, factory }` object form (rather than a bare function) makes the
extension show up as `<inline:pi-desktop-approve>` in pi's startup extension
list, which is useful when debugging whether it loaded.

> **The setting applies at session creation.** Toggling it does not affect
> sessions that are already open. That is acceptable for v1 — say so in the
> setting's hint text in step 6 rather than building live re-binding.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "setExtensionFactories" src/main/index.ts` → one match

### Step 6: Add the Settings toggle

In `src/renderer/src/pages/SettingsPage.tsx`, add an `ApprovalToggle` component
copied structurally from `SoundToggle` (lines 212-244), with:

- key `"confirmBeforeApply"`
- `useState(true)` initial — matching the default-on behavior from step 5
- the same `r.data !== null` guard so an unset value stays `true`

Render it in its own section above the Sound section, following the existing
`SettingRow` usage:

```tsx
				<div className="mt-8 border-t border-neutral-800 pt-5">
					<div className="mb-2 text-sm text-neutral-200">Safety</div>
					<SettingRow
						label="Confirm before apply"
						hint="Ask before the agent runs bash or edits files. Applies to new sessions."
					>
						<ApprovalToggle />
					</SettingRow>
				</div>
```

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "confirmBeforeApply" src/renderer/src/pages/SettingsPage.tsx` → `2`

### Step 7: Prove it actually gates (manual — this is the real test)

Automated coverage cannot exercise a real LLM tool call. Verify by hand:

1. `npm run dev`
2. Open a session in a scratch directory (**not** this repo).
3. Prompt something that forces a shell command, e.g.
   `run "echo hello" using bash`.
4. **A confirm dialog must appear** with title `Allow bash?` and body
   `$ echo hello`.
5. Click **Cancel**. The tool must be blocked and the agent must see
   `Denied by user in Pi Desktop.`
6. Repeat and click **Confirm**. The command must run normally.
7. Open Settings, turn **Confirm before apply** off, open a **new** session,
   repeat step 3 — no dialog should appear.

**Verify**: all seven behave as described. If the dialog never appears, check
the main-process log for the `approval gate enabled` line from step 5 before
touching anything else.

### Step 8: Correct the documentation

Three documents currently claim this feature already worked. Now that it does,
they need to be accurate about **scope and limits** rather than simply left
alone:

- `README.md` — the Chapter 7 bullet mentions "a bundled approval extension
  (confirm-before-apply via pi's public extension API)". Add that it is
  **SDK-mode only** and **on by default**.
- `docs/security.md` — under "Process boundaries" or "Known limitations",
  state that the gate covers `bash`/`edit`/`write` in SDK sessions, is
  user-disableable, and that **RPC-mode sessions are not gated**.
- `aboutproject.md` — the Phase-1 timeline line about the approval extension
  should note the same SDK-only limitation.

Keep edits to a few sentences. Do not restructure the documents.

**Verify**:
- `grep -rn "RPC" docs/security.md` → at least one match describing the gap
- `./scripts/check-secrets.sh` → exit 0

## Test plan

Extend `tests/unit/regressions.test.ts`, matching its existing style (each
`it()` names a specific past bug; source-level assertions where behavioral
testing needs the full Electron harness).

1. `"approval extension is wired into PiService"` — read `src/main/index.ts`
   with `node:fs`, assert it contains `setExtensionFactories` and
   `pi-desktop-approve`. This is the regression test for the actual bug: the
   extension existing but never being referenced.
2. `"no dead extensionPaths plumbing remains"` — assert the string
   `extensionPaths` does not appear in `src/main/pi/backend.ts`,
   `src/main/pi/service.ts`, or `src/main/index.ts`.
3. `"approval gate defaults to enabled"` — assert `src/main/index.ts` contains
   `!== false` on the `confirmBeforeApply` read, so an unset setting means on.
4. `"sdk backend forwards extension factories to pi"` — read
   `src/main/pi/sdk-backend.ts`, assert it contains `resourceLoaderOptions` and
   `extensionFactories`.

A behavioral test of the block path would need a stub `ExtensionAPI` and a fake
`ctx.ui`. That is worthwhile but belongs with the wider test-coverage work; the
manual protocol in step 7 covers it for now.

**Verification**: `npm test` → exit 0, `57 passed` (53 existing + 4 new).

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with 4 new tests passing
- [ ] `npm run e2e` exits 0, 30 passed
- [ ] `grep -rc "extensionPaths" src/` returns `0` for every file
- [ ] `grep -rn "setExtensionFactories" src/main/index.ts` returns one match
- [ ] `ls resources/extensions/pi-desktop-approve.ts` → no such file
- [ ] Manual protocol in step 7 passes, including Cancel actually blocking the tool
- [ ] `docs/security.md` documents the RPC-mode gap
- [ ] `./scripts/check-secrets.sh` exits 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 004 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `createAgentSessionServices` in the **installed** package does not accept
  `resourceLoaderOptions.extensionFactories`. Check
  `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` — the pinned
  version is `0.84.2`, matching the clone at `../pi`. If the shape differs, the
  dependency has moved and this plan's approach needs revisiting.
- The confirm dialog appears but clicking **Cancel** does **not** block the
  tool. That means the `{ block: true }` return is being dropped — report it;
  do not start editing `extension-ui.ts`, which is out of scope.
- Confirm dialogs appear for tools other than `bash`/`edit`/`write`, or fire
  during session hydration.
- Loading the extension breaks session startup for any session (watch the main
  log for `Extension "…" error:` diagnostics from
  `agent-session-services.ts:163`).
- You conclude the composer permission-mode chip is required to finish. It is
  explicitly out of scope — ship the binary setting and report.

## Maintenance notes

- **For the reviewer**: the security-relevant detail is the **default**. Confirm
  that a fresh profile (no `confirmBeforeApply` key in settings) gets the gate
  **on**, and that only an explicit `false` disables it. An inverted default
  would silently ship the current unsafe behavior while looking fixed.
- **Known gap, deliberately accepted**: RPC-mode sessions are ungated, because
  an inline function cannot cross the subprocess boundary. Two future options —
  ship a compiled `.js` extension via `additionalExtensionPaths` for the RPC
  path, or forward the confirm over the RPC protocol. Until then the docs must
  keep saying so, and the UI arguably should too.
- **Also deliberately deferred**: the toggle only takes effect for new sessions.
  Live re-binding would mean re-running `bindExtensions` on open sessions
  through `AgentSessionRuntime.setRebindSession` — doable, but it interacts with
  the fork/clone/switch rebinding already in `sdk-backend.ts:118-133` and
  deserves its own change.
- The three-way permission mode (Full access / Confirm tools / Read-only) that
  `Composer`'s unused props anticipate is the natural follow-up. Read-only in
  particular needs a policy for which tools count as reads, which is a design
  question, not a wiring one.
- If pi's `ToolCallEventResult` gains fields (e.g. richer `terminate`
  semantics), revisit `approve-extension.ts` — it currently returns only
  `block` and `reason`.
