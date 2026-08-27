/**
 * PTY create-window races (audit 6 L-8):
 *
 * 1. The 8-terminal cap counted only LANDED terminals (`terms.size`), but the
 *    spawn awaits a dynamic import — a cold-start burst of creates all passed
 *    the check before any terminal landed. The cap now counts
 *    `terms + starting`.
 *
 * 2. A pty:kill arriving in the StrictMode replace window was lost: the OLD
 *    create's `finally` deleted the replacement's reservation markers, so
 *    dispose() found nothing to flag and the replacement's shell landed live
 *    and untracked. Reservations are now per-create records, and cleanup only
 *    releases the caller's own.
 */
import { describe, expect, it } from "vitest";
import { PtyService } from "../../src/main/pty-service";

interface FakeTerm {
	killed: boolean;
}

interface SentMessage {
	channel: string;
	data: string;
}

async function withFakePty<T>(run: (spawned: FakeTerm[], sent: SentMessage[]) => Promise<T>): Promise<T> {
	const spawned: FakeTerm[] = [];
	const sent: SentMessage[] = [];
	const mod = await import("node-pty");
	const orig = mod.spawn;
	(mod as { spawn: typeof orig }).spawn = (() => {
		const term: FakeTerm = { killed: false };
		spawned.push(term);
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
		return await run(spawned, sent);
	} finally {
		(mod as { spawn: typeof orig }).spawn = orig;
	}
}

function makeService(sent: SentMessage[]): PtyService {
	return new PtyService({
		webContents: () =>
			({
				isDestroyed: () => false,
				send: (channel: string, data: string) => {
					sent.push({ channel, data });
				},
			}) as never,
		resolveScoped: (p) => p,
		log: () => {},
	});
}

describe("pty cap counts in-flight spawns (audit 6 L-8)", () => {
	it("a synchronous burst beyond 8 is refused before any shell lands", async () => {
		await withFakePty(async (spawned, sent) => {
			const svc = makeService(sent);
			// Nine creates without yielding: each reserves synchronously, so the
			// ninth must see 8 in-flight and refuse — even though terms is empty.
			for (let i = 0; i < 9; i++) {
				void svc["create"](`t${i}`, "/tmp", 80, 24);
			}
			await new Promise((r) => setTimeout(r, 50));

			expect(spawned).toHaveLength(8);
			const refused = sent.filter(
				(m) => m.channel === "pty:data:t8" && m.data.includes("terminal limit reached"),
			);
			expect(refused).toHaveLength(1);
			expect(svc["terms"].size).toBe(8);
		});
	});
});

describe("kill in the StrictMode replace window (audit 6 L-8)", () => {
	it("a kill aimed at the replacement is not eaten by the old create's cleanup", async () => {
		await withFakePty(async (spawned) => {
			const svc = makeService([]);
			void svc["create"]("t1", "/tmp", 80, 24); // mount #1
			svc.dispose("t1"); // cleanup #1 mid-spawn
			void svc["create"]("t1", "/tmp", 80, 24); // mount #2 REPLACES the in-flight spawn
			// The replacement is still spawning when ITS unmount-kill arrives.
			svc.dispose("t1");
			await new Promise((r) => setTimeout(r, 50));

			// Both shells must be reaped; nothing may stay registered.
			expect(spawned).toHaveLength(2);
			expect(spawned.every((t) => t.killed)).toBe(true);
			expect(svc["terms"].has("t1")).toBe(false);
			expect(svc["starting"].size).toBe(0);
		});
	});

	it("a replacement that is NOT killed still lands live", async () => {
		await withFakePty(async (spawned) => {
			const svc = makeService([]);
			void svc["create"]("t1", "/tmp", 80, 24);
			svc.dispose("t1");
			void svc["create"]("t1", "/tmp", 80, 24);
			await new Promise((r) => setTimeout(r, 50));

			expect(spawned).toHaveLength(2);
			expect(spawned[0]!.killed).toBe(true); // the abandoned first spawn
			expect(spawned[1]!.killed).toBe(false); // the replacement owns the id
			expect(svc["terms"].has("t1")).toBe(true);
		});
	});

	it("disposeAll also reaps shells that land after disposal", async () => {
		await withFakePty(async (spawned) => {
			const svc = makeService([]);
			void svc["create"]("t1", "/tmp", 80, 24);
			svc.disposeAll(); // window close / quit while the spawn is in flight
			await new Promise((r) => setTimeout(r, 50));

			expect(spawned).toHaveLength(1);
			expect(spawned[0]!.killed).toBe(true);
			expect(svc["terms"].size).toBe(0);
		});
	});
});
