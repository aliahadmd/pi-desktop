# Plan 011: Stop rendering FTS snippets as raw HTML — structured snippet segments

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> ```
> git diff --stat 21dc8aa..HEAD -- sidecar/app/indexer.py sidecar/app/main.py src/renderer/src/pages/SessionsPage.tsx sidecar/tests/test_indexer.py src/shared/pi.ts
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 — latent renderer XSS held back only by CSP
- **Effort**: M (spans Python + TS + contract)
- **Risk**: MED — changes a shipped API shape consumed by one page
- **Depends on**: none
- **Category**: security hardening (audit 4 finding H-3)
- **Planned at**: commit `21dc8aa`, 2026-08-23

## Why this matters

`SessionsPage` renders search hits with `dangerouslySetInnerHTML`. The HTML
comes from SQLite's `snippet(messages_fts, 4, '<mark>', '</mark>', '…', 24)`,
which **does not escape the underlying text** — it only interleaves `<mark>`
tags. The indexed text is verbatim session content: user prompts, assistant
output, tool arguments. Any markup in a matched message (`<img onerror=…>`,
`<svg onload=…>`, `<iframe …>`) is injected into the DOM verbatim.

The renderer CSP (`script-src 'self'`, no `unsafe-inline`) blocks inline
handlers and external scripts today, so exploitation is currently contained.
But defense then rests entirely on that one header never loosening — while the
rest of the codebase deliberately routes untrusted text through escaping layers
(react-markdown without rehype-raw, anchor allowlisting). This path bypasses
the project's own discipline. Fix it at the source: return *data*, render in
React.

## Current state

### Sidecar emits HTML

`sidecar/app/indexer.py:162-177`:

```python
    sql = """
        SELECT messages_fts.session_id AS session_id,
               messages_fts.entry_id AS entry_id,
               messages_fts.role AS role,
               snippet(messages_fts, 4, '<mark>', '</mark>', '…', 24) AS snippet,
               s.cwd AS cwd, s.name AS session_name
        FROM messages_fts
        LEFT JOIN sessions s ON s.id = messages_fts.session_id
        WHERE messages_fts MATCH ?
    """
```

### Manager relays it typed as a plain string

`src/main/sidecar/manager.ts:19-26`:

```ts
export interface SearchHit {
	session_id: string | null;
	entry_id: string;
	role: string;
	snippet: string;
	cwd: string | null;
	session_name: string | null;
}
```

### Renderer injects it

`src/renderer/src/pages/SessionsPage.tsx:220-238`:

```tsx
		{hits.slice(0, 10).map((hit) => (
			<button …>
				<div
					className="text-xs text-neutral-300 [&_mark]:bg-blue-900 [&_mark]:text-blue-200"
					dangerouslySetInnerHTML={{ __html: hit.snippet }}
				/>
```

(The `[&_mark]:…` Tailwind selectors are how the highlight is styled — keep an
equivalent style hook after the refactor.)

Also duplicated: `SidecarSearchHit` in `src/shared/pi.ts:675-682` mirrors the
manager's shape.

## Target design

SQLite's `snippet()` supports custom delimiters. Use control-delimited plain
text instead of HTML, split it into segments in the sidecar, and ship a
structured array:

```jsonc
// GET /search → SearchHit[]
{
  "session_id": "…",
  "entry_id": "…",
  "role": "user",
  "cwd": "…",
  "session_name": "…",
  // NEW: replaces `snippet`
  "segments": [
    { "text": "before the match ", "match": false },
    { "text": "matched words",      "match": true },
    { "text": " after",             "match": false }
  ]
}
```

Every `text` value is raw, unescaped, unmarked content. The renderer maps
segments to `<span>`/`<mark>` elements. No `dangerouslySetInnerHTML` remains,
and the XSS class disappears regardless of CSP.

Compatibility note: the sidecar is versioned and launched by this app only
(manager + PyInstaller binary built from this repo), so there is no
back-compat constraint — but the two must ship together, which the drift check
and the e2e/unit gates cover.

## Repo conventions to match

- Sidecar owns only its tables; core tables read-only (unchanged here).
- Python: mypy strict must stay clean; pytest suite stays green.
- `src/shared/pi.ts`: no node/electron imports; response types updated in place.
- Renderer: no new escape hatches; prefer pure helpers under `lib/`.
- One test file per concern: extend `sidecar/tests/test_indexer.py`;
  create `tests/unit/snippet-segments.test.ts`.
- Conventional commits; do not push or open PRs.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Sidecar tests | `cd sidecar && uv run pytest -q` | exit 0, 11 passed before your changes |
| Sidecar types | `cd sidecar && uv run mypy app/` | exit 0, no issues |
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | exit 0, 94 passed before your changes |

## Scope

**In scope**:

- `sidecar/app/indexer.py` (snippet query → segment split)
- `src/main/sidecar/manager.ts` (`SearchHit` type)
- `src/shared/pi.ts` (`SidecarSearchHit` type)
- `src/renderer/src/pages/SessionsPage.tsx` (render segments)
- `tests/unit/snippet-segments.test.ts` (new)
- `sidecar/tests/test_indexer.py` (extend)

**Out of scope** (do NOT touch):

- FTS schema, indexer write paths, `sanitize_query`.
- Any other `dangerouslySetInnerHTML` site (audit found exactly one).
- CSP headers — they stay as-is; defense in depth means both layers, not
  removing one because the other improved.
- The LIKE-fallback search path (main-process) — it never produced snippets.

## Git workflow

- Branch: `fix/011-snippet-segments`
- Suggested commits:
  - `feat(sidecar): return snippet segments instead of HTML`
  - `fix: render search snippets as React elements, not raw HTML`
- Do NOT push or open a PR.

## Steps

### Step 1: Sidecar — produce segments

In `sidecar/app/indexer.py`:

1. Change the SQL to use unlikely-in-content delimiters:

```python
snippet(messages_fts, 4, '\u001e', '\u001f', '…', 24) AS snippet_raw
```

   (ASCII record/group separators — never present in normalized indexed text.
   Keep the ellipsis `'…'` as the ellipsis marker.)

2. Add a pure function beside `search()`:

```python
def _split_snippet(raw: str) -> list[dict[str, object]]:
    """Split delimiter-marked snippet text into {text, match} segments."""
    out: list[dict[str, object]] = []
    for i, part in enumerate(raw.split("\x1e")):
        if part == "":
            continue
        # Odd occurrences of \x1f inside part mean the open/close pair was
        # cut by the snippet window; treat the whole chunk as unmatched.
        sub = part.split("\x1f")
        for j, seg in enumerate(sub):
            if seg == "":
                continue
            matched = len(sub) > 1 and j % 2 == 1
            out.append({"text": seg.replace("…", "…"), "match": matched})
    return out
```

   Simplify freely as long as: empty segments dropped, odd-index chunks between
   a matched pair flagged `match=True`, and the function is total (never throws
   on any input string). Note the `.replace` above is a placeholder — the
   intent is: leave all text byte-for-byte intact except the delimiter bytes
   you inserted yourself. If the ellipsis needs no handling, drop that line.

3. In `search()`'s row mapping, replace the `snippet` column with
   `"segments": _split_snippet(row["snippet_raw"])`. The returned dict shape
   feeds `SearchHit(**r)` in `main.py` unchanged otherwise.

**Verify**:
- `cd sidecar && uv run pytest -q tests/test_indexer.py` → existing tests fail
  on the removed `snippet` key — update them now per Step 2's test plan rather
  than keeping dual shapes. (If you'd rather keep both keys during transition,
  STOP — single-shape is the point of the fix.)

### Step 2: Extend sidecar tests

In `sidecar/tests/test_indexer.py` (follow its fixture pattern):

1. Update every assertion touching `snippet` → `segments`.
2. New cases:
   - `"snippets split into match segments"` — index content containing a known
     needle plus surrounding words; search; assert some segment has
     `match is True` whose text contains the needle, and neighbors are False.
   - `"markup in content stays inert"` — index a message containing
     `<img src=x onerror=alert(1)>`; search for it; assert no segment's text
     differs from the source substring (i.e., no escaping, no tag stripping —
     inertness comes from the transport being data, not from sanitization),
     and assert the literal string `"<img"` appears inside a segment `text`,
     never as bare HTML anywhere in the JSON top level.

**Verify**: `cd sidecar && uv run pytest -q` → all pass (≥13);
`uv run mypy app/` → clean.

### Step 3: Contract + manager types

- `src/shared/pi.ts` — redefine:

```ts
export interface SnippetSegment {
	text: string;
	match: boolean;
}

export interface SidecarSearchHit {
	session_id: string | null;
	entry_id: string;
	role: string;
	cwd: string | null;
	session_name: string | null;
	segments: SnippetSegment[];
}
```

- `src/main/sidecar/manager.ts` — mirror the same shape in its local
  `SearchHit` interface (or import the shared type; manager lives in main and
  may import from `../shared/pi`).

**Verify**: `npm run typecheck` → SessionsPage now errors (expected); proceed
to Step 4 to fix it.

### Step 4: Render segments in React

In `SessionsPage.tsx`, replace the `dangerouslySetInnerHTML` div:

```tsx
<div className="break-words text-xs text-neutral-300">
	{hit.segments.map((seg, i) =>
		seg.match ? (
			<mark key={i} className="rounded-sm bg-blue-900 px-0.5 text-blue-200">
				{seg.text}
			</mark>
		) : (
			<span key={i}>{seg.text}</span>
		)
	)}
</div>
```

(Visual parity with the old `[&_mark]` styling; adjust classes only if the old
look clearly differed.) Then sweep for leftovers.

**Verify**:
- `grep -n "dangerouslySetInnerHTML" src/renderer/src/pages/SessionsPage.tsx` → 0 matches
- `grep -rn "dangerouslySetInnerHTML" src/renderer/src/` → only
  `components/chat/Markdown.tsx` (shiki output, trusted local generation)
  remains.
- `npm run typecheck` → exit 0.

### Step 5: Unit test the render input contract + full gate

New `tests/unit/snippet-segments.test.ts` — test the pure mapping logic the
page uses. Extract nothing; simply assert against the shared type with sample
payloads mirroring the sidecar's output (keys, types). Two cases:

1. `"hit renders marks only around matched segments"` — build segments, run
   them through a tiny exported helper if you add one; if the JSX is inline,
   instead assert the source file no longer references
   `dangerouslySetInnerHTML` and does reference `hit.segments.map` (source-
   guard precedent from plan 002's dialog test).
2. `"no raw html field survives the contract"` — import `SidecarSearchHit`,
   construct a hit WITHOUT any `snippet` key (type-level), and grep
   `src/shared/pi.ts` to ensure the string `"snippet:"` no longer appears in
   the hit type block.

**Verify**: `npm test` → ≥96 passed; `npm run e2e` → 30 passed (sessions-page
flows exercise the changed render).

## Done criteria

ALL must hold:

- [ ] `cd sidecar && uv run pytest -q` green; `uv run mypy app/` clean
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with new tests passing
- [ ] `npm run e2e` exits 0, 30 passed
- [ ] `grep -rn "dangerouslySetInnerHTML" src/renderer/src/` → Markdown.tsx only
- [ ] Manual: run dev, open All-sessions sheet, search something present in a
      transcript — matches still highlight, layout intact
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 011 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The pinned SQLite build rejects `\u001e`/`\u001f` delimiters or the
  `snippet()` call errors — pick another control-char pair, but re-run the
  "markup inert" test explicitly; if no safe pair works, stop (fallback would
  be server-side manual construction, a bigger change).
- Existing e2e asserts on snippet HTML specifics (`<mark>` strings in DOM) —
  capture and report; updating those assertions belongs in this plan only if
  they check *highlight presence* (fine to port to the new markup), not if they
  encode the vulnerability.
- `main.py`'s `SearchHit(BaseModel)` requires fields you didn't anticipate
  (it will fail loudly at startup) — align the model with the new shape and
  continue; anything beyond renaming `snippet`→`segments` and typing it, stop.

## Maintenance notes

- When semantic/embedding search lands in the sidecar, emit the same
  `segments` shape from those scorers — the renderer should never learn about
  highlighting again.
- The remaining `dangerouslySetInnerHTML` in `Markdown.tsx` consumes shiki's
  locally generated HTML for code blocks; if shiki is ever fed non-local
  themes, revisit. Not actionable today.
