import { describe, expect, it } from "vitest";
import {
	DEFAULT_THEME_ID,
	REQUIRED_THEME_VARS,
	THEME_PRESETS,
	getPreset,
	isThemePresetId,
	shikiThemeFor,
} from "../../src/shared/theme";

describe("theme presets (phase 7)", () => {
	it("every preset defines all required vars", () => {
		for (const p of THEME_PRESETS) {
			for (const key of REQUIRED_THEME_VARS) {
				const v = p.vars[key];
				expect(v, `${p.id}.${key}`).toBeTruthy();
				expect(typeof v).toBe("string");
			}
		}
	});

	it("preset ids are unique and non-empty", () => {
		const ids = THEME_PRESETS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id.length).toBeGreaterThan(0);
	});

	it("includes the five requested presets", () => {
		const ids = THEME_PRESETS.map((p) => p.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				"pi-dark",
				"pi-light",
				"catppuccin-mocha",
				"solarized-light",
				"github-dark",
			]),
		);
	});

	it("isThemePresetId guards unknown ids", () => {
		expect(isThemePresetId("pi-dark")).toBe(true);
		expect(isThemePresetId("nope")).toBe(false);
		expect(isThemePresetId(42)).toBe(false);
	});

	it("getPreset falls back to the default for unknown ids", () => {
		expect(getPreset("nope").id).toBe(DEFAULT_THEME_ID);
	});

	it("shikiThemeFor maps every preset to a theme name", () => {
		for (const p of THEME_PRESETS) {
			expect(shikiThemeFor(p.id)).toBe(p.shiki);
			expect(p.shiki.length).toBeGreaterThan(0);
		}
	});
});
