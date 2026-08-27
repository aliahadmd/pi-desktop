/**
 * Unsaved-draft guard for the dock editor (audit 6 M-22). The store logic
 * runs for real; the Dock/App/ChatPage call sites are pinned at source level
 * (unit tests run in node, no jsdom).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	confirmDockEditorClose,
	useDockDirty,
} from "../../src/renderer/src/stores/dock-dirty";

const confirmMock = vi.fn((): boolean => true);
(globalThis as Record<string, unknown>)["window"] = { confirm: confirmMock };

beforeEach(() => {
	useDockDirty.setState({ dirtyPath: null });
	confirmMock.mockReset();
});

describe("dock dirty store (audit 6 M-22)", () => {
	it("tracks set/clear of the dirty file path", () => {
		expect(useDockDirty.getState().dirtyPath).toBeNull();
		useDockDirty.getState().setDirty("/repo/a.ts");
		expect(useDockDirty.getState().dirtyPath).toBe("/repo/a.ts");
		useDockDirty.getState().setDirty(null);
		expect(useDockDirty.getState().dirtyPath).toBeNull();
	});

	it("close is allowed without asking when nothing is dirty", () => {
		expect(confirmDockEditorClose()).toBe(true);
		expect(confirmMock).not.toHaveBeenCalled();
	});

	it("a declined confirm blocks the close", () => {
		useDockDirty.getState().setDirty("/repo/a.ts");
		confirmMock.mockReturnValue(false);
		expect(confirmDockEditorClose()).toBe(false);
	});

	it("an accepted confirm lets the close through and names the file", () => {
		useDockDirty.getState().setDirty("/repo/deep/a.ts");
		confirmMock.mockReturnValue(true);
		expect(confirmDockEditorClose()).toBe(true);
		expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("a.ts"));
	});
});

describe("discard-guard call sites (source pins)", () => {
	const DOCK = readFileSync(
		join(import.meta.dirname, "../../src/renderer/src/components/workspace/Dock.tsx"),
		"utf8"
	);
	const APP = readFileSync(
		join(import.meta.dirname, "../../src/renderer/src/App.tsx"),
		"utf8"
	);
	const CHAT = readFileSync(
		join(import.meta.dirname, "../../src/renderer/src/pages/ChatPage.tsx"),
		"utf8"
	);

	it("FileExplorer publishes dirty state and confirms at all three exits", () => {
		expect(DOCK).toContain("useDockDirty.getState().setDirty(");
		// cwd-change effect, openFile, and the editor's close button.
		expect(DOCK.match(/confirmDockEditorClose\(\)/g)?.length).toBeGreaterThanOrEqual(3);
	});

	it("the top-bar dock toggle confirms before closing", () => {
		expect(APP).toContain("if (confirmDockEditorClose()) setDockTab(null);");
	});

	it("ChatPage Esc and ⌘J close paths both confirm", () => {
		expect(CHAT.match(/confirmDockEditorClose\(\)/g)?.length).toBeGreaterThanOrEqual(2);
	});
});
