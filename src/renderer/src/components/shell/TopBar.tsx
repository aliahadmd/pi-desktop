/**
 * Top application bar (phase 6 UX): always visible, spans the window.
 *
 * Left: sidebar show/hide toggle, clear of the macOS traffic lights.
 * Right: session action icons (dock toggles + compact + exports).
 * Middle: window drag region.
 *
 * Follows VS Code: layout controls left, per-session actions right, drag
 * region between. A hidden sidebar leaves ZERO trace — restoration lives
 * here, not in leftover rail chrome.
 */
import {
	FileJson,
	FolderOpen,
	Minimize2,
	Network,
	PanelLeft,
	SquareSlash,
	SquareTerminal,
	Search,
	Upload,
} from "lucide-react";

/** Dock panel ids; mirrors ChatPage's state (kept local to avoid an import cycle). */
export type TopBarDockTab =
	| "files"
	| "review"
	| "commands"
	| "tree"
	| "terminal"
	| null;

export function TopBar({
	sidebarHidden,
	onToggleSidebar,
	activeSessionId,
	dockTab,
	reviewCount,
	onDockToggle,
	onCompact,
	onExport,
}: {
	sidebarHidden: boolean;
	onToggleSidebar(): void;
	activeSessionId: string | null;
	dockTab: Exclude<TopBarDockTab, null> | null;
	reviewCount: number;
	onDockToggle(tab: Exclude<TopBarDockTab, null>): void;
	onCompact(): void;
	onExport(format: "html" | "jsonl"): void;
}): React.JSX.Element {
	const dockActions = [
		{ tab: "files" as const, Icon: FolderOpen, title: "Files" },
		{ tab: "review" as const, Icon: Search, title: `Review (${String(reviewCount)})` },
		{ tab: "commands" as const, Icon: SquareSlash, title: "Commands" },
		{ tab: "tree" as const, Icon: Network, title: "Tree" },
		{ tab: "terminal" as const, Icon: SquareTerminal, title: "Terminal" },
	];

	const hasSession = activeSessionId !== null;

	return (
		<div
			className="flex h-10 shrink-0 items-center border-b border-neutral-800 bg-neutral-950/80"
			data-testid="top-bar"
		>
			{/* Clear the macOS traffic lights (trafficLightPosition x:16,y:16). */}
			<button
				type="button"
				title={sidebarHidden ? "Show sidebar (⌘\)" : "Hide sidebar (⌘\)"}
				data-testid="topbar-sidebar-toggle"
				aria-label={sidebarHidden ? "Show sidebar" : "Hide sidebar"}
				onClick={onToggleSidebar}
				className={`ml-[72px] rounded p-1.5 transition-colors hover:bg-neutral-800 ${
					sidebarHidden ? "text-blue-400" : "text-neutral-400 hover:text-neutral-200"
				}`}
			>
				<PanelLeft size={15} strokeWidth={2} />
			</button>

			<span className="titlebar-drag h-full min-w-0 flex-1" aria-hidden="true" />

			{hasSession && (
				<div className="flex shrink-0 items-center gap-0.5 pr-3">
					{dockActions.map(({ tab, Icon, title }) => (
						<button
							key={tab}
							type="button"
							data-testid={`topbar-${tab}`}
							onClick={() => onDockToggle(tab)}
							title={title}
							className={`relative rounded p-1.5 transition-colors ${
								dockTab === tab
									? "bg-neutral-800 text-blue-400"
									: "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
							}`}
						>
							<Icon size={14} strokeWidth={1.75} />
							{tab === "review" && reviewCount > 0 && (
								<span className="absolute right-0 top-0 rounded-full bg-red-600 px-1 text-[8px] leading-tight text-white">
									{reviewCount}
								</span>
							)}
						</button>
					))}

					<div className="mx-1.5 h-4 w-px bg-neutral-700" />

					<button
						type="button"
						data-testid="topbar-compact"
						title="Compact context"
						onClick={onCompact}
						className="rounded p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
					>
						<Minimize2 size={14} strokeWidth={1.75} />
					</button>
					<button
						type="button"
						data-testid="topbar-export-html"
						title="Export session (HTML)"
						onClick={() => onExport("html")}
						className="rounded p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
					>
						<Upload size={14} strokeWidth={1.75} />
					</button>
					<button
						type="button"
						data-testid="topbar-export-jsonl"
						title="Export session (JSONL)"
						onClick={() => onExport("jsonl")}
						className="rounded p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
					>
						<FileJson size={14} strokeWidth={1.75} />
					</button>
				</div>
			)}
			{!hasSession && <span className="w-3 shrink-0" />}
		</div>
	);
}
