# Plan 003: Anchor four absolutely-positioned elements to their intended parents

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> ```
> git diff --stat 02fbaf0..HEAD -- src/renderer/src/components/shell/Sidebar.tsx src/renderer/src/components/chat/Composer.tsx src/renderer/src/pages/ChatPage.tsx src/renderer/src/components/shell/Sheet.tsx src/renderer/src/App.tsx
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (can run in parallel with 002, but see "Merge note")
- **Category**: bug
- **Planned at**: commit `02fbaf0`, 2026-08-22

## Why this matters

Four elements use Tailwind's `absolute` class without any positioned ancestor.
In CSS, `position: absolute` resolves against the nearest ancestor with a
`position` other than `static`; when there is none, it resolves against the
**initial containing block — the whole viewport**. So four pieces of UI that
were meant to sit inside a sidebar, a button, or the composer are instead
placed against the window.

The worst is the collapsed sidebar's drag strip. It carries
`-webkit-app-region: drag`, and drag regions **swallow mouse events**, so it
does not merely look wrong — it makes the top 40px of the entire window
unclickable. That band is exactly where ChatPage renders its session-tab strip.
The sidebar auto-collapses below 900px window width while the window's
`minWidth` is 860px, so ordinary resizing reaches this state.

After this plan, each element is anchored where it was designed to be, and the
one place that currently depends on the buggy behavior is made explicit so a
future `relative` cannot silently break it.

## Current state

### Site 1 — `Sidebar.tsx:143`, the rail drag strip (worst)

The collapsed-rail branch renders:

```tsx
		return (
			<div
				className="flex h-full flex-col items-center gap-2 border-r border-neutral-800 bg-neutral-950/60 pt-10"
				style={{ width: "var(--sidebar-rail-w)" }}
			>
				<div className="titlebar-drag absolute left-0 top-0 h-10 w-full" />
```

The wrapper has no `relative`. `--sidebar-rail-w` is `56px`
(`src/renderer/src/index.css`). The strip should cover the top 40px of that
56px rail; instead it covers the top 40px of the window at full width.

`titlebar-drag` is defined in `src/renderer/src/index.css`:

```css
.titlebar-drag {
	-webkit-app-region: drag;
}
.titlebar-nodrag {
	-webkit-app-region: no-drag;
}
```

The window uses `titleBarStyle: "hiddenInset"` with
`trafficLightPosition: { x: 16, y: 16 }` (`src/main/windows/main.ts`), which is
why a manual drag region exists at all.

### Site 2 — `Composer.tsx:182`, the drag-and-drop overlay

```tsx
	return (
		<div
			className="px-3 pb-3"
			onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
			onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
			onDrop={(e) => { … }}
		>
			{dragging && (
				<div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-500 bg-blue-950/30 text-sm text-blue-300">
					Drop files here…
				</div>
			)}
```

The `px-3 pb-3` wrapper is not positioned, so `inset-0` covers the whole main
column — transcript included — instead of the composer. The Phase-4 spec called
for a "drag-over overlay on entire composer".

### Site 3 — `ChatPage.tsx:270`, the review-count badge

Inside the icon-rail button map:

```tsx
										{label}
										{tab === "review" && reviewCount > 0 && (
											<span className="absolute ml-4 -mt-3 rounded-full bg-red-600 px-1 text-[8px] text-white">
												{reviewCount}
											</span>
										)}
									</button>
```

The `<button>` carries
`className="flex h-8 w-8 items-center justify-center rounded text-sm transition-standard …"`
— no `relative`. The badge escapes to `<main className="relative …">` and
floats near the top-left of the chat area.

### Site 4 — `Sidebar.tsx:344`, the session context menu

```tsx
			{menuFor !== null &&
				(() => {
					const target = sessions.find((s) => s.id === menuFor);
					if (target === undefined) return null;
					return (
						<div className="absolute bottom-16 left-3 right-3 rounded-lg border border-neutral-700 bg-neutral-900 p-1 shadow-xl">
```

The expanded-sidebar wrapper (`Sidebar.tsx:168-172`) is
`className="flex h-full flex-col border-r border-neutral-800 bg-neutral-950/60"`
with `style={{ width: "var(--sidebar-w)" }}` — not positioned. So
`left-3 right-3` spans nearly the full window width, 64px above the bottom of
the window, rather than sitting inside the 260px sidebar.

### The one place that depends on this bug — `Sheet.tsx:46`

```tsx
				<motion.div
					className="absolute inset-0 z-40 flex flex-col bg-[#141416]"
```

Sheets are rendered in `App.tsx` as direct children of the root
`<div className="flex h-full overflow-hidden">`, which is **also** unpositioned.
Here the viewport-relative result is exactly what is wanted: the header comment
says "FULL-WINDOW surface — the app has hiddenInset traffic lights and no real
titlebar, so the sheet owns the whole window."

So `Sheet` works **by accident**. Adding `relative` to the App root — a natural
future change — would silently break every sheet. This plan makes the intent
explicit.

### Correct example to follow — `StatusBar.tsx:70-73`

The thinking-level dropdown does it right:

```tsx
			<span className="relative">
				<button … >thinking: {session.thinkingLevel ?? "off"}</button>
				{open && (
					<div className="absolute bottom-6 left-0 z-10 rounded border border-neutral-700 bg-neutral-900 py-1 shadow-xl">
```

Match this pattern: the anchor gets `relative`, the floating child stays
`absolute`.

### Repo conventions

- Tailwind 4 utility classes, no CSS modules. Class strings are ordered roughly
  layout → box → color → state; keep new classes in the same neighborhood.
- Tabs for indent, double-quoted strings.
- **Strict TypeScript**; `npm run typecheck` runs both `tsconfig.web.json` and
  `tsconfig.node.json`.
- Two elements deliberately opt **out** of dragging with `titlebar-nodrag` —
  see `Sheet.tsx:56`. Reuse that class rather than inventing another mechanism.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | exit 0, 53 passed |
| E2E | `npm run e2e` | exit 0, 30 passed |
| Dev app (manual check) | `npm run dev` | window opens |

## Scope

**In scope**:

- `src/renderer/src/components/shell/Sidebar.tsx` — sites 1 and 4 only
- `src/renderer/src/components/chat/Composer.tsx` — site 2 only
- `src/renderer/src/pages/ChatPage.tsx` — site 3 only
- `src/renderer/src/components/shell/Sheet.tsx` — make the full-window intent explicit
- `tests/unit/regressions.test.ts` (extend)

**Out of scope** (do NOT touch, even though they look related):

- `src/renderer/src/App.tsx` — do **not** add `relative` to the root div. Sheets
  and `DialogModal` currently resolve against the viewport and `<main>`
  respectively; changing the root's positioning is a layout change with a much
  wider blast radius than this plan.
- `DialogModal.tsx:21` (`absolute inset-0 z-50`) — it resolves against
  `<main className="relative">`, which is the intended full-pane modal. Correct
  as-is; leave it.
- `ChatPage.tsx:467` / `:537` compact-dialog overlays — same situation
  (`<main>`-relative, intended), and one of them is being deleted by plan 002.
  Do not touch either.
- The stale-closure search bug, the duplicated modal, the sound wiring — all
  plan 002. You are editing the same files; leave those lines alone.
- Any change to `index.css` motion tokens or the `titlebar-drag` rule itself.

## Git workflow

- Branch: `advisor/003-absolute-positioning`
- Single commit is fine: `fix: anchor absolutely-positioned UI to its intended parents`
- Do NOT push or open a PR.

### Merge note

Plans 002 and 003 both edit `Sidebar.tsx`, `Composer.tsx` and `ChatPage.tsx`,
but at different lines. If 002 has already landed, rebase on it first and expect
`ChatPage.tsx` line numbers **after ~466 to have shifted up by ~31 lines** (002
deletes the duplicated compact dialog). Site 3 at line 270 is above that point
and is unaffected.

## Steps

### Step 1: Anchor the rail drag strip (site 1)

In `src/renderer/src/components/shell/Sidebar.tsx`, add `relative` to the
collapsed-rail wrapper's class list:

```tsx
				className="relative flex h-full flex-col items-center gap-2 border-r border-neutral-800 bg-neutral-950/60 pt-10"
```

Leave the inner `<div className="titlebar-drag absolute left-0 top-0 h-10 w-full" />`
unchanged — once the parent is positioned, `w-full` correctly means "the 56px
rail" and the strip stops covering the window.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n 'className="relative flex h-full flex-col items-center' src/renderer/src/components/shell/Sidebar.tsx` → one match

### Step 2: Anchor the session context menu (site 4)

Add `relative` to the expanded-sidebar wrapper (`Sidebar.tsx:168-172`):

```tsx
		<div
			className="relative flex h-full flex-col border-r border-neutral-800 bg-neutral-950/60"
			style={{ width: "var(--sidebar-w)" }}
			data-testid="sidebar"
		>
```

The menu at line 344 keeps `absolute bottom-16 left-3 right-3` and will now
sit inside the 260px sidebar as designed.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c 'data-testid="sidebar"' src/renderer/src/components/shell/Sidebar.tsx` → `1`

### Step 3: Anchor the drop overlay to the composer (site 2)

In `src/renderer/src/components/chat/Composer.tsx`, add `relative` to the
outer wrapper:

```tsx
		<div
			className="relative px-3 pb-3"
```

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n 'className="relative px-3 pb-3"' src/renderer/src/components/chat/Composer.tsx` → one match

### Step 4: Anchor the review badge (site 3)

In `src/renderer/src/pages/ChatPage.tsx`, add `relative` to the icon-rail
button's className (the `.map()` over the four rail entries):

```tsx
										className={`relative flex h-8 w-8 items-center justify-center rounded text-sm transition-standard ${
```

Then fix the badge itself. `ml-4 -mt-3` were margin hacks compensating for the
broken anchor; with a real positioned parent, use corner offsets instead:

```tsx
											<span className="absolute -right-0.5 -top-0.5 rounded-full bg-red-600 px-1 text-[8px] leading-tight text-white">
```

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "absolute ml-4 -mt-3" src/renderer/src/pages/ChatPage.tsx` → `0`

### Step 5: Make the Sheet's full-window layout explicit

In `src/renderer/src/components/shell/Sheet.tsx:46`, change `absolute` to
`fixed` so the sheet is anchored to the viewport **by declaration** rather than
by the absence of a positioned ancestor:

```tsx
					className="fixed inset-0 z-40 flex flex-col bg-[#141416]"
```

Add a short comment above it recording why:

```tsx
					/* fixed, not absolute: the sheet is a full-window surface and must not
					   depend on the App root staying unpositioned. */
```

`fixed` and `absolute` render identically here today; the difference is that
`fixed` keeps working if anyone later adds `relative` to an ancestor.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "fixed inset-0 z-40" src/renderer/src/components/shell/Sheet.tsx` → one match
- `npm run e2e` → exit 0, 30 passed. The sheet e2e tests
  (`tests/e2e/ui-store.e2e.ts` opens and closes the sessions sheet) are the real
  check that this step did not change behavior.

### Step 6: Manual visual confirmation

Automated tests cannot see layout. Run `npm run dev` and confirm all four:

1. **Collapsed sidebar / drag strip** — narrow the window below 900px so the
   sidebar collapses to the rail. Open two or more sessions so the tab strip
   renders. **Click a session tab.** Before this plan the click was swallowed;
   it must now switch sessions. Also confirm the window can still be dragged by
   the rail's top area.
2. **Drop overlay** — drag a file over the composer. The dashed "Drop files
   here…" box must cover only the composer, not the transcript.
3. **Review badge** — trigger an edit or write tool so `reviewCount > 0`. The
   red count must sit on the 🔍 rail button's top-right corner.
4. **Context menu** — right-click a session in the expanded sidebar. The menu
   must appear inside the sidebar column, not spanning the window.

**Verify**: all four behave as described. If item 1 still swallows clicks, that
is a STOP condition.

## Test plan

Layout is not unit-testable here (no jsdom setup for these components, and the
bug is CSS-cascade behavior rather than logic). Add **source-level guards** to
`tests/unit/regressions.test.ts` instead — cheap, and they catch reintroduction,
which is the realistic failure mode.

Follow the file's existing style: each `it()` names a specific past bug, reads
source with `node:fs` where behavioral testing is impractical.

1. `"rail drag strip has a positioned ancestor"` — read `Sidebar.tsx`, assert
   the string `"relative flex h-full flex-col items-center"` is present.
2. `"expanded sidebar is positioned for its context menu"` — assert
   `"relative flex h-full flex-col border-r"` is present.
3. `"composer wrapper is positioned for the drop overlay"` — read
   `Composer.tsx`, assert `'className="relative px-3 pb-3"'` is present.
4. `"review badge no longer uses margin-hack positioning"` — read
   `ChatPage.tsx`, assert `"absolute ml-4 -mt-3"` is **absent**.
5. `"sheet is viewport-fixed, not ancestor-dependent"` — read `Sheet.tsx`,
   assert `"fixed inset-0 z-40"` is present and `"absolute inset-0 z-40"` is
   absent.

**Verification**: `npm test` → exit 0, `58 passed` (53 existing + 5 new).

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with 5 new tests passing
- [ ] `npm run e2e` exits 0, 30 passed
- [ ] `grep -c "absolute ml-4 -mt-3" src/renderer/src/pages/ChatPage.tsx` → `0`
- [ ] `grep -c "absolute inset-0 z-40" src/renderer/src/components/shell/Sheet.tsx` → `0`
- [ ] Manual check in step 6 passes all four items, especially clicking a
      session tab with the sidebar collapsed
- [ ] `src/renderer/src/App.tsx` is **unmodified** (`git status`)
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 003 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Adding `relative` to the sidebar wrappers visibly breaks the sidebar's own
  layout (the `AnimatePresence` width animation in `App.tsx:63-75` animates the
  wrapper around `Sidebar`, so a positioning change *could* interact with it).
  Report what broke rather than reverting to margin hacks.
- After step 1, clicking a session tab with the sidebar collapsed **still** does
  nothing. That means a second drag region is also covering the area — find it
  and report; do not start deleting drag regions, since the window must remain
  movable.
- `npm run e2e` fails on any sheet-related test after step 5.
- Any in-scope file no longer matches its "Current state" excerpt.
- You find yourself wanting to add `relative` to `App.tsx` — that is explicitly
  out of scope. Stop and report why you think it is needed.

## Maintenance notes

- **For the reviewer**: the rule to enforce going forward is simply *every
  `absolute` child needs a `relative` (or `fixed`) ancestor you can point at*.
  `StatusBar.tsx:70` is the exemplar. Worth calling out in review of any new
  floating UI — dropdowns, tooltips, badges, popovers.
- The `titlebar-drag` class is genuinely dangerous when mispositioned, because
  the failure is invisible: nothing renders, clicks just stop working. Any
  future drag region should be added only to elements with explicit bounds.
- Sheet now uses `fixed`. If someone later needs sheets scoped to a pane rather
  than the window, that is a deliberate redesign — switching it back to
  `absolute` without adding a positioned ancestor reintroduces the accident.
- **Deliberately deferred**: a Tailwind lint rule that flags `absolute` without
  a positioned ancestor. No such rule exists off the shelf and writing one is
  disproportionate; the five source-level guard tests cover the known sites.
