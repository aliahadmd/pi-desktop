/**
 * Top application bar (phase 6 UX): always visible, spans the window.
 *
 * Owns the sidebar show/hide toggle (left, clear of the macOS traffic
 * lights) and the window drag region. Follows VS Code / Slack / Linear:
 * a hidden sidebar leaves ZERO trace — restoration lives in the top bar,
 * not in leftover rail chrome.
 */
import { PanelLeft } from "lucide-react";

export function TopBar({
	sidebarHidden,
	onToggleSidebar,
}: {
	sidebarHidden: boolean;
	onToggleSidebar(): void;
}): React.JSX.Element {
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
			<span
				className="titlebar-drag h-full min-w-0 flex-1"
				aria-hidden="true"
			/>
			{sidebarHidden && (
				<span className="pr-4 font-mono text-[10px] text-neutral-600">
					sidebar hidden — ⌘\ or the button restores it
				</span>
			)}
		</div>
	);
}
