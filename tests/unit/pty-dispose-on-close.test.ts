/**
 * PTY teardown on window loss (audit 6 M-3): React unmount cleanup (pty:kill)
 * never runs when the window is closed or reloaded, so shells outlived the
 * window and leaked against the 8-terminal cap until the whole app quit.
 *
 * The behavioral half pins PtyService.disposeAll reaping every live shell.
 * The wiring half is a source-level pin — a DOM-level test would need the
 * full Electron harness (covered by e2e); same approach as
 * window-wiring.test.ts for the audit-4 H-1 regression class.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PtyService } from "../../src/main/pty-service";

const INDEX_TS = readFileSync(join(import.meta.dirname, "../../src/main/index.ts"), "utf8");

interface FakeTerm {
	killed: boolean;
}

async function withFakeSpawn<T>(terms: FakeTerm[], run: () => Promise<T>): Promise<T> {
	const mod = await import("node-pty");
	const orig = mod.spawn;
	(mod as { spawn: typeof orig }).spawn = (() => {
		const term: FakeTerm = { killed: false };
		terms.push(term);
		return {
			write: () => {},
			kill: () => {
				term.killed = true;
			},
			resize: () => {},
			onData: (_cb: (d: string) => void) => {},
			onExit: (_cb: () => void) => {},
		} as never;
	}) as typeof orig;
	try {
		return await run();
	} finally {
		(mod as { spawn: typeof orig }).spawn = orig;
	}
}

describe("PtyService.disposeAll", () => {
	it("kills every live shell and empties the registry", async () => {
		const spawned: FakeTerm[] = [];
		await withFakeSpawn(spawned, async () => {
			const svc = new PtyService({
				webContents: () => null,
				resolveScoped: (p) => p,
				log: () => {},
			});
			await svc["create"]("t1", "/tmp", 80, 24);
			await svc["create"]("t2", "/tmp", 80, 24);
			expect(svc["terms"].size).toBe(2);

			svc.disposeAll();

			expect(spawned).toHaveLength(2);
			expect(spawned.every((t) => t.killed)).toBe(true);
			expect(svc["terms"].size).toBe(0);
		});
	});

	it("is a no-op when nothing is running (safe on the initial-load navigation)", () => {
		const svc = new PtyService({
			webContents: () => null,
			resolveScoped: (p) => p,
			log: () => {},
		});
		expect(() => svc.disposeAll()).not.toThrow();
	});
});

describe("window-close PTY wiring (audit 6 M-3)", () => {
	it("the window's onClosed disposes all PTYs, not just nulls the bus", () => {
		const onClosed = INDEX_TS.match(/onClosed:\s*\(\)\s*=>\s*\{([\s\S]*?)\}/);
		expect(onClosed).not.toBeNull();
		expect(onClosed?.[1]).toContain("bus.setWindow(null)");
		expect(onClosed?.[1]).toContain("ptyService?.disposeAll()");
	});

	it("a full renderer reload (⌘R) also disposes PTYs — new panels get fresh ids", () => {
		const nav = INDEX_TS.match(/did-start-navigation[\s\S]*?\}\);/);
		expect(nav).not.toBeNull();
		expect(nav?.[0]).toContain("ptyService?.disposeAll()");
		// In-page (history/anchor) navigations must not kill live terminals.
		expect(nav?.[0]).toContain("isInPlace");
	});

	it("before-quit still disposes PTYs (the close path never double-disposes)", () => {
		const beforeQuit = INDEX_TS.match(/app\.on\("before-quit"[\s\S]*?\n\}\);/);
		expect(beforeQuit?.[0]).toContain("closingPty?.disposeAll()");
	});
});
