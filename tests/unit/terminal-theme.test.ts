/**
 * Terminal theme re-sync (audit 6 M-21): xterm reads the --pi-* theme
 * variables at mount, so a preset switch used to leave terminals on the old
 * colors. The fix re-applies term.options.theme on theme change — without
 * remounting the terminal, which would kill the PTY.
 *
 * Source pins: a DOM test would need xterm + node-pty under jsdom.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PANEL = readFileSync(
	join(import.meta.dirname, "../../src/renderer/src/components/workspace/TerminalPanel.tsx"),
	"utf8"
);
const CHAT = readFileSync(
	join(import.meta.dirname, "../../src/renderer/src/pages/ChatPage.tsx"),
	"utf8"
);

describe("terminal theme re-sync (audit 6 M-21)", () => {
	it("tracks the app theme id and re-applies the xterm theme", () => {
		expect(PANEL).toContain("useThemeId");
		expect(PANEL).toContain("term.options.theme = readTerminalTheme()");
		// The sync effect re-runs on theme change.
		expect(PANEL).toMatch(/\}, \[themeId\]\);/);
	});

	it("does not remount the terminal on theme change (that would kill the PTY)", () => {
		expect(PANEL).not.toContain("key={themeId}");
		expect(CHAT).not.toContain("key={themeId}");
	});

	it("hidden panels stay mounted; the visible one re-fits on activation", () => {
		expect(CHAT).toContain('active={dockTab === "terminal" && i === activeTermTab}');
		expect(PANEL).toContain("if (!active) return;");
	});
});
