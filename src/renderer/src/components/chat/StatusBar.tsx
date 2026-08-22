/**
 * Status bar: model, thinking level, phase, tokens/cost.
 */
import { useEffect, useState } from "react";
import { piThinkingLevels, type PiThinkingLevel } from "../../../../shared/pi";
import type { SessionUi } from "../../stores/pi-sessions";

const PHASE_LABEL: Record<SessionUi["phase"], { text: string; cls: string }> = {
	idle: { text: "idle", cls: "bg-neutral-600" },
	streaming: { text: "streaming", cls: "bg-blue-500 animate-pulse" },
	compacting: { text: "compacting", cls: "bg-purple-500 animate-pulse" },
	retrying: { text: "retrying", cls: "bg-amber-500 animate-pulse" },
};

export function StatusBar({
	session,
	onSetThinkingLevel,
	onCycleModel,
}: {
	session: SessionUi;
	onSetThinkingLevel(level: PiThinkingLevel): void;
	onCycleModel(): void;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const [supported, setSupported] = useState<PiThinkingLevel[] | null>(null);
	const phase = PHASE_LABEL[session.phase];
	const model = session.model;

	// Clamp the dropdown to the current session's supported levels.
	useEffect(() => {
		if (session.model === undefined) return; // levels are model-dependent
		let cancelled = false;
		void window.piDesktop
			.invoke({ type: "session.thinking_levels", sessionId: session.id })
			.then((r) => {
				if (!cancelled && r.ok) setSupported(r.data.levels);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [session.id, session.model?.id]);

	const levelChoices: PiThinkingLevel[] =
		supported !== null && supported.length > 0 ? supported : [...piThinkingLevels];

	return (
		<div className="flex h-8 shrink-0 items-center gap-3 border-t border-neutral-800 px-4 font-mono text-[10px] text-neutral-400">
			<span className="flex items-center gap-1.5">
				<span className={`h-1.5 w-1.5 rounded-full ${phase.cls}`} />
				{phase.text}
			</span>
			<span className="text-neutral-500">|</span>
			<button
				type="button"
				data-testid="status-model"
				onClick={() => onCycleModel()}
				title="Click to cycle scoped models"
				className="hover:text-neutral-200"
			>
				{model !== undefined ? `${model.provider}/${model.id}` : "no model"}
			</button>
			<span className="text-neutral-500">|</span>
			<span className="relative">
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					className="hover:text-neutral-200"
				>
					thinking: {session.thinkingLevel ?? "off"}
				</button>
				{open && (
					<div className="absolute bottom-6 left-0 z-10 rounded border border-neutral-700 bg-neutral-900 py-1 shadow-xl">
						{levelChoices.map((level) => (
							<button
								key={level}
								type="button"
								onClick={() => {
									setOpen(false);
									onSetThinkingLevel(level);
								}}
								className={`block w-full px-4 py-1 text-left hover:bg-neutral-800 ${
									session.thinkingLevel === level ? "text-blue-400" : ""
								}`}
							>
								{level}
							</button>
						))}
					</div>
				)}
			</span>
			{session.lastUsage !== undefined && (
				<span className="ml-auto" data-testid="status-usage">
					{session.lastUsage.tokens.toLocaleString()} tok · $
					{session.lastUsage.cost.toFixed(4)}
				</span>
			)}
		</div>
	);
}
