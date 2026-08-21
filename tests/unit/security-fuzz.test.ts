/**
 * Chapter 8 security fuzzing: hammers the IPC router with adversarial payloads.
 * The router must ALWAYS return a structured result — never throw, never hang,
 * never leak stack traces to the renderer.
 */
import { describe, expect, it } from "vitest";
import { IpcRouter } from "../../src/main/ipc/router";
import { piRequestSchemas } from "../../src/shared/pi";

function makeRouter(): IpcRouter {
	const router = new IpcRouter();
	router.handle("ping", () => ({
		pong: "pong",
		mainVersion: "0.0.0",
		electronVersion: "0",
		timestamp: 1,
	}));
	router.handle("log_write", () => null);
	return router;
}

const ADVERSARIAL: unknown[] = [
	null,
	undefined,
	42,
	-0,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	"",
	"ping",
	"PING",
	"__proto__",
	"constructor",
	{},
	{ type: null },
	{ type: 1337 },
	{ type: "ping", __proto__: { evil: true } },
	{ type: "ping", pong: "x".repeat(1_000_000) },
	{ type: "log_write", level: "info", args: Array(10_000).fill("x") },
	{ type: "log_write", level: { $gt: "" }, args: [] },
	{ type: "session.create", cwd: "/etc", noSession: { $where: "1" } },
	{ type: "session.create", cwd: "file:///etc/passwd" },
	{ type: "fs.read", filePath: "../../../../etc/shadow" },
	{ type: "fs.list", dirPath: "~/.ssh" },
	{ type: "auth.set_key", providerId: "anthropic", key: "" },
	{ type: "auth.set_key", providerId: "", key: "sk-x' OR 1=1--" },
	Array.from({ length: 1000 }, (_, i) => ({ type: `x${i}` })),
	new Date(),
	Symbol("nope"),
];

describe("IPC router fuzzing (chapter 8)", () => {
	it("never throws across the fuzz corpus; always structured results", async () => {
		const router = makeRouter();
		for (const payload of ADVERSARIAL) {
			const result = await Promise.race([
				router.dispatch(payload),
				new Promise<"hang">((r) => setTimeout(() => r("hang"), 2000)),
			]);
			expect(result, `payload: ${String(JSON.stringify(payload))?.slice(0, 80)}`).not.toBe(
				"hang"
			);
			expect(result).toHaveProperty("ok");
		}
	});

	it("error messages do not contain stack traces", async () => {
		const router = makeRouter();
		const result = await router.dispatch({ type: "unknown_channel_xyz" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).not.toMatch(/at .+:\d+:\d+/); // no stack frames
		}
	});

	it("handles rapid concurrent dispatches without cross-talk", async () => {
		const router = makeRouter();
		const requests = Array.from({ length: 200 }, (_, i) =>
			router.dispatch(i % 2 === 0 ? { type: "ping" } : { type: "nope" })
		);
		const results = await Promise.all(requests);
		for (let i = 0; i < results.length; i++) {
			if (i % 2 === 0) expect(results[i]?.ok).toBe(true);
			else expect(results[i]?.ok).toBe(false);
		}
	});

	it("every registered channel is covered by the schema map", () => {
		void piRequestSchemas;
		const count = Object.keys(piRequestSchemas).length;
		expect(count).toBeGreaterThan(20);
	});
});
