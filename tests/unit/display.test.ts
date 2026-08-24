import { describe, expect, it } from "vitest";
import { clampScale, SCALES } from "../../src/shared/display";

describe("ui scale (phase 7)", () => {
	it("accepts every advertised scale", () => {
		for (const s of SCALES) expect(clampScale(s)).toBe(s);
	});

	it("falls back to 100% for junk", () => {
		expect(clampScale("big")).toBe(1);
		expect(clampScale(null)).toBe(1);
		expect(clampScale(2)).toBe(1);
	});
});
