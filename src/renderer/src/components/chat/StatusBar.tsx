/**
 * Status bar: run phase + token/cost usage.
 *
 * Model identity lives in the composer (searchable picker); thinking level
 * moved there too — both were duplicated here before the picker existed.
 */
import type { SessionUi } from "../../stores/pi-sessions";

const PHASE_LABEL: Record<SessionUi["phase"], { text: string; cls: string }> = {
	idle: { text: "idle", cls: "bg-neutral-600" },
	streaming: { text: "streaming", cls: "bg-blue-500 animate-pulse" },
	compacting: { text: "compacting", cls: "bg-info animate-pulse" },
	retrying: { text: "retrying", cls: "bg-amber-500 animate-pulse" },
};

export function StatusBar({ session }: { session: SessionUi }): React.JSX.Element {
	const phase = PHASE_LABEL[session.phase];

	return (
		<div className="flex h-8 shrink-0 items-center gap-3 border-t border-neutral-800 px-4 font-mono text-[10px] text-neutral-400">
			<span className="flex items-center gap-1.5" data-testid="status-phase">
				<span className={`h-1.5 w-1.5 rounded-full ${phase.cls}`} />
				{phase.text}
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
