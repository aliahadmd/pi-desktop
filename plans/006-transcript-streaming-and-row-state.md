# Plan 006: Make the transcript follow streaming text and stop losing row state on scroll

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> ```
> git diff --stat 02fbaf0..HEAD -- src/renderer/src/components/chat/Transcript.tsx src/renderer/src/components/chat/Blocks.tsx src/renderer/src/stores/pi-sessions.ts
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: 002 should land first if it is going to — it edits
  `pi-sessions.ts`, which step 2 of this plan also touches. Not a logical
  dependency.
- **Category**: bug
- **Planned at**: commit `02fbaf0`, 2026-08-22

## Why this matters

Three defects in the transcript, all felt constantly because the transcript is
the app's main surface:

1. **The view does not follow streaming text.** The stick-to-bottom effect is
   keyed on the *number* of blocks, but streaming deltas mutate the last block's
   content without changing the count — so text runs off the bottom edge and the
   user scrolls by hand while the agent is mid-sentence. This is the single
   most-noticed rough edge in any chat UI.
2. **Rows lose their state when scrolled out of view.** Expanded tool output,
   opened thinking sections, and dismissed notices all live in `useState` inside
   rows rendered by a virtualizer. Rows unmount when they leave the overscan
   window, so scrolling up and back collapses everything you opened, and a
   dismissed notice comes back.
3. **Rows are keyed by index and replay their entrance animation.** Stable block
   `id`s exist and are ignored in favour of the virtualizer's default index key,
   which breaks reconciliation whenever blocks shift — and the store *does*
   shift them, by unshifting a trim notice once the transcript exceeds 2000
   blocks. Separately the `block-enter` animation is applied inline on every
   render, so recycled rows re-run the fade-and-rise while streaming.

After this plan: the transcript follows the text as it streams, opened rows stay
open, and rows animate in once rather than flickering.

## Current state

Files involved:

- `src/renderer/src/components/chat/Transcript.tsx` (80 lines) — virtualized
  list, stick-to-bottom, tool grouping
- `src/renderer/src/components/chat/Blocks.tsx` (279 lines) — the row
  components, each holding local UI state
- `src/renderer/src/stores/pi-sessions.ts` (349 lines) — Zustand session store

### Defect 1 — `Transcript.tsx:22-35`

```tsx
	const virtualizer = useVirtualizer({
		count: blocks.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 80,
		overscan: 8,
	});

	// Stick to bottom while streaming unless the user scrolled up.
	useEffect(() => {
		const el = parentRef.current;
		if (el === null || !stickToBottom.current) return;
		el.scrollTop = el.scrollHeight;
	}, [blocks.length, phase]);
```

`blocks.length` is stable during a single assistant response; only
`getTotalSize()` grows as `measureElement` remeasures the growing row.

The scroll-position tracker it depends on, `Transcript.tsx:37-42`:

```tsx
	function handleScroll(): void {
		const el = parentRef.current;
		if (el === null) return;
		stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	}
```

This part is correct — the 80px threshold means "the user is near the bottom",
and scrolling up disables auto-follow. Keep the behavior.

### Defect 2 — local state in virtualized rows, `Blocks.tsx`

Four instances:

```tsx
const ToolBlockView = memo(function ToolBlockView({ block }: { block: ToolBlock }) {
	const [expanded, setExpanded] = useState(block.status === "running");     // :52
```
```tsx
function ThinkingPartView({ text }: { text: string }): ReactNode {
	const [open, setOpen] = useState(false);                                  // :100
```
```tsx
const NoticeBlockView = memo(function NoticeBlockView({ block }: { block: NoticeBlock }) {
	const [dismissed, setDismissed] = useState(false);                        // :172
	if (dismissed) return null;
```
```tsx
const ToolGroupView = function ToolGroupView({ block, renderChild }) {
	const [expanded, setExpanded] = useState(block.status === "running");     // :121
```

Note `AssistantBlockView`'s `copied` flag (`Blocks.tsx:129`) is **also** local
state, but it is a 1200ms transient confirmation — losing it on scroll is
harmless. Leave it alone.

`ThinkingPartView` is a special case: it is rendered per *part* inside an
assistant block and has no id of its own. It will need one derived from its
parent block id plus the part index.

### Defect 3 — `Transcript.tsx:55-75`

```tsx
				<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
					{virtualizer.getVirtualItems().map((item) => {
						const block = blocks[item.index] as Block;
						return (
							<div
								key={`${block.kind}-${String(item.key)}`}
								data-index={item.index}
								ref={virtualizer.measureElement}
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									transform: `translateY(${item.start}px)`,
									animation: "block-enter var(--dur-med) var(--ease-standard)",
								}}
							>
								<BlockView block={block} onToolClick={noopToolClick} />
							</div>
						);
					})}
				</div>
```

`item.key` defaults to the index in `@tanstack/react-virtual`. Every `Block`
variant already carries a stable `id` (`src/renderer/src/lib/ingest.ts:26-63`).

The index-shifting the wrong key breaks — `pi-sessions.ts:102-110`:

```ts
			if (ctxCopy.blocks.length > MAX_BLOCKS) {
				const trimmed = ctxCopy.blocks.length - MAX_BLOCKS;
				ctxCopy.blocks = ctxCopy.blocks.slice(-MAX_BLOCKS);
				ctxCopy.blocks.unshift({
					kind: "notice",
					id: `trim-${Date.now()}`,
					text: `…${trimmed} earlier messages hidden`,
					level: "info",
				});
			}
```

`index.css` already defines both the keyframes and a class for the animation:

```css
@keyframes block-enter {
	from { opacity: 0; transform: translateY(8px); }
	to   { opacity: 1; transform: translateY(0); }
}
.animate-block-in {
	animation: block-enter var(--dur-med) var(--ease-standard);
}
```

Use `.animate-block-in`; do not add new CSS.

> **Caution**: the row's `transform: translateY(${item.start}px)` positions it,
> and `block-enter` also animates `transform`. The animation currently *fights*
> the positioning transform for its duration. Restricting the animation to the
> tail row (step 3) limits the blast radius; do not try to also animate
> positioned rows.

### Repo conventions

- **Zustand** for shared renderer state; the existing store is
  `src/renderer/src/stores/pi-sessions.ts`, created with
  `create<State>((set, get) => ({ … }))`. Components subscribe with a selector:
  `useSessions((s) => s.sessions)`.
- **Strict TypeScript**, `exactOptionalPropertyTypes` on: spread optional
  properties conditionally, never assign `undefined`.
- Tabs for indent, double-quoted strings.
- Row components are `memo(function Name…)`; keep that.
- `src/renderer/src/lib/ingest.ts` is **pure** (no React, no Electron) — that is
  what makes `tests/unit/ingest.test.ts` possible. **Do not import React into
  it and do not put UI state there.**

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | exit 0, 53 passed at baseline |
| Single file | `npx vitest --run tests/unit/ingest.test.ts` | exit 0 |
| E2E | `npm run e2e` | exit 0, 30 passed |
| Dev app | `npm run dev` | window opens |

## Scope

**In scope**:

- `src/renderer/src/components/chat/Transcript.tsx`
- `src/renderer/src/components/chat/Blocks.tsx`
- `src/renderer/src/stores/transcript-ui.ts` (create)
- `tests/unit/transcript-ui.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):

- `src/renderer/src/lib/ingest.ts` — the block model and reducer are correct.
  This plan changes how blocks are *rendered*, not how they are built. Keep it
  React-free.
- `src/renderer/src/stores/pi-sessions.ts` — read it for context, but put the
  new UI state in its **own** store (step 2). Do not add `expandedBlocks` to
  `SessionUi`: that object is rebuilt wholesale on every rAF flush
  (`pi-sessions.ts:120-128`), so UI state living there would churn on every
  streaming frame.
- `noopToolClick` / the dead tool-chip buttons (`Transcript.tsx:19-21`, audit
  finding M-6). Related, but a separate decision about what clicking should do.
- The `MAX_BLOCKS` trim behavior itself.
- `index.css` — the animation class you need already exists.

## Git workflow

- Branch: `advisor/006-transcript-streaming`
- Commits, conventional style (from `git log`: `fix: add hasInstallScript flag…`):
  - `fix: follow streaming text in the transcript`
  - `fix: keep transcript row state across virtualizer recycling`
  - `fix: key virtual rows by block id and animate only new rows`
- Do NOT push or open a PR.

## Steps

### Step 1: Follow streaming content, not just block count

In `Transcript.tsx`, change the stick-to-bottom effect to depend on the
virtualizer's measured total size, which grows as the streaming row is
remeasured:

```tsx
	const totalSize = virtualizer.getTotalSize();

	// Stick to bottom while streaming unless the user scrolled up. Depends on
	// totalSize (not blocks.length) because streaming grows the last row's
	// height without adding a block.
	useEffect(() => {
		const el = parentRef.current;
		if (el === null || !stickToBottom.current) return;
		el.scrollTop = el.scrollHeight;
	}, [totalSize, blocks.length, phase]);
```

Keep `blocks.length` and `phase` in the dependency list — a new block can arrive
without changing total size if measurement has not settled yet.

Use the same `totalSize` value for the spacer div rather than calling
`getTotalSize()` a second time:

```tsx
				<div style={{ height: totalSize, position: "relative" }}>
```

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "getTotalSize()" src/renderer/src/components/chat/Transcript.tsx` → `1`
- `grep -c "\[totalSize, blocks.length, phase\]" src/renderer/src/components/chat/Transcript.tsx` → `1`

### Step 2: Move row UI state into a dedicated store

Create `src/renderer/src/stores/transcript-ui.ts`. Requirements:

- A Zustand store holding two id sets, plus toggles.
- Keys are **globally unique per block**, so include the session id:
  `` `${sessionId}:${blockId}` ``. Two sessions can hold blocks with the same id
  (hydration generates `a-0`, `u-1`, … per session).
- Sets in Zustand must be replaced, not mutated, or subscribers will not
  re-render.

```ts
/**
 * Per-row transcript UI state (expanded / dismissed), kept outside the session
 * store because rows are virtualized: they unmount when scrolled out of view,
 * so local component state would be lost. Keyed `${sessionId}:${blockId}`.
 */
import { create } from "zustand";

interface TranscriptUiState {
	expanded: Set<string>;
	dismissed: Set<string>;
	isExpanded(key: string, fallback: boolean): boolean;
	toggleExpanded(key: string, fallback: boolean): void;
	isDismissed(key: string): boolean;
	dismiss(key: string): void;
	/** Drop all rows for a session when its tab closes. */
	clearSession(sessionId: string): void;
}
```

Notes on the `fallback` parameter: `ToolBlockView` and `ToolGroupView` default to
*expanded while running* and collapsed otherwise. Rather than pre-seeding the
set, treat "not present in the set" as the fallback value and have `toggle`
insert or remove relative to it. Implement `isExpanded(key, fallback)` as
"present in set XOR fallback" — that is, the set stores *deviations from the
default*, so a running tool that has never been clicked reads as expanded, and
one the user collapsed reads as collapsed even after remounting.

Add a `clearSession` call from `useSessions.close()` in `pi-sessions.ts` **only
if** you can do it without restructuring that function — it is a leak-prevention
nicety, not a correctness requirement. If it complicates the diff, skip it and
note it.

**Verify**:
- `npm run typecheck` → exit 0
- `npx vitest --run tests/unit/transcript-ui.test.ts` → passes (after step 5)

### Step 3: Key rows by block id and animate only the newest

In `Transcript.tsx`:

1. Give the virtualizer a stable key function:

```tsx
	const virtualizer = useVirtualizer({
		count: blocks.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 80,
		overscan: 8,
		getItemKey: (index) => blocks[index]?.id ?? `idx-${String(index)}`,
	});
```

2. Use that key directly and drop the composite:

```tsx
								key={item.key}
```

3. Remove `animation` from the inline `style` object and apply the existing CSS
   class to the tail row only:

```tsx
								className={
									item.index === blocks.length - 1 ? "animate-block-in" : undefined
								}
```

This keeps the "new message arrives" motion without re-running it on every
recycled row during scroll.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "getItemKey" src/renderer/src/components/chat/Transcript.tsx` → `1`
- `grep -c "animation: \"block-enter" src/renderer/src/components/chat/Transcript.tsx` → `0`
- `grep -c "animate-block-in" src/renderer/src/components/chat/Transcript.tsx` → `1`

### Step 4: Read row state from the store instead of `useState`

`BlockView` needs the session id to build keys. Thread it: `Transcript` takes a
new `sessionId: string` prop (passed from `ChatPage.tsx`, which renders
`<Transcript blocks={active.blocks} phase={active.phase} />` — add
`sessionId={active.id}`), and passes it to `BlockView`.

> `ChatPage.tsx` is **not** in this plan's scope list for edits beyond this one
> prop. Add the prop and change nothing else in that file.

Then in `Blocks.tsx`, replace the three persistent `useState` hooks with store
reads:

- `ToolBlockView` — key `` `${sessionId}:${block.id}` ``, fallback
  `block.status === "running"`.
- `ToolGroupView` — same, keyed on the group's `block.id`.
- `NoticeBlockView` — key `` `${sessionId}:${block.id}` ``, using
  `isDismissed` / `dismiss`.
- `ThinkingPartView` — it has no id. Pass one in from `AssistantBlockView` as
  `` `${sessionId}:${block.id}:think-${i}` `` where `i` is the part index it is
  already mapped with (`Blocks.tsx:132`). Fallback `false`.

Leave `AssistantBlockView`'s `copied` state as local `useState`.

Subscribe with selectors so a toggle re-renders only the affected row:

```tsx
	const expanded = useTranscriptUi((s) => s.isExpanded(key, fallback));
```

> If selector-based subscription over a `Set` causes re-render loops (Zustand
> compares by reference and `isExpanded` returns a boolean, so it should not),
> stop and report rather than switching the store to an object map without
> saying so.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "useState" src/renderer/src/components/chat/Blocks.tsx` → `1`
  (only `copied` remains)
- `npm test` → exit 0

### Step 5: Tests

See the test plan below, then run the full gate.

**Verify**:
- `npm test` → exit 0 with the new tests
- `npm run e2e` → exit 0, 30 passed

### Step 6: Manual verification (cannot be automated)

Run `npm run dev` and confirm:

1. **Follow while streaming** — send a prompt that produces a long answer. The
   view must stay pinned to the bottom as the text grows, without touching the
   scrollbar.
2. **Scroll-up releases the follow** — mid-stream, scroll up. The view must
   *stop* auto-scrolling. Scroll back to the bottom; following must resume.
3. **Row state survives scrolling** — expand a tool's output near the top of a
   long transcript, scroll to the bottom, scroll back. It must still be
   expanded.
4. **Dismissal sticks** — dismiss a notice, scroll past it and back. It must
   stay gone.
5. **No animation flicker** — during streaming, rows already on screen must not
   re-fade. Only a genuinely new block animates in.

If you are an executor without a display, SKIP this step and report it as
"requires human verification", listing the five checks. Do not claim it passed.

## Test plan

**`tests/unit/transcript-ui.test.ts`** (create; model the structure on
`tests/unit/store.test.ts`, which exercises a store directly without React):

1. `"defaults to the fallback when untouched"` — `isExpanded("a:1", true)` is
   `true`; `isExpanded("a:2", false)` is `false`.
2. `"toggling deviates from the fallback"` — `toggleExpanded("a:1", true)` then
   `isExpanded("a:1", true)` is `false`.
3. `"toggling twice returns to the fallback"`.
4. `"dismiss is sticky"` — `isDismissed("a:3")` false, `dismiss("a:3")`,
   then true.
5. `"keys are namespaced per session"` — `dismiss("s1:n1")` must not affect
   `isDismissed("s2:n1")`. This is the bug that a bare block id would cause.
6. `"clearSession drops only that session's rows"` (only if you implemented
   `clearSession`).

**Same file, `tests/unit/transcript-ui.test.ts`** — add these source-level
guards alongside the store tests above. Do **not** append them to
`tests/unit/regressions.test.ts`: three earlier plans all did that and produced
a three-way merge conflict whose hunks interleave badly. One test file per plan.

7. `"transcript follows streaming content, not just block count"` — read
   `Transcript.tsx`, assert it contains `[totalSize, blocks.length, phase]`.
8. `"virtual rows are keyed by block id"` — assert `getItemKey` is present and
   `` `${block.kind}-${String(item.key)}` `` is absent.
9. `"row state is not held in local component state"` — read `Blocks.tsx`,
   assert `useState` occurs exactly once (the `copied` flag).

**Verification**: `npm test` → exit 0, roughly `62 passed` (53 + 6 + 3).

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with the new tests passing
- [ ] `npm run e2e` exits 0, 30 passed
- [ ] `grep -c "useState" src/renderer/src/components/chat/Blocks.tsx` → `1`
- [ ] `grep -c "getItemKey" src/renderer/src/components/chat/Transcript.tsx` → `1`
- [ ] `grep -c 'animation: "block-enter' src/renderer/src/components/chat/Transcript.tsx` → `0`
- [ ] `src/renderer/src/lib/ingest.ts` is **unmodified** (`git status`)
- [ ] Manual step 6 passes, or is explicitly reported as unverified
- [ ] `git status` shows no modified files outside the in-scope list (plus the
      one-line `sessionId` prop addition in `ChatPage.tsx`)
- [ ] `plans/README.md` status row for 006 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Auto-follow fights the user: the view scrolls back to the bottom *after* the
  user has scrolled up. That means `stickToBottom` is being reset — report the
  observed behavior rather than removing the follow entirely.
- Subscribing to the new store causes an infinite re-render loop.
- `measureElement` and `getItemKey` interact badly — symptom is rows jumping or
  overlapping while scrolling a long transcript. This is a known sharp edge in
  virtualizers when keys and measurement caches disagree; report it, do not
  revert to index keys silently.
- You conclude that `ingest.ts` must change. It must not — the block model
  already has everything needed.
- Any in-scope file no longer matches its "Current state" excerpt.

## Maintenance notes

- **For the reviewer**: the subtle one is step 2's "set stores deviations from
  the default" design. Check test 5 specifically — a bare `block.id` key would
  make two sessions share dismissal state, which is the kind of bug that only
  shows up with two tabs open.
- The new store grows unboundedly across a long-lived app session unless
  `clearSession` is wired into tab close. Each entry is a short string, so this
  is a slow leak rather than a real one, but it is worth closing.
- If the transcript later gains a "collapse all" or "expand all" control, this
  store is where it belongs.
- **Deliberately deferred**: the dead tool-chip buttons (`noopToolClick`).
  Making them scroll to and expand the corresponding tool block would be a
  natural use of the new store — `toggleExpanded` plus
  `virtualizer.scrollToIndex` — but deciding what clicking *should* do is a
  design question, not a wiring one.
