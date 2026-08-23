# Plan 010: Make the Commands detail view reachable — carry `path` in `session.commands` and include extension commands

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> ```
> git diff --stat 21dc8aa..HEAD -- src/main/pi/sdk-backend.ts src/main/pi/rpc-backend.ts src/shared/pi.ts src/renderer/src/components/workspace/Dock.tsx src/main/index.ts
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 — a documented chapter-11 feature never activates
- **Effort**: M
- **Risk**: MED — touches the IPC contract (`src/shared/pi.ts`) and the
  security-sensitive `resources.read_text` path
- **Depends on**: none
- **Category**: bug + missing wiring (audit 4 finding C-1)
- **Planned at**: commit `21dc8aa`, 2026-08-23

## Why this matters

The Commands dock browser has two behaviors keyed on `command.path`:
without a path it inserts `/name` into the composer; with one it fetches the
markdown source and renders the detail view — frontmatter parsing,
argument-hint extraction, per-argument inputs, and
`insertWithArgs()` producing `/name <arg1> <arg2>`. The `path` branch is dead:
**no backend ever sets `path`**, so chapter 11's argument-hint forms have never
rendered. Additionally, extension-registered slash commands are absent from
the SDK backend's list entirely, so packages that register commands are
invisible in SDK-mode sessions (the default).

Upstream already carries everything needed: `PromptTemplate.filePath`,
`Skill.filePath`, and extension commands via
`runner.getRegisteredCommands()`. This plan wires what exists.

## Current state

### The consumer branches on a field nobody provides

`src/renderer/src/components/workspace/Dock.tsx:376-378, 419-434`:

```ts
interface DetailedCommand extends CommandInfo {
	path?: string;
}
…
function inspect(command: DetailedCommand): void {
	if (command.path === undefined) {
		onInsert(`/${command.name} `);
		return;
	}
	void window.piDesktop
		.invoke({ type: "resources.read_text", path: command.path })
		.then((r) => {
			if (!r.ok) return;
			const { body, head } = splitFrontmatter(r.data.content);
			setDetail({ command, content: body });
			setArgHints(parseArgumentHint(head));
			setArgValues([]);
		})
		.catch(() => onInsert(`/${command.name} `));
}
```

### SDK backend drops paths and extension commands

`src/main/pi/sdk-backend.ts:277-290`:

```ts
async getCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
	const session = this.requireSession();
	const prompts = session.resourceLoader.getPrompts().prompts.map((p) => ({
		name: p.name,
		description: p.description,
		source: "prompt",
	}));
	const skills = session.resourceLoader.getSkills().skills.map((sk) => ({
		name: `skill:${sk.name}`,
		description: sk.description,
		source: "skill",
	}));
	return [...prompts, ...skills];
}
```

Upstream types it discards:

- `PromptTemplate` (`prompt-templates.ts:11-18`): has `filePath: string` AND
  `argumentHint?: string`.
- `Skill` (`skills.ts:74-81`): has `filePath: string`.
- Extension commands: `agent-session.ts:2465-2487` builds the full list as
  `[...extensionCommands, ...templates, ...skills]` where extension commands
  come from `runner.getRegisteredCommands()` — upstream's own RPC mode includes
  them (`rpc-mode.ts`, `case "get_commands"` → `source: "extension"`).

### The RPC passthrough keeps only three fields

`src/main/pi/rpc-backend.ts:247-252` casts the response to
`Array<{name, description?, source}>`; upstream's `RpcSlashCommand`
(`rpc-types.ts:80-88`) also carries `sourceInfo` which is silently dropped.

### The security boundary you must respect

`src/main/index.ts:174-206` — `resources.read_text` allows **only `.md`** files
(realpath-resolved), contained under `<agentDir>/skills|prompts` or inside
registered project roots, 200 KB cap. Skill/prompt template files are `.md`, so
paths sourced from pi's loaders satisfy this. Extension command `sourceInfo`
may point at `.ts`/`.js` files — those will be rejected by design. The UI must
degrade gracefully (it already does: `.catch(() => onInsert(...))`, plus the
`!r.ok` early return).

## Repo conventions to match

- Tabs, double quotes, strict TS, conditional spreads.
- `src/shared/pi.ts` stays free of node/electron imports.
- New channels need renderer callers — this plan modifies an existing channel's
  payload shape, so update its response type in place (`PiResponseMap["session.commands"]`),
  not by adding a channel.
- One test file per concern: extend `tests/unit/assets.test.ts`? No — create
  `tests/unit/commands-catalog.test.ts` (new concern, new file).
- Conventional commits; do not push or open PRs.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | exit 0, 94 passed before your changes |
| Single file | `npx vitest --run tests/unit/commands-catalog.test.ts` | exit 0 |
| E2E | `npm run e2e` | exit 0, 30 passed |

## Scope

**In scope**:

- `src/main/pi/sdk-backend.ts`
- `src/main/pi/rpc-backend.ts`
- `src/shared/pi.ts` (response type only)
- `src/renderer/src/components/workspace/Dock.tsx` (small: prefer explicit
  `argumentHint` when present; degrade cleanly for non-.md sources)
- `tests/unit/commands-catalog.test.ts` (new)

**Out of scope** (do NOT touch):

- `src/main/index.ts` / `resources.read_text` security posture — do not widen
  the .md-only allowlist. If extension commands can't show details, inserting
  them bare is correct behavior for now.
- The ⌘K palette's command section — it consumes the same channel and gains
  entries automatically; leave it alone.
- Any change to upstream packages or their typings.

## Git workflow

- Branch: `fix/010-commands-detail-path`
- Suggested commits:
  - `feat: carry source paths through session.commands`
  - `feat: include extension commands in SDK command catalog`
  - `fix: degrade gracefully when command sources are not readable markdown`
- Do NOT push or open a PR.

## Steps

### Step 1: Widen the contract's response type

In `src/shared/pi.ts`, `PiResponseMap["session.commands"]` currently is
`{ commands: PiCommandInfo[] }` with

```ts
export type PiCommandInfo = {
	name: string;
	description?: string;
	source: string;
};
```

Add optional fields (optional = backwards compatible with both backends):

```ts
export type PiCommandInfo = {
	name: string;
	description?: string;
	source: string;
	/** Absolute path of the backing resource (.md), when the command has one. */
	path?: string;
	/** Upstream argument-hint from prompt-template frontmatter. */
	argumentHint?: string;
};
```

No request schema changes; no router changes.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Populate it in the SDK backend

Rewrite `SdkPiBackend.getCommands()`:

```ts
async getCommands(): Promise<PiCommandInfo[]> {
	const session = this.requireSession();
	const prompts = session.resourceLoader.getPrompts().prompts.map(
		(p): PiCommandInfo => ({
			name: p.name,
			description: p.description,
			source: "prompt",
			path: p.filePath,
			...(p.argumentHint !== undefined ? { argumentHint: p.argumentHint } : {}),
		})
	);
	const skills = session.resourceLoader.getSkills().skills.map(
		(sk): PiCommandInfo => ({
			name: `skill:${sk.name}`,
			description: sk.description,
			source: "skill",
			path: sk.filePath,
		})
	);
	const extensions = session.extensionRunner?.getRegisteredCommands().map(
		(command): PiCommandInfo => ({
			name: command.invocationName,
			description: command.description,
			source: "extension",
		}) ?? [];
	return [...extensions, ...prompts, ...skills];
}
```

Notes:

- Verify the exact accessor names against the pinned typings in
  `node_modules/@earendil-works/pi-coding-agent/dist` before writing
  (`getRegisteredCommands`, `invocationName`, `argumentHint`). The audit read
  them from upstream source at the same version, but the compiler is the
  authority — see STOP conditions if they differ.
- If `session.extensionRunner` is not public on the pinned `AgentSession`
  type, use whatever public accessor exists (upstream builds its own command
  list from it internally, so *some* path exists); if truly unreachable, ship
  prompts+skills with paths and record the extension-command gap as a follow-up
  rather than reaching into private fields.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "path: p.filePath" src/main/pi/sdk-backend.ts` → 1 match
- `grep -n "path: sk.filePath" src/main/pi/sdk-backend.ts` → 1 match

### Step 3: Pass `sourceInfo`-derived paths through RPC mode

In `src/main/pi/rpc-backend.ts:getCommands()`, widen the cast to include
`sourceInfo` and map what's usable:

```ts
const data = (await this.request({ type: "get_commands" })) as {
	commands: Array<{
		name: string;
		description?: string;
		source: string;
		sourceInfo?: { path?: string };
	}>;
};
return data.commands.map((c) => ({
	name: c.name,
	description: c.description,
	source: c.source,
	// Only .md resources can be fetched back through resources.read_text.
	...(c.sourceInfo?.path !== undefined && c.sourceInfo.path.endsWith(".md")
		? { path: c.sourceInfo.path }
		: {}),
}));
```

Check upstream's `SourceInfo` shape in the pinned dist typings for the exact
field name (`path` vs `file`) before casting — STOP conditions apply on
mismatch.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Use `argumentHint` directly in the browser; degrade cleanly

Two small edits in `src/renderer/src/components/workspace/Dock.tsx`:

1. `DetailedCommand` extends `CommandInfo { path?: string; argumentHint?:
   string }`. In `inspect()`, when `argumentHint` is present, skip the fetch
   entirely and open the arg form from the hint itself:

```ts
function inspect(command: DetailedCommand): void {
	if (command.argumentHint !== undefined) {
		openArgForm(command, parseArgumentHintFromHint(command.argumentHint));
		return;
	}
	…existing path-based flow unchanged…
}
```

   where `parseArgumentHintFromHint("file pattern")` splits on whitespace into
   placeholder names, and `openArgForm` is the existing setDetail/setArgHints/
   setArgValues trio refactored into a helper so both entry points share it.
   Keep `parseArgumentHint` (frontmatter regex) for the fetch path.

2. In the `.then()` of the fetch path, handle rejection explicitly instead of
   silently swallowing: `if (!r.ok) { onInsert(\`/${command.name} \`); return; }`
   — today a denied `.md` read leaves the user staring at nothing. Non-md
   extension sources then behave identically to pathless commands, which is
   the intended degradation.

Do not attempt to render extension command bodies; there is no resource to
fetch and inventing one is out of scope.

**Verify**:
- `npm run typecheck` → exit 0
- Manual (dev): with any skill or prompt template present in `~/.pi/agent`,
  Commands browser → click it → detail pane opens; Insert produces
  `/name <placeholder>` form filled from the argument inputs.

### Step 5: Full gate

**Verify**:
- `npm test` → exit 0
- `npm run e2e` → exit 0, 30 passed

## Test plan

New file `tests/unit/commands-catalog.test.ts`. The SDK backend needs a live
pi session, which unit tests avoid — so test the pure pieces:

1. `"hint-string parser splits placeholders"` — export
   `parseArgumentHintFromHint` from Dock.tsx? No: Dock.tsx is a React module.
   Put the tiny parser in a new pure module
   `src/renderer/src/lib/command-hints.ts` alongside `terminal-tabs.ts`
   (precedent exists) and unit-test it there: empty string → `[]`, single word
   → `["file"]`, multi-word → split array. Reuse it from Dock.tsx.
2. `"contract response type carries optional path/argumentHint"` — import the
   type and assert assignability at compile time (a `const _check:
   PiCommandInfo = { name: "x", source: "prompt", path: "/a.md", argumentHint:
   "<f>" };`). Type-only tests still count toward coverage of the contract
   change and fail the build if regressed.
3. `"RPC mapper passes through md paths only"` — export the mapping step from
   `rpc-backend.ts` (extract `mapRpcCommand(c)` as a module-level function like
   the existing `mapRpcEventToPiEvent` precedent) and test: sourceInfo path
   ending `.md` → present; `.ts` → absent; missing sourceInfo → absent.

**Verification**: `npm test` → exit 0, ≥97 passed.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with the new tests passing
- [ ] `npm run e2e` exits 0, 30 passed
- [ ] Manual check (Step 4 verify) green: detail pane opens for a real
      skill/template; argument form fills placeholders
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 010 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Pinned dist typings differ from the upstream-source names used here
  (`invocationName`, `argumentHint`, `SourceInfo.path`) — record actual names
  and stop; the mapping code must match reality, not the plan.
- `extensionRunner` (or equivalent) is not reachable from `AgentSession`'s
  public surface in the pinned version — ship steps 1–4 without extension
  commands, note the gap in `plans/README.md`, and stop before hacking access.
- `resources.read_text` rejects a legitimate `.md` skill/template path during
  manual verification — that means realpath containment is failing for agent-dir
  layouts other than yours; capture the logged reason and stop (do not loosen
  the containment check as part of this plan).
- Any step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- When RemotePiBackend lands, its command catalog should reuse the widened
  `PiCommandInfo` untouched — remote snapshots may carry paths that are
  meaningless locally; the `.md` filter plus failed-fetch degradation handles
  that correctly already.
- The palette (`CommandPalette.tsx`) renders `/name` entries from the same
  channel; after this plan it will also list extension commands in SDK mode
  automatically. If that surprises anyone visually, grouping is a UI polish
  task, not a data bug.
