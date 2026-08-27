/**
 * Audit 6 M-6: RPC stdout decoding must not corrupt multi-byte UTF-8 split
 * across pipe chunks. The fake responder (scene built into the "utf8"
 * command) splits its JSONL output in the middle of a 🚀 codepoint; a
 * per-chunk toString() would turn it into U+FFFD and break JSON.parse, while
 * StringDecoder holds the partial sequence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { RpcPiBackend } from "../../src/main/pi/rpc-backend";
import type { PiEvent } from "../../src/shared/pi";

const FAKE_PI = path.join(import.meta.dirname, "../fixtures/fake-pi.mjs");
const TEXT = "héllo — 世界 🚀";

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

describe("RPC stdout decoding (audit 6 M-6)", () => {
	it("decodes a response split mid-codepoint without corruption", async () => {
		const data = (await backend.rawRequest({ type: "utf8" })) as { text: string };
		expect(data.text).toBe(TEXT);
		expect(data.text).not.toContain("\uFFFD"); // no replacement chars
	});

	it("decodes a streamed event split mid-codepoint without corruption", async () => {
		const start = events.length; // the first test already produced one delta
		await backend.rawRequest({ type: "utf8" });
		const updates = events.slice(start).filter((e) => e.type === "message_update");
		const delta = updates
			.map((e) => (e.delta as { delta?: string }).delta ?? "")
			.join("");
		expect(delta).toBe(TEXT);
		// No unparseable-line warnings either: the split line still parsed.
		expect(events.slice(start).filter((e) => e.type === "backend_warning")).toEqual([]);
	});
});
