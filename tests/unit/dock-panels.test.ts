/**
 * Dock panel persistence (audit 6 M-28): panels used to unmount on every tab
 * switch — killing terminal PTYs and discarding the file explorer's editor
 * draft. Visited panels now stay mounted and are hidden with CSS; the visited
 * set resets only when the dock fully closes. Source pins (unit tests run in
 * node, no jsdom).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CHAT_PAGE = readFileSync(
	join(import.meta.dirname, "../../src/renderer/src/pages/ChatPage.tsx"),
	"utf8"
);

describe("dock panel persistence (audit 6 M-28)", () => {
	it("every visited panel stays mounted, hidden with CSS when inactive", () => {
		expect(CHAT_PAGE).toContain("visitedDockTabs");
		expect(CHAT_PAGE).toContain('visitedDockTabs.has("files")');
		expect(CHAT_PAGE).toContain('visitedDockTabs.has("review")');
		expect(CHAT_PAGE).toContain('visitedDockTabs.has("commands")');
		expect(CHAT_PAGE).toContain('visitedDockTabs.has("terminal")');
		expect(CHAT_PAGE).toContain('visitedDockTabs.has("tree")');
		expect(CHAT_PAGE).toContain('dockTab === "files" ? "h-full" : "hidden"');
		expect(CHAT_PAGE).toContain('dockTab === "review" ? undefined : "hidden"');
		expect(CHAT_PAGE).toContain('dockTab === "commands" ? "h-full" : "hidden"');
		expect(CHAT_PAGE).toContain('dockTab === "terminal" ? "flex h-full flex-col" : "hidden"');
		expect(CHAT_PAGE).toContain('dockTab === "tree" ? "h-full" : "hidden"');
	});

	it("the old unmount-on-switch conditionals are gone", () => {
		expect(CHAT_PAGE).not.toContain('{dockTab === "files" && <FileExplorer');
		expect(CHAT_PAGE).not.toContain('{dockTab === "review" && <ReviewQueue');
		expect(CHAT_PAGE).not.toContain('{dockTab === "commands" && <CommandsBrowser');
		expect(CHAT_PAGE).not.toContain('{dockTab === "tree" && <SessionTreePanel');
	});

	it("the visited set resets only when the dock fully closes", () => {
		const at = CHAT_PAGE.indexOf("if (dockTab !== prevDockTab)");
		expect(at).toBeGreaterThanOrEqual(0);
		const body = CHAT_PAGE.slice(at, at + 500);
		expect(body).toContain("if (dockTab === null) return new Set();");
		expect(body).toContain("next.add(dockTab)");
	});
});
