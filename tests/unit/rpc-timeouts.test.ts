/**
 * Audit 6 M-7: per-command RPC timeouts + pending-request rejection when the
 * subprocess dies. Before the fix a single 30 s cap falsely failed long
 * bash/compact runs, and a spawn error left every pending promise hanging
 * forever.
 */
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { RpcPiBackend } from "../../src/main/pi/rpc-backend";
import type { PiEvent } from "../../src/shared/pi";

const FAKE_PI = path.join(import.meta.dirname, "../fixtures/fake-pi.mjs");

let backend: RpcPiBackend | undefined;

function makeBackend(scene?: string): { backend: RpcPiBackend; events: PiEvent[]; died: string[] } {
	const events: PiEvent[] = [];
	const died: string[] = [];
	if (scene !== undefined) process.env.FAKE_PI_SCENE = scene;
	else delete process.env.FAKE_PI_SCENE;
	const b = RpcPiBackend.create(
		{
			cwd: "/tmp",
			onEvent: (event) => events.push(event),
			onDied: (reason) => died.push(reason),
		},
		{ command: FAKE_PI }
	);
	backend = b;
	return { backend: b, events, died };
}

afterEach(async () => {
	delete process.env.FAKE_PI_SCENE;
	await backend?.dispose().catch(() => {});
	backend = undefined;
});

describe("RPC per-command timeouts (audit 6 M-7)", () => {
	it("bash and compact carry no client-side timeout", async () => {
		const { COMMAND_TIMEOUTS_MS } = await import("../../src/main/pi/rpc-backend");
		expect(COMMAND_TIMEOUTS_MS["bash"]).toBe(0);
		expect(COMMAND_TIMEOUTS_MS["compact"]).toBe(0);
	});

	it("explicit timeoutMs still applies (hung command rejects)", async () => {
		const { backend: b } = makeBackend();
		await b.start();
		await expect(b.rawRequest({ type: "hang" }, 80)).rejects.toThrow(
			"timeout waiting for response to hang"
		);
	});

	it("a pending request rejects when the process exits mid-flight", async () => {
		const { backend: b, died } = makeBackend("exit-on-hang");
		await b.start();
		await expect(b.rawRequest({ type: "hang" })).rejects.toThrow(/pi rpc process exited/);
		expect(died.length).toBe(1);
	});

	it("a pending request rejects when the spawn fails", async () => {
		const died: string[] = [];
		const b = RpcPiBackend.create(
			{
				cwd: "/tmp",
				onEvent: () => {},
				onDied: (reason) => died.push(reason),
			},
			{ command: "/nonexistent/pi-binary-that-does-not-exist" }
		);
		backend = b;
		// Same synchronous tick: the pending request is registered before the
		// spawn "error" event can fire (nextTick at the earliest), so the
		// rejection below is the M-7 rejectAllPending path, not a race.
		const started = b.start();
		const req = b.rawRequest({ type: "get_state" });
		await started;
		await expect(req).rejects.toThrow(/spawn failed/);
		expect(died.length).toBe(1);
		expect(died[0]).toContain("spawn failed");
	});

	it("requests issued after dispose reject instead of hanging", async () => {
		const { backend: b } = makeBackend();
		await b.start();
		await b.dispose();
		backend = undefined;
		await expect(b.rawRequest({ type: "get_state" })).rejects.toThrow(
			"RPC process is not running"
		);
	});
});
