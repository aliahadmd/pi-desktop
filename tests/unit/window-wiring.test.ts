/**
 * Window wiring guards (plans/008, audit 4 finding H-1): the bug was a window
 * recreated via Dock-icon activate that never registered with the renderer
 * event bus — every main→renderer event then dropped forever. These are
 * source-level pins of the invariant "window creation and bus registration
 * happen together, through one path". A DOM-level test would need the full
 * Electron harness; this catches the actual regression shape.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const INDEX_TS = readFileSync(
	join(import.meta.dirname, "../../src/main/index.ts"),
	"utf8"
);

describe("main window event-bus wiring", () => {
	it("registers and unregisters the bus window exactly once each", () => {
		const matches = INDEX_TS.match(/bus\.setWindow\(/g) ?? [];
		// one registration inside spawnMainWindow + one null in onClosed
		expect(matches).toHaveLength(2);
	});

	it("bus registration lives beside window creation, not in a second hand-rolled copy", () => {
		// Exactly one window-creation call site in the file…
		const directCalls = INDEX_TS.match(/createMainWindow\(/g) ?? [];
		expect(directCalls).toHaveLength(1);
		// …and bus registration happens within its immediate vicinity
		// (same function body), not in some separate hand-rolled path.
		const createAt = INDEX_TS.indexOf("createMainWindow(");
		const registerAt = INDEX_TS.indexOf("bus.setWindow(win)");
		expect(createAt).toBeGreaterThanOrEqual(0);
		expect(registerAt).toBeGreaterThan(createAt);
		expect(registerAt - createAt).toBeLessThan(600);
		// The shared spawner is reachable from lifecycle handlers via the ref.
		expect(INDEX_TS).toContain("spawnMainWindowRef =");
	});

	it("onClosed nulls the bus window", () => {
		expect(INDEX_TS).toMatch(/onClosed:\s*\(\)\s*=>\s*\{\s*bus\.setWindow\(null\);?\s*\}/);
	});

	it("second-instance recovers by spawning a window when none exists", () => {
		const handler = INDEX_TS.match(/app\.on\("second-instance"[\s\S]*?\}\);/);
		expect(handler).toBeDefined();
		expect(handler?.[0]).toContain("spawnMainWindowRef");
		// It must not merely focus an optional first window.
		expect(handler?.[0]).not.toMatch(/^\s*first\?\.\focus\(\);\s*$/m);
	});
});
