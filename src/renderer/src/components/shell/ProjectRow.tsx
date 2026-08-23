/**
 * Sidebar project row (phase 6): chevron + name + count, with hover actions
 * for new-session-in-project and pin toggle.
 */
import { ChevronRight, Plus, Star } from "lucide-react";

export function ProjectRow({
	name,
	count,
	pinned,
	collapsed,
	onToggle,
	onNewSession,
	onTogglePin,
}: {
	name: string;
	count: number;
	pinned: boolean;
	collapsed: boolean;
	onToggle(): void;
	onNewSession(): void;
	onTogglePin(): void;
}): React.JSX.Element {
	return (
		<div className="group flex items-center rounded px-2 py-1 hover:bg-neutral-900">
			<button
				type="button"
				onClick={onToggle}
				className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
			>
				<span
					className={`shrink-0 text-neutral-600 transition-transform ${
						collapsed ? "" : "rotate-90"
					}`}
				>
					<ChevronRight size={10} strokeWidth={2} />
				</span>
				<span className="truncate text-[11px] font-medium text-neutral-400">{name}</span>
			</button>
			<span className="ml-1 shrink-0 font-mono text-[9px] text-neutral-700 group-hover:hidden">
				{count}
			</span>
			<div className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
				<button
					type="button"
					title={`New session in ${name}`}
					data-testid={`project-new-${name}`}
					onClick={(e) => {
						e.stopPropagation();
						onNewSession();
					}}
					className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
				>
					<Plus size={11} strokeWidth={2} />
				</button>
				<button
					type="button"
					title={pinned ? "Unpin project" : "Pin project"}
					data-testid={`project-pin-${name}`}
					onClick={(e) => {
						e.stopPropagation();
						onTogglePin();
					}}
					className={`rounded p-0.5 hover:bg-neutral-800 ${
						pinned ? "text-amber-400" : "text-neutral-600 hover:text-neutral-300"
					}`}
				>
					<Star size={11} strokeWidth={2} fill={pinned ? "currentColor" : "none"} />
				</button>
			</div>
		</div>
	);
}
