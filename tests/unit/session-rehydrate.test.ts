/**
 * Renderer reattach (audit 6 H-1): on mount the renderer calls
 * session.list_open and open()s every session the store doesn't know about, so
 * a window reopen never shows an empty app while agents keep running. Sessions
 * already in the store must be skipped — open() would otherwise wipe their
 * blocks and double-hydrate a live transcript.
 *
 * window.piDesktop is faked at the global level; the store only touches it
 * inside functions, so the node environment needs no DOM.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionOpenedResponse } from "../../src/shared/pi";
import { rehydrateOpenSessions, useSessions } from "../../src/renderer/src/stores/pi-sessions";

let listOpenResult: { ok: true; data: { sessions: SessionOpenedResponse[] } } | { ok: false; error: { code: "internal_error"; message: string } };

const invoke = vi.fn((req: { type: string; sessionId?: string }): Promise<unknown> => {
	switch (req.type) {
		case "session.list_open":
			return Promise.resolve(listOpenResult);
		case "session.messages":
			return Promise.resolve({ ok: true, data: { messages: [] } });
		case "session.state":
			return Promise.resolve({
				ok: true,
				data: {
					sessionId: req.sessionId ?? "",
					thinkingLevel: "off",
					isStreaming: false,
				},
			});
		default:
			return Promise.resolve({ ok: true, data: null });
	}
});

(globalThis as Record<string, unknown>)["window"] = {
	piDesktop: {
		invoke,
		on: () => () => {},
	},
};

function opened(id: string): SessionOpenedResponse {
	return {
		sessionId: id,
		backend: "sdk",
		cwd: `/tmp/${id}`,
		sessionFile: `/tmp/${id}.jsonl`,
		model: { provider: "openai", id: "gpt-5", name: "GPT-5" },
	};
}

function messagesInvocations(sessionId: string): number {
	return invoke.mock.calls.filter(
		([req]) => req.type === "session.messages" && req.sessionId === sessionId
	).length;
}

/** Let the open() hydration/state promises settle. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
	useSessions.setState({ sessions: {}, activeId: null });
	invoke.mockClear();
	listOpenResult = { ok: true, data: { sessions: [] } };
});

describe("rehydrateOpenSessions (audit 6 H-1)", () => {
	it("adopts every open session the store doesn't know about", async () => {
		listOpenResult = { ok: true, data: { sessions: [opened("s1"), opened("s2")] } };

		await rehydrateOpenSessions();
		await flush();

		const state = useSessions.getState();
		expect(Object.keys(state.sessions).sort()).toEqual(["s1", "s2"]);
		expect(state.sessions["s1"]?.cwd).toBe("/tmp/s1");
		expect(state.activeId).toBe("s2"); // last opened wins, like manual open()
		// Both transcripts hydrate from pi's own message history.
		expect(messagesInvocations("s1")).toBe(1);
		expect(messagesInvocations("s2")).toBe(1);
		expect(state.sessions["s1"]?.hydrated).toBe(true);
	});

	it("skips sessions already in the store — no double-hydrate", async () => {
		useSessions.getState().open(opened("s1"));
		await flush();
		expect(messagesInvocations("s1")).toBe(1);
		useSessions.getState().pushNotice("s1", "keep me", "info");

		// A window reopen races the user's own open() — s1 is known, s2 is not.
		listOpenResult = { ok: true, data: { sessions: [opened("s1"), opened("s2")] } };
		await rehydrateOpenSessions();
		await flush();

		expect(messagesInvocations("s1")).toBe(1); // not re-hydrated
		expect(messagesInvocations("s2")).toBe(1);
		const s1 = useSessions.getState().sessions["s1"];
		expect(s1?.blocks.some((b) => b.kind === "notice" && b.text === "keep me")).toBe(true);
	});

	it("tolerates IPC failure without touching the store", async () => {
		listOpenResult = { ok: false, error: { code: "internal_error", message: "boom" } };

		await rehydrateOpenSessions();
		await flush();

		expect(Object.keys(useSessions.getState().sessions)).toEqual([]);
	});

	it("is safe to run twice (StrictMode double-mount)", async () => {
		listOpenResult = { ok: true, data: { sessions: [opened("s1")] } };

		await Promise.all([rehydrateOpenSessions(), rehydrateOpenSessions()]);
		await flush();

		expect(Object.keys(useSessions.getState().sessions)).toEqual(["s1"]);
		expect(messagesInvocations("s1")).toBe(1);
	});
});
