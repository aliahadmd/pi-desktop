/**
 * Trust management (chapter 13): view/edit ~/.pi/agent/trust.json decisions
 * and render pi keybindings.json (read-only).
 */
import { useCallback, useEffect, useState } from "react";

interface TrustEntry {
	path: string;
	decision: "trusted" | "denied" | "cleared";
}

export function TrustPanel(): React.JSX.Element {
	const [entries, setEntries] = useState<TrustEntry[]>([]);
	const [keybindings, setKeybindings] = useState<string>("");
	const [tab, setTab] = useState<"trust" | "keys">("trust");
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		const trust = await window.piDesktop.invoke({ type: "pi.config.read", name: "trust" });
		if (trust.ok) {
			const raw = trust.data as Record<string, unknown>;
			setEntries(
				Object.entries(raw)
					.filter(([key]) => key !== "version")
					.map(([path, value]) => {
						// pi's TrustFile: Record<string, boolean | null>
						let decision: TrustEntry["decision"];
						if (value === true) decision = "trusted";
						else if (value === false) decision = "denied";
						else decision = "cleared";
						return { path, decision };
					})
			);
		} else {
			setError(trust.error.message);
		}
		const keys = await window.piDesktop.invoke({
			type: "pi.config.read",
			name: "keybindings",
		});
		if (keys.ok) {
			setKeybindings(JSON.stringify(keys.data, null, 2));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	async function setDecision(entryPath: string, decision: "trusted" | "denied" | "cleared"): Promise<void> {
		const raw = await window.piDesktop.invoke({ type: "pi.config.read", name: "trust" });
		if (!raw.ok) return;
		const content = { ...(raw.data as Record<string, unknown>) };
		// pi's ProjectTrustDecision: boolean | null (null/absent = cleared)
		if (decision === "trusted") content[entryPath] = true;
		else if (decision === "denied") content[entryPath] = false;
		else content[entryPath] = null;
		const result = await window.piDesktop.invoke({
			type: "pi.config.write_trust",
			content: JSON.stringify(content),
		});
		if (!result.ok) {
			setError(result.error.message);
			return;
		}
		await load();
	}

	return (
		<div className="h-full overflow-y-auto p-6">
			<div className="max-w-2xl">
				<div className="mb-4 flex gap-2">
					<button
						type="button"
						onClick={() => setTab("trust")}
						className={`rounded px-3 py-1 text-xs ${tab === "trust" ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
					>
						Project trust
					</button>
					<button
						type="button"
						onClick={() => setTab("keys")}
						className={`rounded px-3 py-1 text-xs ${tab === "keys" ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
					>
						Keybindings
					</button>
				</div>

				{error !== null && (
					<p className="mb-3 text-xs text-danger">{error}</p>
				)}

				{tab === "trust" && (
					<>
						<p className="mb-3 text-xs text-neutral-500">
							Trusted projects load .pi resources and packages automatically.
							Decisions live in ~/.pi/agent/trust.json.
						</p>
						{entries.length === 0 ? (
							<p className="text-xs text-neutral-600">No trust decisions recorded.</p>
						) : (
							entries.map((entry) => (
								<div
									key={entry.path}
									className="flex items-center gap-3 border-b border-neutral-800/60 py-2.5"
								>
									<span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-300">
										{entry.path}
									</span>
									<span
										className={`rounded px-1.5 py-0.5 text-[9px] ${
											entry.decision === "trusted"
												? "bg-success-soft text-success"
												: entry.decision === "denied"
													? "bg-danger-soft text-danger"
													: "bg-neutral-800 text-neutral-400"
										}`}
									>
										{entry.decision}
									</span>
									<button
										type="button"
										onClick={() => void setDecision(entry.path, "trusted")}
										className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-success-soft hover:text-success"
									>
										Trust
									</button>
									<button
										type="button"
										onClick={() => void setDecision(entry.path, "denied")}
										className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-danger-soft hover:text-danger"
									>
										Deny
									</button>
									<button
										type="button"
										onClick={() => void setDecision(entry.path, "cleared")}
										title="Clear decision (prompt again)"
										className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
									>
										Clear
									</button>
								</div>
							))
						)}
					</>
				)}

				{tab === "keys" && (
					<>
						<p className="mb-3 text-xs text-neutral-500">
							Read-only view of ~/.pi/agent/keybindings.json. Edit the file and restart
							sessions to apply.
						</p>
						{keybindings.length === 0 ? (
							<p className="text-xs text-neutral-600">
								No keybindings.json found — pi defaults are in effect.
							</p>
						) : (
							<pre className="rounded bg-app-bg p-4 font-mono text-[11px] whitespace-pre-wrap text-neutral-300">
								{keybindings}
							</pre>
						)}
					</>
				)}
			</div>
		</div>
	);
}
