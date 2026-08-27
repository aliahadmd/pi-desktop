/**
 * Models page envelope checks (audit 6 M-25): a failed remove_key/logout used
 * to print the same success notice as a real one. Source pins (unit tests run
 * in node, no jsdom).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MODELS = readFileSync(
	join(import.meta.dirname, "../../src/renderer/src/pages/ModelsPage.tsx"),
	"utf8"
);

function bodyOf(startMarker: string, span = 800): string {
	const at = MODELS.indexOf(startMarker);
	expect(at).toBeGreaterThanOrEqual(0);
	return MODELS.slice(at, at + span);
}

describe("ModelsPage envelope checks (audit 6 M-25)", () => {
	it("removeKey surfaces failures and only notices on success", () => {
		const body = bodyOf("async function removeKey");
		expect(body).toContain("if (!result.ok)");
		expect(body).toContain("setError(result.error.message)");
		// The success notice must come AFTER the envelope check.
		expect(body.indexOf('setNotice(`API key removed')).toBeGreaterThan(
			body.indexOf("if (!result.ok)")
		);
	});

	it("logout checks the envelope too", () => {
		const body = bodyOf("async function logout");
		expect(body).toContain("if (!result.ok)");
		expect(body).toContain("setError(result.error.message)");
	});
});
