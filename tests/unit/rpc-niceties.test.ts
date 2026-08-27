/**
 * Audit 6 L-4 — RPC backend niceties:
 *  - getAvailableModels passes the real wire fields through (the RPC response
 *    carries full serialized Model objects) instead of fabricating
 *    maxTokens/modalities.
 *  - respondUi answers stale dialog ids in the shape the renderer sent
 *    instead of a blanket `value: ""`.
 *  - mapUiDialog drops NaN/garbage timeouts rather than poisoning the
 *    renderer's countdown.
 *  - getEntries with an unknown cursor resyncs from the start, matching the
 *    SDK backend, instead of surfacing an RPC-only error.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { RpcPiBackend } from "../../src/main/pi/rpc-backend";
import type { PiEvent } from "../../src/shared/pi";

const FAKE_PI = path.join(import.meta.dirname, "../fixtures/fake-pi.mjs");

let backend: RpcPiBackend;
let events: PiEvent[];

beforeAll(async () => {
	events = [];
	backend = RpcPiBackend.create(
		{
			cwd: "/tmp",
			onEvent: (event) => events.push(event),
			onDied: () => {},
		},
		{ command: FAKE_PI }
	);
	await backend.start();
}, 30_000);

afterAll(async () => {
	await backend.dispose();
});

/** Wait until pred(events) holds, then return the matching event. */
async function waitForEvent(pred: (e: PiEvent) => boolean): Promise<PiEvent> {
	for (let i = 0; i < 200; i++) {
		const found = events.find(pred);
		if (found !== undefined) return found;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for event");
}

describe("getAvailableModels (L-4)", () => {
	it("passes through name/maxTokens/input from the wire", async () => {
		const models = await backend.getAvailableModels();
		expect(models).toHaveLength(2);
		const pro = models[0]!;
		expect(pro).toMatchObject({
			provider: "fake",
			id: "fake-pro",
			name: "Fake Pro",
			contextWindow: 200000,
			maxTokens: 8192,
			reasoning: true,
			input: ["text", "image"],
		});
		// Sparse wire entries degrade to honest defaults, not fabrications that
		// look real (name falls back to id).
		const mini = models[1]!;
		expect(mini.name).toBe("fake-mini");
		expect(mini.maxTokens).toBe(0);
		expect(mini.input).toEqual([]);
	});
});

describe("respondUi with a stale dialog id (L-4)", () => {
	it("honors the response's confirmed field instead of answering value:''", async () => {
		// "ui-stale" was never registered as a pending dialog.
		await backend.respondUi({ requestId: "ui-stale", confirmed: false });
		const echo = await waitForEvent(
			(e) => e.type === "session_info_changed" && e.name?.startsWith("answer:") === true
		);
		if (echo.type !== "session_info_changed") throw new Error("unreachable");
		expect(JSON.parse(echo.name!.slice("answer:".length))).toEqual({ confirmed: false });
	});
});

describe("mapUiDialog timeout guard (L-4)", () => {
	it("drops a garbage timeout instead of yielding NaN", async () => {
		await backend.rawRequest({ type: "dialog-bad-timeout" });
		const dialog = await waitForEvent((e) => e.type === "ui_dialog");
		if (dialog.type !== "ui_dialog") throw new Error("unreachable");
		expect(dialog.request.requestId).toBe("ui-bad");
		expect(dialog.request.timeoutMs).toBeUndefined();
	});
});

describe("getEntries unknown cursor (L-4)", () => {
	it("resyncs from the start like the SDK backend", async () => {
		const result = await backend.getEntries("unknown-cursor");
		expect(result.entries).toEqual([{ id: "e1" }, { id: "e2" }]);
		expect(result.leafId).toBe("e2");
	});

	it("serves a known cursor normally", async () => {
		const result = await backend.getEntries("e1");
		expect(result.entries).toEqual([{ id: "e1" }, { id: "e2" }]);
	});
});
