/**
 * Terminal tab selection arithmetic (audit H-6). Closing a tab must adjust the
 * active index, not merely clamp it.
 */
import { describe, expect, it } from "vitest";
import { nextActiveTerminalTab } from "../../src/renderer/src/lib/terminal-tabs";

describe("nextActiveTerminalTab", () => {
	it("shifts left when a tab before the active one closes", () => {
		expect(nextActiveTerminalTab(2, 0, 3)).toBe(1);
	});

	it("keeps the index when a tab after the active one closes", () => {
		expect(nextActiveTerminalTab(0, 2, 3)).toBe(0);
	});

	it("selects the left neighbour when the active tab closes", () => {
		expect(nextActiveTerminalTab(1, 1, 3)).toBe(1);
		expect(nextActiveTerminalTab(2, 2, 3)).toBe(1);
	});

	it("never goes negative", () => {
		expect(nextActiveTerminalTab(0, 0, 2)).toBe(0);
	});

	it("never exceeds the new last index", () => {
		expect(nextActiveTerminalTab(4, 4, 5)).toBe(3);
	});
});
