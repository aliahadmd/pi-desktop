/**
 * Audit 6 M-11: ui_notify / ui_editor_text / backend_warning events were
 * emitted by main and silently dropped by the renderer store. They are now
 * routed: ui_notify and backend_warning land on the transcript notice
 * surface; ui_editor_text feeds the composer insertion slot.
 *
 * window.piDesktop is faked at the global level, following
 * session-rehydrate.test.ts.
 */
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

describe("extension event routing (audit 6 M-11)", () => {
	it("routes ui_notify to a transcript notice, mapping severity", () => {
		const { applyEvent } = useSessions.getState();
		applyEvent("s1", { type: "ui_notify", message: "heads up", notifyType: "info" });
		applyEvent("s1", { type: "ui_notify", message: "careful", notifyType: "warning" });
		applyEvent("s1", { type: "ui_notify", message: "broke", notifyType: "error" });

		const notices = useSessions
			.getState()
			.sessions["s1"]!.blocks.filter((b) => b.kind === "notice");
		expect(notices.map((n) => [n.text, n.level])).toEqual([
			["heads up", "info"],
			["careful", "warn"],
			["broke", "error"],
		]);
	});

	it("routes backend_warning to a warn-level notice", () => {
		useSessions
			.getState()
			.applyEvent("s1", { type: "backend_warning", reason: "extension x failed to load" });

		const notices = useSessions
			.getState()
			.sessions["s1"]!.blocks.filter((b) => b.kind === "notice");
		expect(notices).toHaveLength(1);
		expect(notices[0]!.text).toBe("extension x failed to load");
		expect(notices[0]!.level).toBe("warn");
	});

	it("routes ui_editor_text to the composer insertion slot and clears on ack", () => {
		const store = useSessions.getState();
		store.applyEvent("s1", { type: "ui_editor_text", text: "/compact older messages" });
		expect(useSessions.getState().sessions["s1"]!.insertText).toBe("/compact older messages");

		useSessions.getState().clearInsertText("s1");
		expect(useSessions.getState().sessions["s1"]!.insertText).toBeUndefined();
	});

	it("ignores empty ui_editor_text (nothing to insert)", () => {
		useSessions.getState().applyEvent("s1", { type: "ui_editor_text", text: "" });
		expect(useSessions.getState().sessions["s1"]!.insertText).toBeUndefined();
	});

	it("drops ui_notify for unknown sessions without throwing", () => {
		expect(() =>
			useSessions
				.getState()
				.applyEvent("ghost", { type: "ui_notify", message: "hi", notifyType: "info" })
		).not.toThrow();
	});

	it("routed events do not produce transcript blocks beyond the notice", () => {
		const before = useSessions.getState().sessions["s1"]!.blocks.length;
		useSessions.getState().applyEvent("s1", { type: "ui_editor_text", text: "x" });
		useSessions
			.getState()
			.applyEvent("s1", { type: "backend_warning", reason: "y" });
		// backend_warning adds one notice; ui_editor_text adds none.
		const after = useSessions.getState().sessions["s1"]!.blocks.length;
		expect(after - before).toBe(1);
	});
});
