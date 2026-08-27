/**
 * Hydration races (audit 6 M-16): stream events that arrive while
 * session.messages is in flight must buffer and then land ON TOP of the
 * hydrated transcript — an un-gated flush let a late hydrate clobber
 * event-derived blocks, and a stale ctx.streamingAssistantId after
 * session_replaced silently swallowed the new branch's first deltas.
 *
 * window.piDesktop is faked at the global level; session.messages is a
 * controllable deferred so tests decide exactly when hydration lands.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionOpenedResponse } from "../../src/shared/pi";
import { useSessions } from "../../src/renderer/src/stores/pi-sessions";

interface Deferred {
	promise: Promise<unknown>;
	resolve(value: unknown): void;
	reject(reason?: unknown): void;
}

function deferred(): Deferred {
	let resolve!: (value: unknown) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

let messagesDeferred: Deferred;

const invoke = vi.fn((req: { type: string }): Promise<unknown> => {
	switch (req.type) {
		case "session.messages":
			return messagesDeferred.promise;
		case "session.state":
			return Promise.resolve({
				ok: true,
				data: { sessionId: "s1", thinkingLevel: "off", isStreaming: false },
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
		model: undefined,
	};
}

/**
 * Let hydration promises settle AND the 8 ms scheduleFrame fallback fire —
 * twice over, since hydration re-arms the flush for buffered events.
 */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 40));
}

function assistantText(id: string): string {
	const s = useSessions.getState().sessions[id];
	return JSON.stringify(s?.blocks ?? []);
}

beforeEach(() => {
	useSessions.setState({ sessions: {}, activeId: null });
	invoke.mockClear();
	messagesDeferred = deferred();
});

describe("hydration race (audit 6 M-16)", () => {
	it("buffers events during hydration, then applies them on top of it", async () => {
		useSessions.getState().open(opened("s1"));
		// A whole run streams in before session.messages resolves.
		const { applyEvent } = useSessions.getState();
		applyEvent("s1", { type: "agent_start" });
		applyEvent("s1", { type: "message_start", message: { role: "assistant" } });
		applyEvent("s1", {
			type: "message_update",
			delta: { type: "text_delta", contentIndex: 0, delta: "streamed" },
		});
		applyEvent("s1", {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "streamed" }] },
		});
		applyEvent("s1", { type: "agent_settled" });

		// The flush timer fires but must skip the un-hydrated session.
		await flush();
		expect(useSessions.getState().sessions["s1"]!.blocks).toHaveLength(0);
		expect(useSessions.getState().sessions["s1"]!.hydrated).toBe(false);

		messagesDeferred.resolve({
			ok: true,
			data: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		});
		await flush();

		const s = useSessions.getState().sessions["s1"]!;
		expect(s.hydrated).toBe(true);
		// Hydrated history first, buffered events appended after it.
		expect(s.blocks[0]).toMatchObject({ kind: "user", text: "hi" });
		const assistant = s.blocks.find((b) => b.kind === "assistant");
		expect(assistant).toMatchObject({ kind: "assistant", status: "complete" });
		expect(assistant && assistant.kind === "assistant" ? assistant.parts[0] : null)
			.toEqual({ type: "text", text: "streamed" });
	});

	it("session_replaced drops buffered pre-replace events and resets the ctx", async () => {
		useSessions.getState().open(opened("s1"));
		messagesDeferred.resolve({ ok: true, data: { messages: [] } });
		await flush();

		// Stream an old-branch assistant block; ctx.streamingAssistantId is set.
		const { applyEvent } = useSessions.getState();
		applyEvent("s1", { type: "agent_start" });
		applyEvent("s1", { type: "message_start", message: { role: "assistant" } });
		applyEvent("s1", {
			type: "message_update",
			delta: { type: "text_delta", contentIndex: 0, delta: "old branch" },
		});
		await flush();
		expect(assistantText("s1")).toContain("old branch");

		// Fork: a stale event sits buffered when the replace lands (same sync
		// block, so the flush timer cannot interleave).
		messagesDeferred = deferred();
		applyEvent("s1", {
			type: "message_update",
			delta: { type: "text_delta", contentIndex: 0, delta: "JUNK" },
		});
		applyEvent("s1", { type: "session_replaced" });
		// The new branch's first delta arrives while re-hydration is in flight.
		applyEvent("s1", {
			type: "message_update",
			delta: { type: "text_delta", contentIndex: 0, delta: "new branch" },
		});
		messagesDeferred.resolve({
			ok: true,
			data: { messages: [{ role: "user", content: "after fork", timestamp: 2 }] },
		});
		await flush();

		const text = assistantText("s1");
		expect(text).not.toContain("old branch");
		expect(text).not.toContain("JUNK");
		expect(text).toContain("after fork");
		// The stale streamingAssistantId used to swallow this delta.
		expect(text).toContain("new branch");
	});

	it("a failed re-hydration still releases the event buffer", async () => {
		useSessions.getState().open(opened("s1"));
		messagesDeferred.resolve({ ok: true, data: { messages: [] } });
		await flush();

		messagesDeferred = deferred();
		useSessions.getState().applyEvent("s1", { type: "session_replaced" });
		useSessions.getState().applyEvent("s1", {
			type: "message_update",
			delta: { type: "text_delta", contentIndex: 0, delta: "still lands" },
		});
		messagesDeferred.resolve({
			ok: false,
			error: { code: "internal_error", message: "boom" },
		});
		await flush();

		expect(useSessions.getState().sessions["s1"]!.hydrated).toBe(true);
		expect(assistantText("s1")).toContain("still lands");
	});

	it("a failed initial hydrate releases the buffer too", async () => {
		useSessions.getState().open(opened("s1"));
		useSessions.getState().applyEvent("s1", {
			type: "message_update",
			delta: { type: "text_delta", contentIndex: 0, delta: "kept" },
		});
		messagesDeferred.resolve({
			ok: false,
			error: { code: "internal_error", message: "boom" },
		});
		await flush();

		expect(useSessions.getState().sessions["s1"]!.hydrated).toBe(true);
		expect(assistantText("s1")).toContain("kept");
	});
});
