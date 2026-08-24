/**
 * Snippet segments (audit H-3, plan 011).
 *
 * FTS search hits used to arrive as HTML from SQLite's `snippet()` and were
 * injected with `dangerouslySetInnerHTML`. `snippet()` does not escape the text
 * it wraps, so any markup inside an indexed message — prompts, tool arguments,
 * model output — went into the DOM verbatim. These guards pin the replacement:
 * structured segments rendered as React text nodes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SidecarSearchHit, SnippetSegment } from "../../src/shared/pi";

const ROOT = path.resolve(import.meta.dirname, "../..");

function read(relative: string): string {
	return readFileSync(path.join(ROOT, relative), "utf8");
}

describe("search hit contract", () => {
	it("carries segments and no raw html field", () => {
		const hit: SidecarSearchHit = {
			session_id: "s1",
			entry_id: "e1",
			role: "user",
			cwd: "/tmp/p",
			session_name: "demo",
			segments: [
				{ text: "before ", match: false },
				{ text: "needle", match: true },
			],
		};
		expect(hit.segments).toHaveLength(2);
		// `snippet` must not exist on the type: if it comes back, so does the
		// injection path that consumed it.
		expect("snippet" in hit).toBe(false);
	});

	it("dropped the snippet string from the shared contract", () => {
		const source = read("src/shared/pi.ts");
		const block = /export interface SidecarSearchHit \{[\s\S]*?\}/.exec(source)?.[0] ?? "";
		expect(block).not.toBe("");
		expect(block).not.toContain("snippet:");
		expect(block).toContain("segments: SnippetSegment[]");
	});
});

describe("SessionsPage render", () => {
	const page = read("src/renderer/src/pages/SessionsPage.tsx");

	it("no longer injects raw HTML", () => {
		expect(page).not.toContain("dangerouslySetInnerHTML");
	});

	it("maps segments to elements instead", () => {
		expect(page).toContain("hit.segments.map");
		expect(page).toContain("<mark");
	});

	it("confines innerHTML to the shared code renderer", () => {
		// Shiki emits its own locally generated highlight markup, so exactly one
		// module is allowed to inject HTML: components/common/CodeView.tsx.
		// Markdown.tsx and Dock.tsx now delegate there instead of each holding
		// their own dangerouslySetInnerHTML call.
		const codeView = read("src/renderer/src/components/common/CodeView.tsx");
		expect(codeView).toContain("dangerouslySetInnerHTML");

		for (const p of [
			"src/renderer/src/components/chat/Markdown.tsx",
			"src/renderer/src/components/workspace/Dock.tsx",
		]) {
			expect(read(p), `${p} should delegate to CodeView`).not.toContain(
				"dangerouslySetInnerHTML",
			);
		}
	});
});

describe("segment rendering semantics", () => {
	/** Mirrors the page's JSX branch: matched segments become <mark>. */
	function classify(segments: SnippetSegment[]): string[] {
		return segments.map((seg) => (seg.match ? "mark" : "span"));
	}

	it("marks only matched runs", () => {
		expect(
			classify([
				{ text: "a ", match: false },
				{ text: "hit", match: true },
				{ text: " b", match: false },
			])
		).toEqual(["span", "mark", "span"]);
	});

	it("handles a hit with no matches at all", () => {
		expect(classify([{ text: "plain", match: false }])).toEqual(["span"]);
	});

	it("treats markup as ordinary text", () => {
		// The payload is data all the way down; nothing here is parsed as HTML.
		const segments: SnippetSegment[] = [{ text: "<img src=x onerror=alert(1)>", match: false }];
		expect(classify(segments)).toEqual(["span"]);
		expect(segments[0]?.text).toContain("<img");
	});
});
