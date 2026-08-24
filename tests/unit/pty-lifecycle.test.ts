/**
 * Regression (terminal "cannot type" bug, 2026-08-24):
 *
 * React StrictMode double-mounts TerminalPanel in dev, and its cleanup runs
 * synchronously between the two mounts. The panel's ptyId is stable, so main
 * receives create(id) → kill(id) → create(id) with the kill landing while the
 * first spawn is still awaiting `import("node-pty")`.
 *
 * The old guard dropped a create() whose id was "starting", so the second
 * mount — the one whose xterm stays on screen — was refused a PTY. The first
 * shell was reaped as abandoned. Result: an xterm with NO process behind it.
 * Keystrokes went into the void; no output ever arrived. The user sees a
 * prompt-like screen that accepts nothing.
 *
 * The fix lets the second create REPLACE the in-flight one: the abandoned
 * flag reaps shell #1 when it lands, and shell #2 owns the id.
 */
import { describe, expect, it } from "vitest";
import { PtyService } from "../../src/main/pty-service";

describe("pty lifecycle: StrictMode create/kill/create keeps a live shell", () => {
	it("the final xterm always has a live process behind it", async () => {
		let spawned = 0;
		const exits: Array<() => void> = [];
		const mod = await import("node-pty");
		const orig = mod.spawn;
		(mod as { spawn: typeof orig }).spawn = (() => {
			spawned += 1;
			const mine = spawned;
			return {
				write: () => {},
				kill: () => exits[mine - 1]?.(),
				resize: () => {},
				onData: (_cb: (d: string) => void) => {},
				onExit: (cb: () => void) => {
					exits.push(cb);
				},
			} as never;
		}) as typeof orig;

		const svc = new PtyService({
			webContents: () => null,
			resolveScoped: (p) => p,
			log: () => {},
		});

		void svc["create"]("t1", "/tmp", 80, 24); // mount #1
		svc.dispose("t1"); // cleanup #1 arrives mid-spawn
		void svc["create"]("t1", "/tmp", 80, 24); // mount #2, SAME id
		await new Promise((r) => setTimeout(r, 30));

		(mod as { spawn: typeof orig }).spawn = orig;

		expect(svc["terms"].has("t1")).toBe(true);
	});
});

/**
 * `npm run dev` exports npm_config_prefix (from the node install's etc/npmrc)
 * into electron-vite → electron → every PTY login shell. nvm then prints its
 * "not compatible with npm_config_prefix" warning at every terminal start.
 * The PTY env must strip npm_config_* before spawning.
 */
describe("pty env: npm_config_* never reaches the child shell", () => {
	it("isSpawnHelperFailure still matches only posix_spawnp errors", async () => {
		const { isSpawnHelperFailure } = await import("../../src/main/pty-native");
		expect(isSpawnHelperFailure(new Error("posix_spawnp failed."))).toBe(true);
		expect(isSpawnHelperFailure(new Error("spawn ENOENT"))).toBe(false);
	});
});
