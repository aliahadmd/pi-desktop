import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cssVarName } from "../../src/renderer/src/lib/apply-theme";
import { REQUIRED_THEME_VARS, THEME_PRESETS } from "../../src/shared/theme";

/**
 * Regression guard for the camelCase/kebab-case split between the preset
 * objects and the stylesheet. Writing `--pi-surface2` while the CSS reads
 * `--pi-surface-2` silently left the dark defaults in force, so light
 * themes rendered near-black chips, borders, and inline code.
 */
describe("theme variable naming (phase 7)", () => {
	const css = readFileSync(
		resolve(__dirname, "../../src/renderer/src/index.css"),
		"utf8",
	);

	it("converts camelCase preset keys to kebab-case css names", () => {
		expect(cssVarName("bg")).toBe("--pi-bg");
		expect(cssVarName("surface2")).toBe("--pi-surface-2");
		expect(cssVarName("accentSoft")).toBe("--pi-accent-soft");
		expect(cssVarName("accentStrong")).toBe("--pi-accent-strong");
		expect(cssVarName("successSoft")).toBe("--pi-success-soft");
		expect(cssVarName("userBubble")).toBe("--pi-user-bubble");
	});

	it("every preset token is declared in index.css :root defaults", () => {
		for (const key of REQUIRED_THEME_VARS) {
			const name = cssVarName(key);
			expect(css, `${key} -> ${name} missing from index.css`).toContain(
				`${name}:`,
			);
		}
	});

	it("every preset defines every required token", () => {
		for (const preset of THEME_PRESETS) {
			for (const key of REQUIRED_THEME_VARS) {
				expect(preset.vars[key], `${preset.id}.${key}`).toBeTruthy();
			}
		}
	});
});
