/**
 * Sidebar project sort order (phase 6). Pinned projects float first (in pin
 * order), then the chosen mode applies within each tier.
 */
export type ProjectSortMode = "recent" | "name" | "pinned";

export interface SortableProject {
	name: string;
	pinned: boolean;
	pinnedAt: number;
	/** Max session updatedAt for the group; 0 when it has no sessions. */
	lastActivity: number;
}

/** Pinned floats first (by pin time desc); then by the chosen mode. */
export function sortProjects<T extends SortableProject>(
	rows: T[],
	mode: ProjectSortMode,
): T[] {
	const cmpPinned = (a: T, b: T): number =>
		Number(b.pinned) - Number(a.pinned) || b.pinnedAt - a.pinnedAt;

	const out = [...rows];
	out.sort((a, b) => {
		if (mode === "name") {
			return cmpPinned(a, b) || a.name.localeCompare(b.name);
		}
		if (mode === "pinned") {
			return cmpPinned(a, b);
		}
		// recent: pinned first, then lastActivity desc
		return cmpPinned(a, b) || b.lastActivity - a.lastActivity;
	});
	return out;
}
