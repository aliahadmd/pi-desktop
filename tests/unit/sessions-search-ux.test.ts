/**
 * Sessions page search UX (audit 6 L-15 + L-12): an FTS message-match hit
 * whose session the LIKE metadata search doesn't list used to be a dead
 * click; deleting a session left its hits behind; and the query effect fired
 * two IPCs per raw keystroke. Source pins (unit tests run in node, no jsdom).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PAGE = readFileSync(
	join(import.meta.dirname, "../../src/renderer/src/pages/SessionsPage.tsx"),
	"utf8"
);

describe("FTS hit handling (audit 6 L-15)", () => {
	it("openHit falls back to a full-index id lookup and errors when gone", () => {
		const at = PAGE.indexOf("async function openHit");
		expect(at).toBeGreaterThanOrEqual(0);
		const body = PAGE.slice(at, at + 900);
		expect(body).toContain("db.sessions.list");
		expect(body).toContain("no longer indexed");
	});

	it("deleting a session also drops its FTS hits", () => {
		const at = PAGE.indexOf("async function remove");
		expect(at).toBeGreaterThanOrEqual(0);
		expect(PAGE.slice(at, at + 700)).toContain("h.session_id !== session.id");
	});
});

describe("search debounce (audit 6 L-12)", () => {
	it("the query effect debounces keystrokes", () => {
		expect(PAGE).toContain("const debounce = setTimeout(() => {");
		expect(PAGE).toContain("}, 200);");
		expect(PAGE).toContain("clearTimeout(debounce)");
	});
});
