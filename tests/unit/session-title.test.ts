import { describe, expect, it } from "vitest";
import { titleFromPrompt } from "../../src/renderer/src/lib/session-title";

describe("titleFromPrompt", () => {
	it("returns the first non-empty line", () => {
		expect(titleFromPrompt("fix the login bug\n\nmore detail")).toBe("fix the login bug");
	});

	it("strips / and ! prefixes", () => {
		expect(titleFromPrompt("/compact now")).toBe("compact now");
		expect(titleFromPrompt("!ls -la")).toBe("ls -la");
	});

	it("returns empty for whitespace-only input", () => {
		expect(titleFromPrompt("   \n  ")).toBe("");
	});

	it("truncates long lines with an ellipsis", () => {
		const long = "a".repeat(80);
		const t = titleFromPrompt(long);
		expect(t.length).toBeLessThanOrEqual(48);
		expect(t.endsWith("…")).toBe(true);
	});
});
