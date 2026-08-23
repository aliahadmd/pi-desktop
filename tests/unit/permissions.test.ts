/**
 * Permission-mode extension (phase 5, audit follow-up to confirmBeforeApply).
 *
 * The extension evaluates every tool_call against a live per-session mode and
 * vetoes gated calls with { block: true, reason }. These tests drive the real
 * returned handler with fake events + a scripted ui.select.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "../../src/shared/pi";
import { PERMISSION_BLOCK_REASONS } from "../../src/shared/pi";
import { createPermissionExtension } from "../../src/main/pi/approve-extension";
import { clearSession, setDefaultMode, setMode } from "../../src/main/pi/permissions";

const SID = "test-session";

interface Harness {
	run(event: { toolName: string; input?: Record<string, unknown> }): Promise<
		{ block: boolean; reason?: string } | undefined
	>;
	selectCalls: { title: string; options: string[] }[];
	setSelection(choice: string): void;
}

function makeHarness(mode: PermissionMode): Harness {
	setMode(SID, mode);
	const selectCalls: { title: string; options: string[] }[] = [];
	let selection = "Deny";

	let toolCallHandler:
		| ((event: unknown, ctx: unknown) => Promise<unknown>)
		| undefined;

	const fakePi = {
		on: (name: string, handler: never) => {
			if (name === "tool_call") toolCallHandler = handler as typeof toolCallHandler;
		},
	} as unknown as ExtensionAPI;

	const factory = createPermissionExtension(() => SID);
	(factory as (pi: ExtensionAPI) => void)(fakePi);

	if (toolCallHandler === undefined) throw new Error("tool_call handler not registered");

	return {
		async run(event) {
			const ctx = {
				ui: {
					select: async (title: string, options: string[]) => {
						selectCalls.push({ title, options });
						return selection;
					},
				},
			};
			return (await toolCallHandler?.(event, ctx)) as
				| { block: boolean; reason?: string }
				| undefined;
		},
		selectCalls,
		setSelection(choice: string) {
			selection = choice;
		},
	};
}

beforeEach(() => {
	setDefaultMode("askBeforeEdits");
	clearSession(SID);
});

describe("permission mode: plan", () => {
	it("blocks edits with the plan reason", async () => {
		const h = makeHarness("plan");
		const r = await h.run({ toolName: "write", input: { path: "/x.ts" } });
		expect(r).toEqual({ block: true, reason: PERMISSION_BLOCK_REASONS.plan });
	});

	it("blocks bash with the plan reason", async () => {
		const h = makeHarness("plan");
		const r = await h.run({ toolName: "bash", input: { command: "npm test" } });
		expect(r?.block).toBe(true);
		expect(r?.reason).toBe(PERMISSION_BLOCK_REASONS.plan);
	});

	it.each(["read", "grep", "find", "ls"])("never gates %s", async (tool) => {
		const h = makeHarness("plan");
		expect(await h.run({ toolName: tool })).toBeUndefined();
		expect(h.selectCalls).toHaveLength(0);
	});
});

describe("permission mode ladder", () => {
	it("askBeforeEdits: reads free, edit prompts, deny blocks", async () => {
		const h = makeHarness("askBeforeEdits");
		expect(await h.run({ toolName: "read", input: { path: "/a" } })).toBeUndefined();
		const r = await h.run({ toolName: "edit", input: { path: "/a" } });
		expect(h.selectCalls).toHaveLength(1);
		expect(r?.block).toBe(true);
		expect(r?.reason).toBe(PERMISSION_BLOCK_REASONS.denied);
	});

	it("acceptEdits: edit passes silently but bash still prompts", async () => {
		const h = makeHarness("acceptEdits");
		expect(await h.run({ toolName: "write", input: { path: "/a" } })).toBeUndefined();
		expect(h.selectCalls).toHaveLength(0);
		await h.run({ toolName: "bash", input: { command: "ls" } });
		expect(h.selectCalls).toHaveLength(1);
	});

	it("bypass: nothing prompts for any tool", async () => {
		const h = makeHarness("bypass");
		for (const tool of ["read", "edit", "write", "bash"]) {
			expect(
				await h.run({ toolName: tool, input: { command: "x", path: "/a" } }),
			).toBeUndefined();
		}
		expect(h.selectCalls).toHaveLength(0);
	});
});

describe("always-allow memory", () => {
	it("second identical command does not prompt again", async () => {
		const h = makeHarness("alwaysAsk");
		h.setSelection("Always allow this command");
		await h.run({ toolName: "bash", input: { command: "npm test" } });
		await h.run({ toolName: "bash", input: { command: "npm test" } });
		expect(h.selectCalls).toHaveLength(1); // prompted once only
	});

	it("a different command still prompts", async () => {
		const h = makeHarness("alwaysAsk");
		h.setSelection("Always allow this command");
		await h.run({ toolName: "bash", input: { command: "npm test" } });
		await h.run({ toolName: "bash", input: { command: "rm -rf /tmp/x" } });
		expect(h.selectCalls).toHaveLength(2);
	});

	it("'Allow once' does not create memory", async () => {
		const h = makeHarness("alwaysAsk");
		h.setSelection("Allow once");
		await h.run({ toolName: "bash", input: { command: "npm test" } });
		await h.run({ toolName: "bash", input: { command: "npm test" } });
		expect(h.selectCalls).toHaveLength(2);
	});
});

describe("live mode switching", () => {
	it("changing the mode mid-session changes behavior on the next call", async () => {
		const h = makeHarness("plan");
		expect((await h.run({ toolName: "edit", input: { path: "/a" } }))?.block).toBe(true);
		setMode(SID, "acceptEdits");
		expect(await h.run({ toolName: "edit", input: { path: "/a" } })).toBeUndefined();
	});
});

describe("default fallback", () => {
	it("session without an override uses the default mode", async () => {
		setDefaultMode("bypass");
		const otherId = "other-session";
		const selectCalls: unknown[][] = [];
		let handler: ((e: unknown, ctx: unknown) => Promise<unknown>) | undefined;
		const factory = createPermissionExtension(() => otherId);
		factory({
			on: (name: string, h: never) => {
				if (name === "tool_call") handler = h as typeof handler;
			},
		} as unknown as ExtensionAPI);
		const ctx = {
			ui: {
				select: async (...args: unknown[]) => {
					selectCalls.push(args);
					return "Deny";
				},
			},
		};
		await handler?.({ toolName: "bash", input: { command: "x" } }, ctx);
		expect(selectCalls).toHaveLength(0); // bypass default -> no prompt
	});
});
