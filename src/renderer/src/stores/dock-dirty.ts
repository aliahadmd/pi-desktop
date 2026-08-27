/**
 * Unsaved-draft tracking for the dock's file editor (audit 6 M-22).
 *
 * FileExplorer owns the draft buffer, but the actions that destroy it live
 * elsewhere — the top bar's dock toggle, ChatPage's Esc/⌘J handler, session
 * switches. This store lets those call sites ask "would closing now discard
 * an unsaved draft?" and confirm first.
 */
import { create } from "zustand";

interface DockDirtyState {
	/** Absolute path of the file with an unsaved editor draft, if any. */
	dirtyPath: string | null;
	setDirty(path: string | null): void;
}

export const useDockDirty = create<DockDirtyState>((set) => ({
	dirtyPath: null,
	setDirty(path) {
		set({ dirtyPath: path });
	},
}));

/**
 * True when unmounting the dock editor is safe (no draft, or the user
 * confirmed the discard). Used before closing the dock or swapping the
 * editor's file/cwd underneath a dirty buffer.
 */
export function confirmDockEditorClose(): boolean {
	const dirty = useDockDirty.getState().dirtyPath;
	if (dirty === null) return true;
	if (typeof window === "undefined" || typeof window.confirm !== "function") {
		return true;
	}
	const name = dirty.split("/").pop() ?? dirty;
	return window.confirm(`Discard unsaved changes to ${name}?`);
}
