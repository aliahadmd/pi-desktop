/**
 * Audit 6 H-3: the first RPC session a user creates gets a one-time
 * transcript warning that the permission gate is not enforced in RPC mode
 * (the ModePicker is hidden for RPC tabs; this notice is the discovery path).
 *
 * window.piDesktop and localStorage are faked at the global level (node
 * environment, following session-rehydrate.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionOpenedResponse } from "../../src/shared/pi";
import { useSessions } from "../../src/renderer/src/stores/pi-sessions";
import { warnRpcUngatedOnce } from "../../src/renderer/src/lib/rpc-gate-warning";

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

function fakeLocalStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
		clear: () => map.clear(),
		key: () => null,
		get length() {
			return map.size;
		},
	} as Storage;
}

let storage: Storage;

(globalThis as Record<string, unknown>)["window"] = {
	piDesktop: { invoke, on: () => () => {} },
};

Object.defineProperty(globalThis, "localStorage", {
	get: () => storage,
	configurable: true,
});

function opened(id: string, backend: "sdk" | "rpc"): SessionOpenedResponse {
	return {
		sessionId: id,
		backend,
		cwd: `/tmp/${id}`,
		sessionFile: `/tmp/${id}.jsonl`,
		model: undefined,
	};
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(async () => {
	storage = fakeLocalStorage();
	useSessions.setState({ sessions: {}, activeId: null });
	invoke.mockClear();
});

describe("RPC ungated warning (audit 6 H-3)", () => {
	it("pushes a warn notice into the first RPC session created", async () => {
		useSessions.getState().open(opened("s1", "rpc"));
		await flush();

		warnRpcUngatedOnce("s1");

		const notices = useSessions
			.getState()
			.sessions["s1"]!.blocks.filter((b) => b.kind === "notice");
		expect(notices).toHaveLength(1);
		expect(notices[0]!.level).toBe("warn");
		expect(notices[0]!.text).toContain("permission");
		expect(notices[0]!.text.toLowerCase()).toContain("rpc");
	});

	it("does not repeat for later RPC sessions", async () => {
		useSessions.getState().open(opened("s1", "rpc"));
		useSessions.getState().open(opened("s2", "rpc"));
		await flush();

		warnRpcUngatedOnce("s1");
		warnRpcUngatedOnce("s2");

		expect(
			useSessions.getState().sessions["s1"]!.blocks.filter((b) => b.kind === "notice")
		).toHaveLength(1);
		expect(
			useSessions.getState().sessions["s2"]!.blocks.filter((b) => b.kind === "notice")
		).toHaveLength(0);
	});
});
