/**
 * pty:* payload guards (audit 6 L-2): these channels bypass the
 * typebox-validated request router, so payloads are untrusted. A null payload
 * used to throw uncaught in main (no uncaughtException handler exists), an
 * absent id became the literal terminal "undefined", and cols/rows went into
 * node-pty unclamped.
 *
 * Also pinned here: the dead "/tmp" fallback is gone (it rethrew — /tmp is
 * never a registered root), and git.context is root-scoped (source pin, same
 * approach as window-wiring.test.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type IpcListener = (event: unknown, req: unknown) => void;
const listeners = new Map<string, IpcListener>();

vi.mock("electron", () => ({
	ipcMain: {
		on: (channel: string, listener: IpcListener) => {
			listeners.set(channel, listener);
		},
	},
}));

import { PtyService } from "../../src/main/pty-service";

const INDEX_TS = readFileSync(join(import.meta.dirname, "../../src/main/index.ts"), "utf8");

interface SpawnCall {
	cols: number;
	rows: number;
}

let spawned: SpawnCall[];
let logs: string[];

async function fakeSpawn(): Promise<void> {
	const mod = await import("node-pty");
	(mod as { spawn: unknown }).spawn = ((
		_shell: string,
		_args: string[],
		opts: { cols: number; rows: number },
	) => {
		spawned.push({ cols: opts.cols, rows: opts.rows });
		return {
			write: () => {},
			kill: () => {},
			resize: () => {},
			onData: () => {},
			onExit: () => {},
		};
	}) as never;
}

function makeService(): PtyService {
	return new PtyService({
		webContents: () => null,
		resolveScoped: (p) => p,
		log: (level, message) => logs.push(`${level}:${message}`),
	});
}

beforeEach(async () => {
	listeners.clear();
	spawned = [];
	logs = [];
	await fakeSpawn();
});

describe("pty:* payload guards (audit 6 L-2)", () => {
	it("pty:create drops null/garbage payloads without throwing", () => {
		const svc = makeService();
		svc.register();
		const create = listeners.get("pty:create");
		expect(create).toBeDefined();
		for (const bad of [null, undefined, 42, "x", [], {}, { id: 1 }]) {
			expect(() => create?.({}, bad)).not.toThrow();
		}
		expect(spawned).toHaveLength(0);
		expect(logs.some((l) => l.includes("malformed"))).toBe(true);
	});

	it("pty:create rejects an id that fails the pattern (no String() coercion)", () => {
		const svc = makeService();
		svc.register();
		const create = listeners.get("pty:create");
		// An absent id used to become the literal terminal id "undefined".
		expect(() => create?.({}, { cwd: "/tmp", cols: 80, rows: 24 })).not.toThrow();
		expect(() =>
			create?.({}, { id: "evil id with spaces", cwd: "/tmp", cols: 80, rows: 24 }),
		).not.toThrow();
		expect(spawned).toHaveLength(0);
	});

	it("pty:create clamps absurd grid dimensions", async () => {
		const svc = makeService();
		svc.register();
		listeners.get("pty:create")?.({}, { id: "t1", cwd: "/tmp", cols: 1e9, rows: -50 });
		await new Promise((r) => setTimeout(r, 30));
		expect(spawned).toHaveLength(1);
		expect(spawned[0]!.cols).toBeLessThanOrEqual(500);
		expect(spawned[0]!.rows).toBeGreaterThanOrEqual(1);
	});

	it("pty:write / pty:resize / pty:kill ignore malformed payloads", () => {
		const svc = makeService();
		svc.register();
		for (const channel of ["pty:write", "pty:resize", "pty:kill"]) {
			const listener = listeners.get(channel);
			expect(listener).toBeDefined();
			for (const bad of [null, undefined, 42, {}, { id: 1 }]) {
				expect(() => listener?.({}, bad)).not.toThrow();
			}
		}
	});
});

describe("channel edge scoping (audit 6 L-2)", () => {
	it("pty:create has no /tmp fallback (it could only rethrow)", () => {
		const src = readFileSync(join(import.meta.dirname, "../../src/main/pty-service.ts"), "utf8");
		expect(src).not.toContain('resolveScoped("/tmp")');
	});

	it("git.context realpath-scopes the renderer-supplied root before running git", () => {
		const handler = INDEX_TS.match(/router\.handle\("git\.context"[\s\S]*?\}\);/);
		expect(handler).not.toBeNull();
		expect(handler?.[0]).toContain("assertRealScoped");
		// git must run in the SCOPED path, not the raw request value.
		expect(handler?.[0]).not.toContain("gitService.context(req.root)");
	});
});
