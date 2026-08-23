/**
 * SidecarManager integration test: spawns the real Python sidecar via uv,
 * verifies health, token auth, and search round-trip. Skips (passes) when the
 * venv is not built — run `cd sidecar && uv sync` once to enable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { SidecarManager } from "../../src/main/sidecar/manager";

const ROOT = path.resolve(import.meta.dirname, "../..");
const VENV_UVICORN = path.join(ROOT, "sidecar/.venv/bin/uvicorn");
const venvReady = existsSync(VENV_UVICORN);

let manager: SidecarManager;
const statuses: string[] = [];

async function waitForStatus(
	target: string,
	timeoutMs = 20_000
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (manager.currentStatus === target) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

beforeAll(async () => {
	if (!venvReady) return;
	delete process.env.PI_DESKTOP_SIDECAR_BIN;
	process.chdir(ROOT);
	manager = new SidecarManager({
		appSupportDir: "/tmp/pidesktop-sidecar-test",
		agentDir: "/tmp/pidesktop-sidecar-test/agent",
		onStatus: (status) => statuses.push(status),
	});
	await manager.start();
	const ok = await waitForStatus("healthy");
	if (!ok) console.log("sidecar never became healthy:", statuses);
}, 40_000);

afterAll(async () => {
	if (manager !== undefined) await manager.stop();
});

describe("SidecarManager", () => {
	it("reaches healthy status with the real python service", () => {
		if (!venvReady) return; // skip gracefully
		expect(manager.currentStatus).toBe("healthy");
	});

	it("serves health endpoint", { timeout: 15_000 }, async () => {
		if (!venvReady) return;
		const health = await manager.get<{ status: string }>("/health");
		expect(health?.status).toBe("ok");
	});

	it("rejects requests without the token", { timeout: 15_000 }, async () => {
		if (!venvReady) return;
		const response = await fetch(
			`http://127.0.0.1:${(manager as unknown as { port: number }).port}/search?q=x`
		);
		expect(response.status).toBe(401);
	});

	it("returns null (graceful) for search when no sessions indexed", { timeout: 15_000 }, async () => {
		if (!venvReady) return;
		const hits = await manager.search("anything");
		expect(hits).toEqual([]);
	});
});

/**
 * Audit M-7: only stop() cleared healthTimer, so every restart cycle stacked a
 * fresh interval and the dead generation kept polling a dead port.
 *
 * Driven against the real class with a stubbed timer pair rather than a mock
 * framework: startHealthPolling is private, so reach it the same way the other
 * tests reach `port`.
 */
describe("health poll interval lifecycle", () => {
	it("clears the previous interval before starting a new one", () => {
		const cleared: unknown[] = [];
		const realSetInterval = globalThis.setInterval;
		const realClearInterval = globalThis.clearInterval;
		let handleSeq = 0;
		try {
			globalThis.setInterval = ((): NodeJS.Timeout => {
				handleSeq += 1;
				// unref() is called on the result; return a shape that supports it.
				return { id: handleSeq, unref: () => undefined } as unknown as NodeJS.Timeout;
			}) as unknown as typeof setInterval;
			globalThis.clearInterval = ((handle: unknown) => {
				cleared.push(handle);
			}) as unknown as typeof clearInterval;

			const subject = new SidecarManager({
				appSupportDir: "/tmp/pidesktop-timer-test",
				agentDir: "/tmp/pidesktop-timer-test/agent",
				onStatus: () => undefined,
			}) as unknown as {
				startHealthPolling(): void;
				healthTimer: { id: number } | null;
			};

			subject.startHealthPolling();
			const first = subject.healthTimer;
			expect(first).not.toBeNull();
			expect(cleared).toHaveLength(0);

			// Simulate the restart path: start() runs again without stop().
			subject.startHealthPolling();
			const second = subject.healthTimer;

			// The first generation was cleared, and exactly one timer is live.
			expect(cleared).toHaveLength(1);
			expect(cleared[0]).toBe(first);
			expect(second).not.toBe(first);
		} finally {
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
		}
	});
});
