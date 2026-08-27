/**
 * llama.cpp preset merge for the Models page (audit 6 L-11). Kept pure — no
 * React, no Electron — so the unit suite can pin the merge semantics.
 *
 * The old click handler did `{ ...JSON.parse(modelsJson), ...preset }`: an
 * uncaught throw on invalid JSON, and a top-level spread that REPLACED the
 * user's whole `providers` object with the preset's single entry.
 */

/** The llama.cpp local-server template inserted by the "llama.cpp preset" button. */
export const LLAMA_CPP_PRESET = {
	baseUrl: "http://127.0.0.1:8080/v1",
	api: "openai-completions",
	apiKey: "llama",
	compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
	models: [{ id: "local-model" }],
} as const;

export type LlamaPresetMerge = { ok: true; json: string } | { ok: false; error: string };

/**
 * Deep-merge the preset into a models.json document: existing top-level keys
 * and existing providers survive; only `providers.llamacpp` is added/replaced.
 * Invalid JSON in the textarea is reported, never thrown.
 */
export function mergeLlamaCppPreset(current: string | null): LlamaPresetMerge {
	let base: Record<string, unknown> = {};
	if (current !== null) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(current);
		} catch (error) {
			return { ok: false, error: `current content is invalid JSON: ${String(error)}` };
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { ok: false, error: "current content is not a JSON object" };
		}
		base = parsed as Record<string, unknown>;
	}
	const existing = base["providers"];
	const providers =
		typeof existing === "object" && existing !== null && !Array.isArray(existing)
			? (existing as Record<string, unknown>)
			: {};
	return {
		ok: true,
		json: JSON.stringify(
			{ ...base, providers: { ...providers, llamacpp: { ...LLAMA_CPP_PRESET } } },
			null,
			2,
		),
	};
}
