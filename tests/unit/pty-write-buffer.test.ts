/**
 * pty write buffering: the shell spawn is async (dynamic import + possible
 * spawn-helper repair), so keystrokes typed in the first moments after the
 * terminal opens used to hit `terms.get(id) === undefined` in the pty:write
 * handler and vanish silently — the user types and nothing appears. Writes
 * are now buffered while the id is in flight and flushed on spawn.
 */
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

let writes: string[];

async function fakeSpawn(): Promise<void> {
	const mod = await import("node-pty");
	(mod as { spawn: unknown }).spawn = (() => ({
		write: (data: string) => writes.push(data),
		kill: () => {},
		resize: () => {},
		onData: () => {},
		onExit: () => {},
	})) as never;
}

function makeService(): PtyService {
	return new PtyService({
		webContents: () => null,
		resolveScoped: (p) => p,
		log: () => {},
	});
}

beforeEach(async () => {
	listeners.clear();
	writes = [];
	await fakeSpawn();
});

describe("pty write buffering (spawn window)", () => {
	it("buffers keystrokes sent before spawn completes and flushes them in order", async () => {
		const svc = makeService();
		svc.register();
		const create = listeners.get("pty:create");
		const write = listeners.get("pty:write");
		expect(create).toBeDefined();
		expect(write).toBeDefined();

		create?.({}, { id: "t1", cwd: "/tmp", cols: 80, rows: 24 });
		// The create is awaiting its dynamic import — these arrive in flight.
		write?.({}, { id: "t1", data: "l" });
		write?.({}, { id: "t1", data: "s" });
		write?.({}, { id: "t1", data: "\r" });

		await vi.waitFor(() => expect(writes).toEqual(["l", "s", "\r"]));
		svc.disposeAll();
	});

	it("drops writes for ids that are neither live nor starting", async () => {
		const svc = makeService();
		svc.register();
		const write = listeners.get("pty:write");
		expect(() => write?.({}, { id: "ghost", data: "x" })).not.toThrow();
		// Give any accidental async path a chance to fire.
		await new Promise((r) => setTimeout(r, 20));
		expect(writes).toHaveLength(0);
	});

	it("discards the buffer when the terminal is killed mid-spawn", async () => {
		const svc = makeService();
		svc.register();
		const create = listeners.get("pty:create");
		const write = listeners.get("pty:write");
		const kill = listeners.get("pty:kill");

		create?.({}, { id: "t2", cwd: "/tmp", cols: 80, rows: 24 });
		write?.({}, { id: "t2", data: "rm -rf /\r" });
		kill?.({}, { id: "t2" });

		// The spawn eventually completes (abandoned → reaped) but the buffered
		// input must never reach it.
		await new Promise((r) => setTimeout(r, 50));
		expect(writes).toHaveLength(0);
		svc.disposeAll();
	});
});
