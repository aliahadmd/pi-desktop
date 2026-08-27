/**
 * Create-error routing (audit 6 M-18): the empty-state error box only renders
 * when NO session is open, so a failed session create with a live session
 * used to vanish. Failures now route to the active session's transcript.
 * Source pins (unit tests run in node, no jsdom).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CHAT_PAGE = readFileSync(
	join(import.meta.dirname, "../../src/renderer/src/pages/ChatPage.tsx"),
	"utf8"
);

describe("create-error routing (audit 6 M-18)", () => {
	it("reportCreateError routes to the transcript when a session is active", () => {
		const at = CHAT_PAGE.indexOf("function reportCreateError");
		expect(at).toBeGreaterThanOrEqual(0);
		const body = CHAT_PAGE.slice(at, at + 300);
		expect(body).toContain("pushErrorNotice(activeId, message)");
		expect(body).toContain("setCreateError(message)");
	});

	it("both create-path failures go through it (pick + create)", () => {
		expect(CHAT_PAGE).toContain("reportCreateError(`Directory pick failed:");
		expect(CHAT_PAGE).toContain("session failed: ${result.error.message}");
	});
});
