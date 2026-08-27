/**
 * Transcript edge cases (audit 6 L-13): the 2000-block trim must reset a
 * dangling streaming target; a clean compaction and a real model switch must
 * blank stale usage figures; hydration seeds the status bar from the last
 * assistant message's usage. The ChatPage side (keyed composer/palette, no
 * duplicate manual-compact notice) is pinned at source level.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiSessionState, SessionOpenedResponse } from "../../src/shared/pi";
import { useSessions } from "../../src/renderer/src/stores/pi-sessions";

let messagesResult: unknown = { ok: true, data: { messages: [] } };

const invoke = vi.fn((req: { type: string }): Promise<unknown> => {
	switch (req.type) {
		case "session.messages":
			return Promise.resolve(messagesResult);
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

function stateFor(model?: { provider: string; id: string; name: string }): PiSessionState {
	return {
		sessionId: "s1",
		sessionFile: undefined,
		sessionName: undefined,
		model,
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		isRetrying: false,
		isBashRunning: false,
		autoCompactionEnabled: true,
		autoRetryEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
	};
}

/** Let hydration settle and the 8 ms scheduleFrame fallback fire. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 40));
}

const GPT5 = { provider: "openai", id: "gpt-5", name: "GPT-5" };

beforeEach(async () => {
	useSessions.setState({ sessions: {}, activeId: null });
	invoke.mockClear();
	messagesResult = { ok: true, data: { messages: [] } };
	useSessions.getState().open(opened("s1"));
	await flush();
});

describe("block trim (audit 6 L-13)", () => {
	it("resets a trimmed-away streaming target so later deltas land", async () => {
		const { applyEvent } = useSessions.getState();
		applyEvent("s1", { type: "message_start", message: { role: "assistant" } });
		applyEvent("s1", {
			type: "message_update",
			delta: { type: "text_delta", contentIndex: 0, delta: "trimmed away" },
		});
		for (let i = 0; i < 2001; i++) {
			applyEvent("s1", {
				type: "tool_execution_start",
				toolCallId: `t${i}`,
				toolName: "bash",
			});
		}
		await flush();

		let s = useSessions.getState().sessions["s1"]!;
		expect(s.blocks.length).toBeLessThanOrEqual(2001); // 2000 kept + trim notice
		expect(s.blocks[0]).toMatchObject({ kind: "notice" });
		expect(JSON.stringify(s.blocks)).not.toContain("trimmed away");
		// The streaming target was trimmed out of blocks; it must not dangle.
		expect(s.ctx.streamingAssistantId).toBeNull();

		// A post-trim delta starts a fresh block instead of being dropped.
		applyEvent("s1", {
			type: "message_update",
			delta: { type: "text_delta", contentIndex: 0, delta: "after trim" },
		});
		await flush();
		s = useSessions.getState().sessions["s1"]!;
		const assistants = s.blocks.filter((b) => b.kind === "assistant");
		expect(JSON.stringify(assistants)).toContain("after trim");
	});
});

describe("usage figure lifecycle (audit 6 L-13)", () => {
	function seedUsage(tokens: number): void {
		useSessions.getState().applyEvent("s1", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				usage: { totalTokens: tokens, cost: { total: 0.5 } },
			},
		});
	}

	it("open() seeds lastUsage from the last assistant message with usage", async () => {
		useSessions.setState({ sessions: {}, activeId: null });
		messagesResult = {
			ok: true,
			data: {
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "old" }],
						usage: { totalTokens: 10 },
					},
					{ role: "user", content: "next" },
					{
						role: "assistant",
						content: [{ type: "text", text: "new" }],
						usage: { totalTokens: 42, cost: { total: 0.01 } },
					},
				],
			},
		};
		useSessions.getState().open(opened("s2"));
		await flush();
		expect(useSessions.getState().sessions["s2"]!.lastUsage).toEqual({
			tokens: 42,
			cost: 0.01,
		});
	});

	it("refreshState blanks lastUsage only when the model actually changes", () => {
		seedUsage(100);
		expect(useSessions.getState().sessions["s1"]!.lastUsage).toEqual({
			tokens: 100,
			cost: 0.5,
		});

		// First model appearance invalidates the figures (they were not priced
		// at this model).
		useSessions.getState().refreshState("s1", stateFor(GPT5));
		expect(useSessions.getState().sessions["s1"]!.lastUsage).toBeUndefined();

		// Same model again: kept.
		seedUsage(200);
		useSessions.getState().refreshState("s1", stateFor(GPT5));
		expect(useSessions.getState().sessions["s1"]!.lastUsage).toEqual({
			tokens: 200,
			cost: 0.5,
		});

		// A real switch: cleared.
		useSessions
			.getState()
			.refreshState("s1", stateFor({ provider: "anthropic", id: "claude", name: "Claude" }));
		expect(useSessions.getState().sessions["s1"]!.lastUsage).toBeUndefined();
	});

	it("a clean compaction blanks lastUsage; an aborted one keeps it", async () => {
		seedUsage(300);
		useSessions.getState().applyEvent("s1", { type: "compaction_start", reason: "manual" });
		useSessions.getState().applyEvent("s1", {
			type: "compaction_end",
			reason: "manual",
			aborted: false,
			willRetry: false,
		});
		await flush();
		expect(useSessions.getState().sessions["s1"]!.lastUsage).toBeUndefined();

		seedUsage(400);
		useSessions.getState().applyEvent("s1", { type: "compaction_start", reason: "manual" });
		useSessions.getState().applyEvent("s1", {
			type: "compaction_end",
			reason: "manual",
			aborted: true,
			willRetry: false,
		});
		await flush();
		expect(useSessions.getState().sessions["s1"]!.lastUsage).toEqual({
			tokens: 400,
			cost: 0.5,
		});
	});
});

describe("ChatPage pins (audit 6 L-13)", () => {
	const CHAT_PAGE = readFileSync(
		join(import.meta.dirname, "../../src/renderer/src/pages/ChatPage.tsx"),
		"utf8"
	);

	it("composer and command palette are keyed per session", () => {
		expect(CHAT_PAGE.match(/key=\{active\.id\}/g)?.length).toBe(2);
	});

	it("manual compact posts no duplicate success notice", () => {
		const at = CHAT_PAGE.indexOf('data-testid="compact-confirm"');
		expect(at).toBeGreaterThanOrEqual(0);
		const end = CHAT_PAGE.indexOf(".catch(() => setCompacting(false))", at);
		expect(end).toBeGreaterThan(at);
		expect(CHAT_PAGE.slice(at, end)).not.toContain("pushNotice(");
	});
});
