/**
 * Models page: provider auth management + model catalog.
 */
import { useCallback, useEffect, useState } from "react";
import type { ModelCatalogEntry, ProviderAuthInfo } from "../../../shared/pi";
import { mergeLlamaCppPreset } from "../lib/llama-preset";

const SUBSCRIPTION_COPY: Record<string, string> = {
	"claude-pro-max":
		"Claude Pro/Max: third-party harness usage draws from extra usage and is billed per token.",
	openai_codex: "Requires a ChatGPT Plus or Pro subscription (Codex for OSS).",
	copilot:
		"GitHub Copilot: sign in with github.com or enter your Enterprise domain. Enable models via VS Code if you hit 'model not supported'.",
	xai: "xAI Gro/X subscription: choose 'Use a subscription' at login; API keys remain available.",
	openrouter:
		"OpenRouter: PKCE browser flow. On headless machines the browser cannot reach the loopback callback - paste the final redirect URL into the prompt instead.",
};

export function ModelsPage({
	sessionOpen = false,
	onUseWithSession,
	onUseInSession,
}: {
	sessionOpen?: boolean;
	onUseWithSession?(provider: string, modelId: string): void;
	onUseInSession?(provider: string, modelId: string): void;
}): React.JSX.Element {
	const [providers, setProviders] = useState<ProviderAuthInfo[]>([]);
	const [models, setModels] = useState<ModelCatalogEntry[]>([]);
	const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
	const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
	const [showModelsJson, setShowModelsJson] = useState(false);
	const [modelsJson, setModelsJson] = useState<string | null>(null);
	const [jsonSaving, setJsonSaving] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const loadProviders = useCallback(async (): Promise<void> => {
		const result = await window.piDesktop.invoke({ type: "auth.providers" });
		if (result.ok) setProviders(result.data.providers);
	}, []);

	const loadModels = useCallback(async (provider: string | null): Promise<void> => {
		const result = await window.piDesktop.invoke({
			type: "auth.models",
			...(provider !== null ? { provider } : {}),
		});
		if (result.ok) setModels(result.data.models);
	}, []);

	useEffect(() => {
		void loadProviders();
		void loadModels(null);
	}, [loadProviders, loadModels]);

	async function saveKey(providerId: string): Promise<void> {
		const key = keyDraft[providerId];
		if (key === undefined || key.trim().length === 0) return;
		setBusy(true);
		setError(null);
		try {
			const result = await window.piDesktop.invoke({
				type: "auth.set_key",
				providerId,
				key: key.trim(),
			});
			if (!result.ok) {
				setError(result.error.message);
				return;
			}
			setKeyDraft((prev) => ({ ...prev, [providerId]: "" }));
			setNotice(`API key saved for ${providerId}.`);
			await loadProviders();
		} finally {
			setBusy(false);
		}
	}

	async function removeKey(providerId: string): Promise<void> {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			// The envelope must be checked — a failed remove used to print the
			// same "removed" notice as a success (audit 6 M-25).
			const result = await window.piDesktop.invoke({ type: "auth.remove_key", providerId });
			if (!result.ok) {
				setError(result.error.message);
				return;
			}
			setNotice(`API key removed for ${providerId}.`);
			await loadProviders();
		} finally {
			setBusy(false);
		}
	}

	async function login(providerId: string, authType: "api_key" | "oauth"): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const result = await window.piDesktop.invoke({
				type: "auth.login",
				providerId,
				authType,
			});
			if (!result.ok) setError(result.error.message);
			else setNotice(`Login flow finished for ${providerId}.`);
			await loadProviders();
		} finally {
			setBusy(false);
		}
	}

	async function logout(providerId: string): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const result = await window.piDesktop.invoke({ type: "auth.logout", providerId });
			if (!result.ok) {
				setError(result.error.message);
				return;
			}
			await loadProviders();
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex h-full overflow-hidden">
			{/* Providers */}
			<div className="w-80 shrink-0 overflow-y-auto border-r border-neutral-800 p-3">
				<h3 className="mb-2 px-1 text-xs font-semibold tracking-wide text-neutral-400 uppercase">
					Providers
				</h3>
				{providers.map((p) => (
					<button
						key={p.id}
						type="button"
						onClick={() => setSelectedProvider(p.id)}
						className={`mb-1 block w-full rounded px-3 py-2 text-left ${
							selectedProvider === p.id ? "bg-neutral-800" : "hover:bg-neutral-900"
						}`}
					>
						<div className="flex items-center gap-2">
							<span
								className={`h-1.5 w-1.5 rounded-full ${p.configured ? "bg-green-500" : "bg-neutral-600"}`}
							/>
							<span className="text-sm text-neutral-200">{p.name}</span>
							<span className="ml-auto font-mono text-[9px] text-neutral-600">
								{p.modelCount}
							</span>
						</div>
						<div className="mt-0.5 text-[10px] text-neutral-500">
							{p.configured
								? `configured via ${p.source ?? p.authType}`
								: "not configured"}
						</div>
					</button>
				))}
			</div>

			{/* Detail */}
			<div className="flex-1 overflow-y-auto p-4">
				{error !== null && (
					<div className="mb-3 rounded border border-danger/40 bg-danger-soft/50 px-3 py-2 text-xs text-red-300">
						{error}
					</div>
				)}
				{notice !== null && (
					<div className="mb-3 rounded border border-success/40 bg-success-soft px-3 py-2 text-xs text-success">
						{notice}
					</div>
				)}

				{selectedProvider === null ? (
					<p className="text-sm text-neutral-600">Select a provider to manage auth.</p>
				) : (
					(() => {
						const provider = providers.find((pr) => pr.id === selectedProvider);
						if (provider === undefined) return null;
						return (
							<div>
								<h2 className="text-base font-semibold text-neutral-100">{provider.name}</h2>
								<p className="mt-0.5 font-mono text-[10px] text-neutral-500">
									{provider.id} · {provider.configured ? provider.source ?? "configured" : "not configured"}
								</p>
								{SUBSCRIPTION_COPY[provider.id] !== undefined && (
									<p className="mt-2 rounded border border-info/40 bg-info-soft px-3 py-1.5 text-[11px] text-app-text">
										{SUBSCRIPTION_COPY[provider.id]}
									</p>
								)}

								<div className="mt-4 flex flex-wrap items-center gap-2">
									<input
										type="password"
										value={keyDraft[selectedProvider] ?? ""}
										onChange={(e) =>
											setKeyDraft((prev) => ({ ...prev, [selectedProvider]: e.target.value }))
										}
										placeholder={`${provider.name} API key…`}
										className="w-72 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs outline-none focus:border-blue-500"
									/>
									<button
										type="button"
										disabled={busy || (keyDraft[selectedProvider]?.trim().length ?? 0) === 0}
										onClick={() => void saveKey(selectedProvider)}
										className="rounded bg-blue-600 px-3 py-1.5 text-xs text-on-accent hover:bg-blue-500 disabled:opacity-40"
									>
										Save key
									</button>
									{provider.configured && provider.authType === "api_key" && (
										<button
											type="button"
											disabled={busy}
											onClick={() => void removeKey(selectedProvider)}
											className="rounded bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
										>
											Remove key
										</button>
									)}
									{provider.authType === "oauth" || provider.usingOAuth ? (
										<>
											<button
												type="button"
												disabled={busy}
												onClick={() => void login(selectedProvider, "oauth")}
												className="rounded bg-info px-3 py-1.5 text-xs text-white hover:bg-info/80 disabled:opacity-40"
											>
												{provider.configured ? "Re-login (OAuth)" : "Login (OAuth)"}
											</button>
											{provider.configured && (
												<button
													type="button"
													disabled={busy}
													onClick={() => void logout(selectedProvider)}
													className="rounded bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
												>
													Logout
												</button>
											)}
										</>
									) : null}
								</div>

								<div className="mt-6 flex gap-2">
									<button
										type="button"
										onClick={() => {
											if (modelsJson !== null) {
												setShowModelsJson((v) => !v);
												return;
											}
											void window.piDesktop
												.invoke({ type: "models.json.get" })
												.then((r) => {
													if (r.ok) {
														setModelsJson(JSON.stringify(r.data, null, 2));
														setShowModelsJson(true);
													} else setError(r.error.message);
												});
										}}
										className="rounded bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
									>
										{showModelsJson ? "Hide models.json" : "Edit models.json"}
									</button>
									<button
										type="button"
										onClick={() => {
											// Deep-merge into the current document (audit 6 L-11):
											// existing providers survive, and invalid JSON in the
											// textarea is reported instead of thrown uncaught.
											const merged = mergeLlamaCppPreset(modelsJson);
											if (!merged.ok) {
												setError(merged.error);
												return;
											}
											setModelsJson(merged.json);
											setShowModelsJson(true);
										}}
										className="rounded bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
										title="Insert a llama.cpp router preset (merge)"
									>
										llama.cpp preset
									</button>
								</div>

								{showModelsJson && modelsJson !== null && (
									<div className="mt-3">
										<textarea
											value={modelsJson}
											onChange={(e) => setModelsJson(e.target.value)}
											rows={16}
											spellCheck={false}
											className="w-full rounded border border-neutral-700 bg-app-bg p-3 font-mono text-[11px] outline-none focus:border-blue-500"
										/>
										<div className="mt-2 flex items-center gap-2">
											<button
												type="button"
												disabled={jsonSaving}
												onClick={() => {
													setJsonSaving(true);
													try {
														JSON.parse(modelsJson); // validate before save
													} catch (e) {
														setError(`Invalid JSON: ${String(e)}`);
														setJsonSaving(false);
														return;
													}
													void window.piDesktop
														.invoke({ type: "models.json.save", content: modelsJson })
														.then((r) => {
															if (!r.ok) setError(r.error.message);
															else {
																// Main refreshes the live ModelRuntime on save
																// (audit 6 L-11); reload the page's lists so the
																// catalog edit is visible without a sheet reopen.
																setNotice("models.json saved — new sessions pick up the change immediately.");
																setShowModelsJson(false);
																void loadProviders();
																void loadModels(null);
															}
														})
														.finally(() => setJsonSaving(false));
												}}
												className="rounded bg-blue-600 px-3 py-1.5 text-xs text-on-accent hover:bg-blue-500 disabled:opacity-40"
											>
												Save models.json
											</button>
											<span className="text-[10px] text-neutral-600">
												Writes ~/.pi/agent/models.json. Open sessions keep their current model.
											</span>
										</div>
									</div>
								)}

								<h3 className="mt-6 mb-2 text-xs font-semibold tracking-wide text-neutral-400 uppercase">
									Models ({models.filter((m) => m.provider === selectedProvider).length})
								</h3>
								<table className="w-full text-left text-xs">
									<thead className="text-neutral-500">
										<tr>
											<th className="px-2 py-1">Model</th>
											<th className="px-2 py-1">Context</th>
											<th className="px-2 py-1">In $/Mtok</th>
											<th className="px-2 py-1">Out $/Mtok</th>
											<th className="px-2 py-1"></th>
										</tr>
									</thead>
									<tbody>
										{models
											.filter((m) => m.provider === selectedProvider)
											.map((m) => (
												<tr key={m.id} className="border-t border-neutral-800/60">
													<td className="px-2 py-1.5 text-neutral-200">
														{m.name}
														{m.reasoning && (
															<span className="ml-1.5 text-[9px] text-info">reasoning</span>
														)}
													</td>
													<td className="px-2 py-1.5 font-mono text-[10px] text-neutral-400">
														{(m.contextWindow / 1000).toFixed(0)}k
													</td>
													<td className="px-2 py-1.5 font-mono text-[10px] text-neutral-400">
														{m.inputCostPerMtok !== null ? `$${m.inputCostPerMtok.toFixed(2)}` : "—"}
													</td>
													<td className="px-2 py-1.5 font-mono text-[10px] text-neutral-400">
														{m.outputCostPerMtok !== null ? `$${m.outputCostPerMtok.toFixed(2)}` : "—"}
													</td>
												<td className="px-2 py-1.5">
													{sessionOpen && onUseInSession !== undefined && (
														<button
															type="button"
															data-testid={`use-in-session-${m.id}`}
															onClick={() => onUseInSession(m.provider, m.id)}
															className="mr-1 rounded bg-blue-700 px-2 py-0.5 text-[10px] text-on-accent hover:bg-blue-600"
															title="Apply to the open session now"
														>
															Use in session
														</button>
													)}
													<button
														type="button"
														onClick={() => onUseWithSession?.(m.provider, m.id)}
														className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-700"
														title="Set as default model for new sessions"
													>
														Set default
													</button>
												</td>
												</tr>
											))}
									</tbody>
								</table>
							</div>
						);
					})()
				)}
			</div>
		</div>
	);
}
