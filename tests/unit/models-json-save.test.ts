/**
 * models.json save coherence (audit 6 L-11):
 *
 *  - The llama.cpp preset button deep-merges into the current document
 *    (behavioral — the merge is a pure lib function). The old handler threw
 *    uncaught on invalid JSON and top-level-spread away existing providers.
 *  - models.json.save refreshes the LIVE ModelRuntime in main, and the Models
 *    page reloads its provider/model lists after a successful save
 *    (source-level pins — the handler writes to the real agent dir, so a
 *    behavioral test would touch ~/.pi/agent).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LLAMA_CPP_PRESET, mergeLlamaCppPreset } from "../../src/renderer/src/lib/llama-preset";

const AUTH_TS = readFileSync(join(import.meta.dirname, "../../src/main/pi/auth.ts"), "utf8");
const MODELS_PAGE = readFileSync(
	join(import.meta.dirname, "../../src/renderer/src/pages/ModelsPage.tsx"),
	"utf8",
);

describe("mergeLlamaCppPreset (audit 6 L-11)", () => {
	it("starts from an empty document when nothing is loaded", () => {
		const result = mergeLlamaCppPreset(null);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const doc = JSON.parse(result.json) as { providers: Record<string, unknown> };
			expect(Object.keys(doc.providers)).toEqual(["llamacpp"]);
			expect(doc.providers["llamacpp"]).toMatchObject({ baseUrl: LLAMA_CPP_PRESET.baseUrl });
		}
	});

	it("preserves existing providers (deep merge, not top-level spread)", () => {
		const current = JSON.stringify({
			providers: {
				anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic", models: [{ id: "x" }] },
			},
		});
		const result = mergeLlamaCppPreset(current);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const doc = JSON.parse(result.json) as { providers: Record<string, unknown> };
			expect(Object.keys(doc.providers).sort()).toEqual(["anthropic", "llamacpp"]);
		}
	});

	it("preserves unrelated top-level keys", () => {
		const result = mergeLlamaCppPreset(JSON.stringify({ defaultProvider: "anthropic", providers: {} }));
		expect(result.ok).toBe(true);
		if (result.ok) {
			const doc = JSON.parse(result.json) as Record<string, unknown>;
			expect(doc["defaultProvider"]).toBe("anthropic");
		}
	});

	it("reports invalid JSON instead of throwing", () => {
		const result = mergeLlamaCppPreset("{not json");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("invalid JSON");
	});

	it("reports a non-object document instead of merging into it", () => {
		expect(mergeLlamaCppPreset("[1,2]").ok).toBe(false);
		expect(mergeLlamaCppPreset('"text"').ok).toBe(false);
	});

	it("repairs a non-object providers field rather than spreading it", () => {
		const result = mergeLlamaCppPreset(JSON.stringify({ providers: "oops" }));
		expect(result.ok).toBe(true);
		if (result.ok) {
			const doc = JSON.parse(result.json) as { providers: Record<string, unknown> };
			expect(Object.keys(doc.providers)).toEqual(["llamacpp"]);
		}
	});
});

describe("models.json.save coherence pins (audit 6 L-11)", () => {
	it("main refreshes the live ModelRuntime after the atomic write", () => {
		const handler = AUTH_TS.match(/router\.handle\("models\.json\.save"[\s\S]*?\n\t\t\}\);/);
		expect(handler).not.toBeNull();
		const body = handler?.[0] ?? "";
		const writeAt = body.indexOf("renameSync(tmp, target)");
		const refreshAt = body.indexOf("refresh(");
		expect(writeAt).toBeGreaterThanOrEqual(0);
		expect(refreshAt).toBeGreaterThan(writeAt);
		// Local file edit: no network round-trip.
		expect(body).toContain("allowNetwork: false");
	});

	it("the Models page reloads providers and models after a successful save", () => {
		const save = MODELS_PAGE.match(/models\.json\.save[\s\S]*?finally\(\(\) => setJsonSaving\(false\)\)/);
		expect(save).not.toBeNull();
		expect(save?.[0]).toContain("loadProviders()");
		expect(save?.[0]).toContain("loadModels(null)");
	});
});
