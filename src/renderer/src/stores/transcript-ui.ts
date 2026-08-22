/**
 * Per-row transcript UI state (expanded / dismissed), kept outside the session
 * store because rows are virtualized: they unmount when scrolled out of view,
 * so local component state would be lost. Keyed `${sessionId}:${blockId}`.
 *
 * The sets store *deviations from the default*, so a running tool that has
 * never been clicked still reads as expanded, and one the user collapsed stays
 * collapsed after remounting.
 */
import { create } from "zustand";

interface TranscriptUiState {
	expanded: Set<string>;
	dismissed: Set<string>;
	isExpanded(key: string, fallback: boolean): boolean;
	toggleExpanded(key: string, fallback: boolean): void;
	isDismissed(key: string): boolean;
	dismiss(key: string): void;
	/** Drop all rows for a session when its tab closes. */
	clearSession(sessionId: string): void;
}

export const useTranscriptUi = create<TranscriptUiState>((set, get) => ({
	expanded: new Set<string>(),
	dismissed: new Set<string>(),

	isExpanded(key, fallback) {
		// present in the set === "user flipped it away from the default"
		return get().expanded.has(key) ? !fallback : fallback;
	},

	toggleExpanded(key, _fallback) {
		set((prev) => {
			const next = new Set(prev.expanded);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return { expanded: next };
		});
	},

	isDismissed(key) {
		return get().dismissed.has(key);
	},

	dismiss(key) {
		set((prev) => {
			const next = new Set(prev.dismissed);
			next.add(key);
			return { dismissed: next };
		});
	},

	clearSession(sessionId) {
		const prefix = `${sessionId}:`;
		set((prev) => ({
			expanded: new Set([...prev.expanded].filter((k) => !k.startsWith(prefix))),
			dismissed: new Set([...prev.dismissed].filter((k) => !k.startsWith(prefix))),
		}));
	},
}));
