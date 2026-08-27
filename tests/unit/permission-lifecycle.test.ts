/**
 * Permission extension lifecycle (audit 6 H-2): session_shutdown fires on
 * in-place session replacement (reason "new" | "resume" | "fork" | "reload")
 * AND on real teardown ("quit"). The extension must keep the mode and the
 * "always allow" memory across rebuilds and only clear them on quit, otherwise
 * the composer chip shows a mode the backend no longer enforces.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPermissionExtension } from "../../src/main/pi/approve-extension";
import {
	clearSession,
	setDefaultMode,
	setMode,
} from "../../src/main/pi/permissions";
import { DEFAULT_PERMISSION_MODE, PERMISSION_BLOCK_REASONS } from "../../src/shared/pi";

type SelectFn = (title: string, options: string[]) => Promise<string | undefined>;

type ToolCallHandler = (
	event: { toolName: string; input?: Record<string, unknown> },
	ctx: { ui: { select: SelectFn } }
) => Promise<{ block: boolean; reason: string } | undefined>;

function makeExtension(getAppSessionId: () => string | null): {
	toolCall: ToolCallHandler;
	shutdown: (event: { reason: string }) => void;
	select: Mock<SelectFn>;
} {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => {
			handlers.set(name, handler);
		},
	};
	createPermissionExtension(getAppSessionId)(pi as unknown as ExtensionAPI);
	const toolCall = handlers.get("tool_call");
	const shutdown = handlers.get("session_shutdown");
	if (toolCall === undefined || shutdown === undefined) {
		throw new Error("extension did not register expected handlers");
	}
	const select = vi.fn<SelectFn>(async () => "Deny");
	return {
		toolCall: toolCall as unknown as ToolCallHandler,
		shutdown: shutdown as unknown as (event: { reason: string }) => void,
		select,
	};
}

const bashEvent = (command: string) => ({
	toolName: "bash",
	input: { command },
});

beforeEach(() => {
	// permissions.ts keeps global state; reset to a known baseline per test.
	clearSession("s1");
	setDefaultMode(DEFAULT_PERMISSION_MODE);
});

describe("permission extension lifecycle", () => {
	it("gates bash in plan mode and blocks on Deny", async () => {
		const { toolCall, select } = makeExtension(() => "s1");
		setMode("s1", "plan");
		const result = await toolCall(bashEvent("rm -rf /tmp/x"), {
			ui: { select },
		});
		expect(select).toHaveBeenCalledOnce();
		expect(result).toEqual({ block: true, reason: PERMISSION_BLOCK_REASONS.plan });
	});

	it("never gates read-only tools, even in plan mode", async () => {
		const { toolCall, select } = makeExtension(() => "s1");
		setMode("s1", "plan");
		const result = await toolCall({ toolName: "read", input: { path: "/x" } }, {
			ui: { select },
		});
		expect(result).toBeUndefined();
		expect(select).not.toHaveBeenCalled();
	});

	it("remembers 'Always allow this command' for the exact same call", async () => {
		const { toolCall, select } = makeExtension(() => "s1");
		select.mockResolvedValueOnce("Always allow this command");
		const first = await toolCall(bashEvent("git status"), { ui: { select } });
		expect(first).toBeUndefined();
		const second = await toolCall(bashEvent("git status"), { ui: { select } });
		expect(second).toBeUndefined();
		expect(select).toHaveBeenCalledOnce(); // second call passed from memory
	});

	it("keeps mode and memory across session replacement (fork/new/resume/reload)", async () => {
		const { toolCall, shutdown, select } = makeExtension(() => "s1");
		setMode("s1", "alwaysAsk");
		select.mockResolvedValueOnce("Always allow this command");
		const first = await toolCall(bashEvent("git status"), { ui: { select } });
		expect(first).toBeUndefined();
		expect(select).toHaveBeenCalledOnce();

		for (const reason of ["fork", "new", "resume", "reload"]) {
			shutdown({ reason });
		}

		// Mode override survives (alwaysAsk still applies), and the
		// always-allowed memory must still be intact — no re-prompt.
		const result = await toolCall(bashEvent("git status"), { ui: { select } });
		expect(result).toBeUndefined();
		expect(select).toHaveBeenCalledOnce();
	});

	it("clears mode and memory only on quit", async () => {
		const { toolCall, shutdown, select } = makeExtension(() => "s1");
		setMode("s1", "alwaysAsk");
		select.mockResolvedValueOnce("Always allow this command");
		await toolCall(bashEvent("git status"), { ui: { select } });
		expect(select).toHaveBeenCalledOnce();

		shutdown({ reason: "quit" });

		// Mode override gone: default askBeforeEdits gates bash again, and the
		// always-allowed memory was wiped, so the dialog reappears.
		const result = await toolCall(bashEvent("git status"), { ui: { select } });
		expect(select).toHaveBeenCalledTimes(2);
		expect(result).toEqual({ block: true, reason: PERMISSION_BLOCK_REASONS.denied });
	});
});
