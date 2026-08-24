/**
 * First-run onboarding: shown when no provider auth is configured.
 * Pick a provider → paste API key (or OAuth login) → done.
 */
import { useCallback, useEffect, useState } from "react";
import type { ProviderAuthInfo } from "../../../shared/pi";

export function Onboarding({
	onDone,
	onSkip,
}: {
	/** Configuration succeeded: the providers check alone governs future launches. */
	onDone(): void;
	/** Dismissed without configuring: the caller persists that choice. */
	onSkip(): void;
}): React.JSX.Element {
	const [providers, setProviders] = useState<ProviderAuthInfo[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		const result = await window.piDesktop.invoke({ type: "auth.providers" });
		if (!result.ok) return;
		const withLogin = result.data.providers.filter(
			(p) => p.authType !== "none" || p.modelCount > 0
		);
		setProviders(withLogin);
		setSelected((prev) => prev ?? withLogin[0]?.id ?? null);
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	async function finish(): Promise<void> {
		if (selected === null) return;
		setBusy(true);
		setError(null);
		try {
			const provider = providers.find((p) => p.id === selected);
			const isOAuth = provider?.authType === "oauth";
			let result;
			if (isOAuth && (key.trim().length === 0)) {
				result = await window.piDesktop.invoke({
					type: "auth.login",
					providerId: selected,
					authType: "oauth",
				});
			} else {
				result = await window.piDesktop.invoke({
					type: "auth.set_key",
					providerId: selected,
					key: key.trim(),
				});
			}
			if (!result.ok) {
				setError(result.error.message);
				return;
			}
			onDone();
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70">
			<div className="w-[480px] rounded-2xl border border-neutral-700 bg-neutral-900 p-6 shadow-2xl">
				<h2 className="text-lg font-semibold text-neutral-100">Welcome to Pi Desktop</h2>
				<p className="mt-1 text-xs text-neutral-400">
					Configure a provider to start using the agent. You can add more later in Models.
				</p>

				{error !== null && (
					<div className="mt-3 rounded border border-danger/40 bg-danger-soft/50 px-3 py-2 text-xs text-red-300">
						{error}
					</div>
				)}

				<h3 className="mt-5 mb-2 text-[10px] tracking-wide text-neutral-500 uppercase">
					Choose a provider
				</h3>
				<div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto">
					{providers.map((p) => (
						<button
							key={p.id}
							type="button"
							onClick={() => setSelected(p.id)}
							className={`flex items-center gap-2 rounded px-3 py-2 text-left ${
								selected === p.id ? "bg-accent-soft ring-1 ring-accent-line" : "hover:bg-neutral-800"
							}`}
						>
							<span
								className={`h-1.5 w-1.5 rounded-full ${p.configured ? "bg-green-500" : "bg-neutral-600"}`}
							/>
							<span className="text-sm text-neutral-200">{p.name}</span>
							<span className="ml-auto font-mono text-[9px] text-neutral-600">
								{p.authType === "oauth" ? "OAuth" : "API key"} · {p.modelCount} models
							</span>
						</button>
					))}
				</div>

				{selected !== null && providers.find((p) => p.id === selected)?.authType !== "oauth" && (
					<input
						type="password"
						value={key}
						onChange={(e) => setKey(e.target.value)}
						placeholder="Paste API key…"
						className="mt-4 w-full rounded border border-neutral-700 bg-app-bg px-3 py-2 text-sm outline-none focus:border-blue-500"
					/>
				)}

				<div className="mt-5 flex justify-end gap-2">
					<button
						type="button"
						onClick={onSkip}
						className="rounded px-3 py-2 text-xs text-neutral-500 hover:text-neutral-300"
					>
						Skip for now
					</button>
					<button
						type="button"
						disabled={busy || selected === null}
						onClick={() => void finish()}
						data-testid="onboard-finish"
						className="rounded bg-blue-600 px-4 py-2 text-xs font-medium text-on-accent hover:bg-blue-500 disabled:opacity-40"
					>
						{busy ? "Working…" : "Get started"}
					</button>
				</div>
			</div>
		</div>
	);
}
