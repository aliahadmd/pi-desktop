import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Audit 5 H-2: components kept reaching for raw Tailwind ramps (text-red-300,
 * bg-amber-950, …) that the theme remap in index.css did not cover, so light
 * presets rendered dark-theme colors — the exact breakage the token system
 * exists to prevent. This test fails when ANY component uses a color-ramp
 * utility that the stylesheet's `@theme inline` block does not map.
 */
describe("theme coverage: every color-ramp class used is remapped", () => {
	const srcRoot = join(__dirname, "../../src/renderer/src");
	const css = readFileSync(join(srcRoot, "index.css"), "utf8");

	function walk(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
			const full = join(dir, e.name);
			if (e.isDirectory()) return walk(full);
			return e.name.endsWith(".tsx") ? [full] : [];
		});
	}

	/** Ramps the remap intentionally does not own (semantic tokens instead). */
	const ALLOWED_RAMPS = new Set(["neutral", "purple"]);

	const UTILITY_RE =
		/\b(bg|text|border|ring|from|to|shadow)-(red|green|blue|amber|emerald|yellow|orange|rose|pink|fuchsia|violet|indigo|sky|cyan|teal|lime)-([0-9]{2,3})\b/g;

	it("maps every used step of every owned ramp in index.css", () => {
		// Collect every <ramp>-<step> referenced by any component.
		const used = new Map<string, Set<string>>();
		for (const file of walk(srcRoot)) {
			const text = readFileSync(file, "utf8");
			for (const m of text.matchAll(UTILITY_RE)) {
				const ramp = `${m[2]}`;
				const step = m[3] ?? "";
				if (ALLOWED_RAMPS.has(ramp)) continue;
				const set = used.get(ramp) ?? new Set<string>();
				set.add(step);
				used.set(ramp, set);
			}
		}
		expect(used.size).toBeGreaterThan(0); // sanity: the scan actually saw classes

		for (const [ramp, steps] of used) {
			for (const step of steps) {
				expect(
					css.includes(`--color-${ramp}-${step}:`),
					`--color-${ramp}-${step} is used by components but not mapped in index.css @theme inline`,
				).toBe(true);
			}
		}
	});
});
