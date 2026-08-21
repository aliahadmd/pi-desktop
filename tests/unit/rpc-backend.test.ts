/**
 * Contract tests for RpcPiBackend, run against tests/fixtures/fake-pi.mjs —
 * a scripted `pi --mode rpc` responder. No real LLM or network involved.
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
		// Launch the fake responder directly (shebang → node).
		{ command: FAKE_PI }
	);
	await backend.start();
}, 30_000);

afterAll(async () => {
	await backend.dispose();
});

describe("RpcPiBackend against fake responder", () => {
	it("streams prompt events with correctly joined deltas", async () => {
		await backend.prompt({ text: "hello" });
		const types = events.map((e) => e.type);
		expect(types).toContain("agent_start");
		expect(types).toContain("message_update");
		expect(types).toContain("agent_settled");

		const deltas = events
			.filter((e) => e.type === "message_update")
			.map((e) => (e.delta as { delta?: string }).delta ?? "");
		expect(deltas.join("")).toBe("echo:hello");
	});

	it("returns parsed state", async () => {
		const state = await backend.getState();
		expect(state.sessionId).toBe("fake-session");
		expect(state.model?.provider).toBe("fake");
		expect(state.thinkingLevel).toBe("medium");
	});

	it("returns parsed commands", async () => {
		await expect(backend.getCommands()).resolves.toEqual([
			{ name: "greet", source: "extension" },
		]);
	});

	it("surfaces command failures as errors", async () => {
		await expect(backend.setModel("x", "y")).rejects.toThrow("unknown model: x/y");
	});

	it("round-trips extension UI dialogs", async () => {
		const dialogReceived = new Promise<void>((resolve) => {
			const interval = setInterval(() => {
				if (events.some((e) => e.type === "ui_dialog")) {
					clearInterval(interval);
					resolve();
				}
			}, 20);
		});
		void backend.rawRequest({ type: "dialog" });
		await dialogReceived;

		const dialog = events.find((e) => e.type === "ui_dialog");
		expect(dialog !== undefined && dialog.request.method).toBe("confirm");
		const requestId =
			dialog !== undefined && dialog.type === "ui_dialog" ? dialog.request.requestId : "";

		await backend.respondUi({ requestId, confirmed: true });

		const answered = await new Promise<string>((resolve) => {
			const interval = setInterval(() => {
				const found = events.find(
					(e) => e.type === "session_info_changed" && e.name?.startsWith("answer:")
				);
				if (found !== undefined && found.type === "session_info_changed") {
					clearInterval(interval);
					resolve(found.name ?? "");
				}
			}, 20);
		});
		expect(JSON.parse(answered.slice("answer:".length))).toEqual({ confirmed: true });
	});
});
