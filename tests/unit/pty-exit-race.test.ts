/**
 * pty exit race: a kill+recreate under the same id (React StrictMode
 * remount, or a cwd-change effect re-run) can fire the OLD shell's onExit
 * AFTER the NEW shell was registered. An unguarded `terms.delete(id)` then
 * evicts the live shell: output keeps flowing (onData closes over the term)
 * but every pty:write drops silently — the user-reported "terminal shows a
 * prompt but I can't type".
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

interface FakeShell {
	writes: string[];
	exitHandler: ((e: { exitCode: number }) => void) | null;
	killed: boolean;
}

let shells: FakeShell[];

async function fakeSpawn(): Promise<void> {
	const mod = await import("node-pty");
	(mod as { spawn: unknown }).spawn = (() => {
		const shell: FakeShell = { writes: [], exitHandler: null, killed: false };
		shells.push(shell);
		return {
			write: (data: string) => shell.writes.push(data),
			kill: () => {
				shell.killed = true;
			},
			resize: () => {},
			onData: () => {},
			onExit: (cb: (e: { exitCode: number }) => void) => {
				shell.exitHandler = cb;
			},
		};
	}) as never;
}

function makeService(): PtyService {
	return new PtyService({
		webContents: () => null,
		resolveScoped: (p) => p,
		log: () => {},
	});
}

/** Flush the dynamic-import + spawn continuation inside create(). */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(async () => {
	listeners.clear();
	shells = [];
	await fakeSpawn();
});

describe("pty stale-onExit race", () => {
	it("an old shell's late exit must not evict the live replacement", async () => {
		const svc = makeService();
		svc.register();
		const create = listeners.get("pty:create");
		const write = listeners.get("pty:write");
		const kill = listeners.get("pty:kill");

		// First shell lands in the registry.
		create?.({}, { id: "t1", cwd: "/tmp", cols: 80, rows: 24 });
		await settle();
		expect(shells).toHaveLength(1);

		// Kill + recreate the same id (StrictMode remount ordering).
		kill?.({}, { id: "t1" });
		create?.({}, { id: "t1", cwd: "/tmp", cols: 80, rows: 24 });
		await settle();
		expect(shells).toHaveLength(2);

		// NOW the old shell's exit finally fires (async process teardown).
		shells[0]?.exitHandler?.({ exitCode: 0 });

		// The replacement must still own the id: typing reaches shell 2.
		write?.({}, { id: "t1", data: "echo alive\r" });
		expect(shells[1]?.writes).toEqual(["echo alive\r"]);
		svc.disposeAll();
	});

	it("a genuine shell exit still clears the registry and notifies", async () => {
		const svc = makeService();
		svc.register();
		const create = listeners.get("pty:create");
		create?.({}, { id: "t2", cwd: "/tmp", cols: 80, rows: 24 });
		await settle();
		expect(shells).toHaveLength(1);

		shells[0]?.exitHandler?.({ exitCode: 0 }); // user typed `exit`

		// Registry cleared: a fresh create for the same id spawns a new shell.
		create?.({}, { id: "t2", cwd: "/tmp", cols: 80, rows: 24 });
		await settle();
		expect(shells).toHaveLength(2);
		svc.disposeAll();
	});
});
