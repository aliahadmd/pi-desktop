/**
 * Per-row transcript UI state (expanded / dismissed / copied), kept outside
 * the session store because rows are virtualized: they unmount when scrolled
 * out of view, so local component state would be lost. Keyed
 * `${sessionId}:${blockId}`.
 *
 * Expansion is stored as an EXPLICIT boolean per key (audit 6 M-17). The
 * previous scheme stored "deviation from the default", but the default is
 * dynamic (a running tool defaults to expanded, a finished one to collapsed),
 * so a user-collapsed running tool re-expanded itself the moment it finished.
 * Absence from the map still means "follow the row's current default".
 */
import { create } from "zustand";

interface TranscriptUiState {
	expanded: Map<string, boolean>;
	dismissed: Set<string>;
	/** Rows whose copy button fired recently (drives the "copied" tick). */
	copied: Set<string>;
	isExpanded(key: string, fallback: boolean): boolean;
	toggleExpanded(key: string, fallback: boolean): void;
	/** Pin a row open/closed (the assistant tool-chip expand affordance). */
	setExpanded(key: string, value: boolean): void;
	isDismissed(key: string): boolean;
	dismiss(key: string): void;
	isCopied(key: string): boolean;
	markCopied(key: string): void;
	unmarkCopied(key: string): void;
	/** Drop all rows for a session when its tab closes. */
	clearSession(sessionId: string): void;
}

export const useTranscriptUi = create<TranscriptUiState>((set, get) => ({
	expanded: new Map<string, boolean>(),
	dismissed: new Set<string>(),
	copied: new Set<string>(),

	isExpanded(key, fallback) {
		return get().expanded.get(key) ?? fallback;
	},

	toggleExpanded(key, fallback) {
		const current = get().isExpanded(key, fallback);
		get().setExpanded(key, !current);
	},

	setExpanded(key, value) {
		set((prev) => {
			const next = new Map(prev.expanded);
			next.set(key, value);
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

	isCopied(key) {
		return get().copied.has(key);
	},

	markCopied(key) {
		set((prev) => {
			const next = new Set(prev.copied);
			next.add(key);
			return { copied: next };
		});
	},

	unmarkCopied(key) {
		set((prev) => {
			if (!prev.copied.has(key)) return prev;
			const next = new Set(prev.copied);
			next.delete(key);
			return { copied: next };
		});
	},

	clearSession(sessionId) {
		const prefix = `${sessionId}:`;
		set((prev) => ({
			expanded: new Map(
				[...prev.expanded].filter(([k]) => !k.startsWith(prefix))
			),
			dismissed: new Set([...prev.dismissed].filter((k) => !k.startsWith(prefix))),
			copied: new Set([...prev.copied].filter((k) => !k.startsWith(prefix))),
		}));
	},
}));
