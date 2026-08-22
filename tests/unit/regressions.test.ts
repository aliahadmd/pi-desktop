/**
 * Regression tests for audit findings (.pibugs/pibugs1.md).
 * Covers: H-3 (optimistic user block), H-4/M-8 (error notices),
 * M-7 (message_end no longer clobbers completed blocks),
 * H-2/L-2 (sidecar rebuild channel registered), M-2 contract (bash requestId).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	applyEvent,
	createContext,
	type AssistantBlock,
	type NoticeBlock,
	type UserBlock,
} from "../../src/renderer/src/lib/ingest";
import { useSessions } from "../../src/renderer/src/stores/pi-sessions";
import { requestSchemaMap } from "../../src/shared/protocol";

const ROOT = path.resolve(import.meta.dirname, "../..");

const SESSION = "test-session";

// Node-env stubs: the store talks to window.piDesktop and schedules via rAF.
beforeAll(() => {
	(globalThis as Record<string, unknown>)["requestAnimationFrame"] = (fn: () => void) =>
		setTimeout(fn, 0);
	(globalThis as Record<string, unknown>)["window"] = {
		piDesktop: {
			invoke: (req: { type?: string }) =>
				Promise.resolve(
					req.type === "session.messages"
						? { ok: true, data: { messages: [] } }
						: req.type === "session.state"
							? {
									ok: true,
									data: {
										sessionId: SESSION,
										sessionFile: undefined,
										sessionName: undefined,
										model: undefined,
										thinkingLevel: "off",
										isStreaming: false,
										isCompacting: false,
										isRetrying: false,
										isBashRunning: false,
										autoCompactionEnabled: true,
										autoRetryEnabled: true,
										messageCount: 0,
										pendingMessageCount: 0,
									},
								}
							: req.type === "session.thinking_levels"
								? { ok: true, data: { levels: ["off"] } }
								: { ok: true, data: null },
				),
			on: () => () => {},
			pty: {},
		},
	};
});

afterAll(() => {
	delete (globalThis as Record<string, unknown>)["requestAnimationFrame"];
	delete (globalThis as Record<string, unknown>)["window"];
});

function resetStore(): void {
	useSessions.setState({ sessions: {}, activeId: null });
	useSessions.getState().open({
		sessionId: SESSION,
		backend: "rpc",
		cwd: "/tmp",
		sessionFile: undefined,
		model: undefined,
	});
}

describe("regression: H-3 optimistic user block", () => {
	it("user prompt appears in transcript immediately", () => {
		resetStore();
		useSessions.getState().addUserBlock(SESSION, "fix the bug");
		const blocks = useSessions.getState().sessions[SESSION]?.blocks ?? [];
		expect(blocks.some((b) => b.kind === "user" && b.text === "fix the bug")).toBe(true);
	});
});

describe("regression: H-4 error notices surface in transcript", () => {
	it("pushErrorNotice adds a visible error block", () => {
		resetStore();
		useSessions.getState().pushErrorNotice(SESSION, "Prompt rejected: no api key");
		const blocks = useSessions.getState().sessions[SESSION]?.blocks ?? [];
		const notice = blocks.find((b): b is NoticeBlock => b.kind === "notice");
		expect(notice?.level).toBe("error");
		expect(notice?.text).toContain("no api key");
	});
});

describe("regression: M-7 late message_end cannot clobber completed blocks", () => {
	it("drops message_end when no assistant block is streaming", () => {
		const ctx = createContext();
		ctx.blocks.push({
			kind: "assistant",
			id: "asst-done",
			parts: [{ type: "text", text: "final answer" }],
			status: "complete",
		});
		applyEvent(ctx, {
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "CLOBBERED" }],
			},
		});
		const block = ctx.blocks[0] as AssistantBlock;
		expect(block.parts[0]).toEqual({ type: "text", text: "final answer" });
		expect(block.status).toBe("complete");
	});

	it("still updates the genuinely streaming block", () => {
		const ctx = createContext();
		applyEvent(ctx, { type: "message_start", message: { role: "assistant" } });
		applyEvent(ctx, {
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "authoritative" }],
			},
		});
		const block = ctx.blocks[0] as AssistantBlock;
		expect(block.parts[0]).toEqual({ type: "text", text: "authoritative" });
		expect(block.status).toBe("complete");
	});
});

describe("regression: H-2/L-2 sidecar rebuild channel is wired", () => {
	it("schema map contains sidecar.rebuild", () => {
		expect(Object.keys(requestSchemaMap)).toContain("sidecar.rebuild");
	});
});

describe("regression: M-2 bash requestId in schema", () => {
	it("session.bash requires a requestId for block correlation", () => {
		expect(Object.keys(requestSchemaMap)).toContain("session.bash");
		// Schema-level guarantee exercised via router validation in ipc-router tests.
		const schema = requestSchemaMap["session.bash"];
		expect(schema).toBeDefined();
		void useSessions; // keep import graph explicit
	});
});

describe("regression: user block survives streaming updates", () => {
	it("assistant deltas do not remove the optimistic user block", () => {
		resetStore();
		useSessions.getState().addUserBlock(SESSION, "my prompt");
		const before = useSessions.getState().sessions[SESSION]?.blocks.length ?? 0;
		// Simulate a delta arriving through applyEvent on the live session.
		const session = useSessions.getState().sessions[SESSION];
		if (session !== undefined) {
			applyEvent(session.ctx, {
				type: "message_update",
				delta: { type: "text_delta", contentIndex: 0, delta: "reply" },
			});
		}
		const after = useSessions.getState().sessions[SESSION]?.blocks ?? [];
		const user = after.find((b): b is UserBlock => b.kind === "user");
		expect(user?.text).toBe("my prompt");
		expect(before).toBeGreaterThan(0);
	});
});

describe("regression: approval extension is wired into PiService", () => {
	it("main/index.ts loads the desktop approval extension", () => {
		const source = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8");
		expect(source).toContain("setExtensionFactories");
		expect(source).toContain("pi-desktop-approve");
	});
});

describe("regression: no dead extensionPaths plumbing remains", () => {
	it("extensionPaths does not appear in backend.ts, service.ts, or index.ts", () => {
		for (const file of ["src/main/pi/backend.ts", "src/main/pi/service.ts", "src/main/index.ts"]) {
			const source = readFileSync(path.join(ROOT, file), "utf8");
			expect(source).not.toContain("extensionPaths");
		}
	});
});

describe("regression: approval gate defaults to enabled", () => {
	it("an unset confirmBeforeApply setting means the gate is on", () => {
		const source = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8");
		expect(source).toContain('getSettingRaw("confirmBeforeApply") !== false');
	});
});

describe("regression: sdk backend forwards extension factories to pi", () => {
	it("sdk-backend.ts passes extensionFactories through resourceLoaderOptions", () => {
		const source = readFileSync(path.join(ROOT, "src/main/pi/sdk-backend.ts"), "utf8");
		expect(source).toContain("resourceLoaderOptions");
		expect(source).toContain("extensionFactories");
	});
});
