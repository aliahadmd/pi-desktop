/**
 * Audit 6 L-6 — permission dialog polish:
 *  - option[0] was the command summary itself, so picking the highlighted
 *    default *denied* the call. Options are now actions only; the summary
 *    rides in the title.
 *  - The "always allow" memory was keyed on a 400-char-truncated summary, so
 *    two commands sharing that prefix collided (fail-open). The memory key is
 *    now the full untruncated call.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "../../src/shared/pi";
import { createPermissionExtension } from "../../src/main/pi/approve-extension";
import { clearSession, setDefaultMode, setMode } from "../../src/main/pi/permissions";

const SID = "dialog-test-session";

interface Harness {
	run(event: { toolName: string; input?: Record<string, unknown> }): Promise<unknown>;
	selectCalls: { title: string; options: string[] }[];
	setSelection(choice: string): void;
}

function makeHarness(mode: PermissionMode, sessionId = SID): Harness {
	setMode(sessionId, mode);
	const selectCalls: { title: string; options: string[] }[] = [];
	let selection = "Deny";

	let toolCallHandler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const fakePi = {
		on: (name: string, handler: never) => {
			if (name === "tool_call") toolCallHandler = handler as typeof toolCallHandler;
		},
	} as unknown as ExtensionAPI;

	const factory = createPermissionExtension(() => sessionId);
	(factory as (pi: ExtensionAPI) => void)(fakePi);
	const handler = toolCallHandler;
	if (handler === undefined) throw new Error("tool_call handler not registered");

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
			return handler(event, ctx);
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
	clearSession("long-cmd-session");
});

describe("permission dialog options (audit 6 L-6)", () => {
	it("options are actions only — the summary is not a selectable default", async () => {
		const h = makeHarness("alwaysAsk");
		await h.run({ toolName: "bash", input: { command: "npm test" } });
		expect(h.selectCalls).toHaveLength(1);
		expect(h.selectCalls[0]!.options).toEqual([
			"Allow once",
			"Always allow this command",
			"Deny",
		]);
	});

	it("the command summary rides in the dialog title", async () => {
		const h = makeHarness("alwaysAsk");
		await h.run({ toolName: "bash", input: { command: "rm -rf /tmp/x" } });
		expect(h.selectCalls[0]!.title).toContain("rm -rf /tmp/x");
		expect(h.selectCalls[0]!.title).toContain("bash");
	});

	it("plan mode keeps its framing and still shows the summary", async () => {
		const h = makeHarness("plan");
		await h.run({ toolName: "write", input: { path: "/tmp/a.ts" } });
		expect(h.selectCalls[0]!.title).toContain("Plan mode");
		expect(h.selectCalls[0]!.title).toContain("/tmp/a.ts");
	});
});

describe("always-allow memory keying (audit 6 L-6)", () => {
	it("commands sharing a >400-char prefix do not collide", async () => {
		const h = makeHarness("alwaysAsk", "long-cmd-session");
		h.setSelection("Always allow this command");
		const prefix = `echo ${"a".repeat(500)}`;
		const first = `${prefix}-one`;
		const second = `${prefix}-two`; // identical for the first 400 chars

		await h.run({ toolName: "bash", input: { command: first } });
		expect(h.selectCalls).toHaveLength(1);

		// Same command again: remembered, no prompt.
		await h.run({ toolName: "bash", input: { command: first } });
		expect(h.selectCalls).toHaveLength(1);

		// Same 400-char prefix, different tail: must still prompt. Pre-fix the
		// truncated key collided and this call slipped through ungated.
		await h.run({ toolName: "bash", input: { command: second } });
		expect(h.selectCalls).toHaveLength(2);
	});
});
