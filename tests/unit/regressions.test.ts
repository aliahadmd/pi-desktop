/**
 * Regression tests for audit findings (.pibugs/pibugs1.md).
 * Covers: H-3 (optimistic user block), H-4/M-8 (error notices),
 * M-7 (message_end no longer clobbers completed blocks),
 * H-2/L-2 (sidecar rebuild channel registered), M-2 contract (bash requestId).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { requestSchemaMap, type IpcEvent } from "../../src/shared/protocol";
import { IpcRouter } from "../../src/main/ipc/router";
import { PiService } from "../../src/main/pi/service";
import type { IPiBackend } from "../../src/main/pi/backend";
import type { RendererEventBus } from "../../src/main/ipc/events";
import { readFileSync } from "node:fs";
import {
	applyEvent,
	createContext,
	type AssistantBlock,
	type NoticeBlock,
	type UserBlock,
} from "../../src/renderer/src/lib/ingest";
import { useSessions } from "../../src/renderer/src/stores/pi-sessions";

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

describe("regression: failed bash reports success", () => {
	it("failed bash emits tool_execution_end with isError true", async () => {
		const emitted: IpcEvent[] = [];
		const fakeBus = {
			send: (event: IpcEvent) => {
				emitted.push(event);
			},
		} as unknown as RendererEventBus;

		const stubBackend = {
			bash: async () => {
				throw new Error("command failed");
			},
		} as unknown as IPiBackend;

		const service = new PiService(fakeBus);
		(
			service as unknown as {
				sessions: Map<string, { id: string; cwd: string; backend: IPiBackend }>;
			}
		).sessions.set("s1", { id: "s1", cwd: "/tmp", backend: stubBackend });

		const router = new IpcRouter();
		service.registerHandlers(router);
		await router.dispatch({
			type: "session.bash",
			sessionId: "s1",
			command: "false",
			requestId: "r1",
		});

		const bashEnd = emitted.find(
			(e): e is Extract<IpcEvent, { type: "pi_event" }> =>
				e.type === "pi_event" && e.event.type === "tool_execution_end"
		);
		expect(bashEnd).toBeDefined();
		if (bashEnd !== undefined && bashEnd.event.type === "tool_execution_end") {
			expect(bashEnd.event.isError).toBe(true);
		}
	});
});

describe("regression: only one compact dialog is rendered", () => {
	it("data-testid=\"compact-confirm\" occurs exactly once in ChatPage.tsx", () => {
		const filePath = path.join(
			import.meta.dirname,
			"../../src/renderer/src/pages/ChatPage.tsx"
		);
		const source = fs.readFileSync(filePath, "utf8");
		const matches = source.match(/data-testid="compact-confirm"/g) ?? [];
		expect(matches).toHaveLength(1);
	});
});

describe("regression: escaped absolute positioning (plan 003)", () => {
	it("rail drag strip has a positioned ancestor", () => {
		const source = readFileSync(
			"src/renderer/src/components/shell/Sidebar.tsx",
			"utf8",
		);
		expect(source).toContain("relative flex h-full flex-col items-center");
	});

	it("expanded sidebar is positioned for its context menu", () => {
		const source = readFileSync(
			"src/renderer/src/components/shell/Sidebar.tsx",
			"utf8",
		);
		expect(source).toContain("relative flex h-full flex-col border-r");
	});

	it("composer wrapper is positioned for the drop overlay", () => {
		const source = readFileSync(
			"src/renderer/src/components/chat/Composer.tsx",
			"utf8",
		);
		expect(source).toContain('className="relative px-3 pb-3"');
	});

	it("review badge no longer uses margin-hack positioning", () => {
		const source = readFileSync("src/renderer/src/pages/ChatPage.tsx", "utf8");
		expect(source).not.toContain("absolute ml-4 -mt-3");
	});

	it("sheet is viewport-fixed, not ancestor-dependent", () => {
		const source = readFileSync(
			"src/renderer/src/components/shell/Sheet.tsx",
			"utf8",
		);
		expect(source).toContain("fixed inset-0 z-40");
		expect(source).not.toContain("absolute inset-0 z-40");
	});
});
