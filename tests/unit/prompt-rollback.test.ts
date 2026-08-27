/**
 * Phantom-prompt rollback (audit 6 M-15): the optimistic user block added by
 * send() must be removable when session.prompt is rejected, and the composer's
 * text must be handed back. Store-level tests cover addUserBlock/removeBlock;
 * the ChatPage wiring is pinned at source level (unit tests run in node).
 *
 * window.piDesktop is faked at the global level, following
 * session-rehydrate.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionOpenedResponse } from "../../src/shared/pi";
import { useSessions } from "../../src/renderer/src/stores/pi-sessions";

const invoke = vi.fn((req: { type: string }): Promise<unknown> => {
	switch (req.type) {
		case "session.messages":
			return Promise.resolve({ ok: true, data: { messages: [] } });
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

/** Let open()'s hydration/state promises settle. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(async () => {
	useSessions.setState({ sessions: {}, activeId: null });
	invoke.mockClear();
	useSessions.getState().open(opened("s1"));
	await flush();
});

describe("optimistic prompt rollback (audit 6 M-15)", () => {
	it("addUserBlock returns the new block's id", () => {
		const id = useSessions.getState().addUserBlock("s1", "hello");
		expect(typeof id).toBe("string");
		const blocks = useSessions.getState().sessions["s1"]!.blocks;
		expect(
			blocks.some((b) => b.id === id && b.kind === "user" && b.text === "hello")
		).toBe(true);
	});

	it("removeBlock removes the optimistic block (the rollback path)", () => {
		const id = useSessions.getState().addUserBlock("s1", "take this back")!;
		useSessions.getState().removeBlock("s1", id);
		expect(
			useSessions.getState().sessions["s1"]!.blocks.some((b) => b.id === id)
		).toBe(false);
	});

	it("removeBlock ignores unknown block ids and sessions", () => {
		useSessions.getState().addUserBlock("s1", "keep");
		const before = useSessions.getState().sessions["s1"]!.blocks.length;
		useSessions.getState().removeBlock("s1", "nope");
		useSessions.getState().removeBlock("ghost", "nope");
		expect(useSessions.getState().sessions["s1"]!.blocks).toHaveLength(before);
	});

	it("addUserBlock on an unknown session returns null (nothing to roll back)", () => {
		expect(useSessions.getState().addUserBlock("ghost", "hi")).toBeNull();
	});
});

describe("ChatPage send() wiring (source pin)", () => {
	const CHAT_PAGE = readFileSync(
		join(import.meta.dirname, "../../src/renderer/src/pages/ChatPage.tsx"),
		"utf8"
	);

	it("captures the session id before the async prompt resolves", () => {
		expect(CHAT_PAGE).toContain("const sessionId = activeId;");
	});

	it("promptFailed rolls the block back, restores the text, and notices", () => {
		const at = CHAT_PAGE.indexOf("function promptFailed");
		expect(at).toBeGreaterThanOrEqual(0);
		const body = CHAT_PAGE.slice(at, at + 500);
		expect(body).toContain("removeBlock(sessionId, blockId)");
		expect(body).toContain("setInsertedText(text)");
		expect(body).toContain("pushErrorNotice(sessionId");
	});
});
