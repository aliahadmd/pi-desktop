/**
 * Sidecar restart timer lifecycle (audit 6 L-9):
 *  - a pending restart must be cancelled by stop() — otherwise it fires
 *    mid-exit (before-quit) and spawns a sidecar while the app is quitting;
 *  - "degraded" is no longer terminal: after the fast restart budget is spent,
 *    a slow recovery retry keeps the sidecar self-healing.
 *
 * Driven against the real class with fake timers and a stubbed start(), the
 * same way sidecar-manager.test.ts reaches private internals via casts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidecarManager } from "../../src/main/sidecar/manager";

const RECOVERY_RETRY_MS = 5 * 60_000;

type ManagerInternals = {
	restarts: number;
	restartTimer: NodeJS.Timeout | null;
	readonly currentStatus: string;
	scheduleRestart(reason: string): void;
	start(): Promise<void>;
	stop(): Promise<void>;
};

function makeManager(): ManagerInternals {
	return new SidecarManager({
		appSupportDir: "/tmp/pidesktop-restart-timer-test",
		agentDir: "/tmp/pidesktop-restart-timer-test/agent",
		onStatus: () => undefined,
	}) as unknown as ManagerInternals;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("restart timer cancellation", () => {
	it("stop() cancels a pending restart so it never fires mid-exit", async () => {
		const mgr = makeManager();
		const startSpy = vi.spyOn(mgr, "start").mockResolvedValue(undefined);

		mgr.scheduleRestart("exited (code=1)");
		expect(mgr.restartTimer).not.toBeNull();

		// No live child process: stop() resolves immediately.
		await mgr.stop();
		expect(mgr.restartTimer).toBeNull();

		vi.advanceTimersByTime(60_000);
		expect(startSpy).not.toHaveBeenCalled();
	});

	it("arms the fast backoff while budget remains", () => {
		const mgr = makeManager();
		const startSpy = vi.spyOn(mgr, "start").mockResolvedValue(undefined);

		mgr.scheduleRestart("first crash");
		expect(mgr.restarts).toBe(1);
		vi.advanceTimersByTime(1_999);
		expect(startSpy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(mgr.restartTimer).toBeNull();
	});
});

describe("degraded-state recovery affordance", () => {
	it("schedules a slow recovery retry after the restart budget is spent", () => {
		const mgr = makeManager();
		const startSpy = vi.spyOn(mgr, "start").mockResolvedValue(undefined);

		mgr.restarts = 3; // MAX_RESTARTS reached: the old code gave up forever.
		mgr.scheduleRestart("third crash");

		expect(mgr.currentStatus).toBe("degraded");
		// The budget resets so the recovery episode gets the full fast backoff.
		expect(mgr.restarts).toBe(0);
		expect(mgr.restartTimer).not.toBeNull();

		vi.advanceTimersByTime(RECOVERY_RETRY_MS - 1);
		expect(startSpy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(startSpy).toHaveBeenCalledTimes(1);
	});

	it("stop() also cancels the pending recovery retry", async () => {
		const mgr = makeManager();
		const startSpy = vi.spyOn(mgr, "start").mockResolvedValue(undefined);

		mgr.restarts = 3;
		mgr.scheduleRestart("third crash");
		expect(mgr.restartTimer).not.toBeNull();

		await mgr.stop();
		expect(mgr.restartTimer).toBeNull();
		vi.advanceTimersByTime(RECOVERY_RETRY_MS);
		expect(startSpy).not.toHaveBeenCalled();
	});
});
