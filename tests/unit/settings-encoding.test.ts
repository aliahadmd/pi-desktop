import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The app.settings.set channel declares `value: Type.String()` holding a
 * JSON-encoded payload, and the main process runs JSON.parse on it. Passing a
 * bare string therefore throws in the store — and because that write is
 * wrapped in a guard that only logs, the setting silently never persists.
 * That is exactly how the theme preference was lost across restarts
 * ("Unexpected token 'p', \"pi-light\" is not valid JSON").
 */
describe("app.settings.set callers", () => {
	const srcRoot = resolve(__dirname, "../../src/renderer/src");

	function walk(dir: string): string[] {
		return readdirSync(dir).flatMap((name) => {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) return walk(full);
			return full.endsWith(".tsx") || full.endsWith(".ts") ? [full] : [];
		});
	}

	it("always JSON-encode the value", () => {
		const offenders: string[] = [];

		for (const file of walk(srcRoot)) {
			const text = readFileSync(file, "utf8");
			if (!text.includes("app.settings.set")) continue;

			// Inspect the object literal following each app.settings.set call.
			const re = /app\.settings\.set"[\s\S]{0,400}?value:\s*([^\n,]+)/g;
			for (const m of text.matchAll(re)) {
				const expr = (m[1] ?? "").trim();
				const encoded =
					expr.startsWith("JSON.stringify") || expr.includes("JSON.stringify");
				if (!encoded) {
					offenders.push(`${file.replace(srcRoot, "")}: value: ${expr}`);
				}
			}
		}

		expect(offenders, offenders.join("\n")).toEqual([]);
	});
});
