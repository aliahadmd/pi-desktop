/**
 * Scoped-models editor: the cycle list behind the StatusBar model chip.
 */
import { useCallback, useEffect, useState } from "react";
import { piThinkingLevels } from "../../../shared/pi";

interface ScopedModel {
	provider: string;
	modelId: string;
	thinkingLevel?: string;
}

export function ScopedModelsEditor(): React.JSX.Element {
	const [models, setModels] = useState<ScopedModel[]>([]);
	const [saved, setSaved] = useState(false);

	const load = useCallback(async (): Promise<void> => {
		const result = await window.piDesktop.invoke({
			type: "session.scoped_models.get",
		});
		if (result.ok) setModels(result.data.models);
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	async function persist(next: ScopedModel[]): Promise<void> {
		setModels(next);
		await window.piDesktop.invoke({
			type: "session.scoped_models.set",
			models: next,
		});
		setSaved(true);
		setTimeout(() => setSaved(false), 1500);
	}

	function update(index: number, patch: Partial<ScopedModel>): void {
		void persist(models.map((m, i) => (i === index ? { ...m, ...patch } : m)));
	}

	return (
		<div>
			<div className="mb-2 flex items-center justify-between">
				<div>
					<div className="text-sm text-neutral-200">Scoped models (cycle list)</div>
					<div className="text-[10px] text-neutral-500">
						Click the model chip in the status bar to cycle through these.
					</div>
				</div>
				<button
					type="button"
					onClick={() =>
						void persist([...models, { provider: "anthropic", modelId: "", thinkingLevel: "medium" }])
					}
					className="rounded bg-neutral-800 px-2 py-1 text-[10px] text-neutral-300 hover:bg-neutral-700"
				>
					+ Add
				</button>
			</div>
			{saved && <div className="mb-2 text-[10px] text-green-400">Saved.</div>}
			{models.length === 0 ? (
				<p className="text-xs text-neutral-600">No scoped models yet.</p>
			) : (
				<div className="flex flex-col gap-1.5">
					{models.map((m, i) => (
						<div key={i} className="flex items-center gap-1.5">
							<input
								value={m.provider}
								onChange={(e) => update(i, { provider: e.target.value })}
								placeholder="provider"
								className="w-32 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-[11px] outline-none focus:border-blue-500"
							/>
							<input
								value={m.modelId}
								onChange={(e) => update(i, { modelId: e.target.value })}
								placeholder="model-id"
								className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-[11px] outline-none focus:border-blue-500"
							/>
							<select
								value={m.thinkingLevel ?? "inherit"}
								onChange={(e) => {
									const level = e.target.value;
									void persist(
										models.map((mm, j) =>
											j === i
												? level === "inherit"
													? { provider: mm.provider, modelId: mm.modelId }
													: { ...mm, thinkingLevel: level }
												: mm
										)
									);
								}}
								className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] outline-none"
							>
								<option value="inherit">inherit</option>
								{piThinkingLevels.map((l) => (
									<option key={l} value={l}>
										{l}
									</option>
								))}
							</select>
							<button
								type="button"
								onClick={() => void persist(models.filter((_, j) => j !== i))}
								className="rounded px-1.5 py-1 text-[10px] text-neutral-500 hover:bg-danger-soft hover:text-danger"
							>
								×
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
