/**
 * Audit 6 L-5: the extension-UI adapter must honor ExtensionUIDialogOptions —
 * input() previously dropped `opts` entirely (timeout/signal), and
 * select/confirm ignored `opts.signal`. Aborted/timed-out dialogs resolve
 * fail-closed (confirm → false, others → undefined).
 */
import { describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SdkExtensionUiAdapter } from "../../src/main/pi/extension-ui";
import type { PiEvent } from "../../src/shared/pi";

function makeAdapter(): {
	adapter: SdkExtensionUiAdapter;
	events: PiEvent[];
} {
	const events: PiEvent[] = [];
	const adapter = new SdkExtensionUiAdapter((event) => events.push(event));
	return { adapter, events };
}

/** buildContext ignores its argument — pass a stub. */
const SESSION = {} as AgentSession;

describe("extension UI adapter opts (audit 6 L-5)", () => {
	it("input() honors opts.timeout", async () => {
		const { adapter, events } = makeAdapter();
		const ctx = adapter.buildContext(SESSION);
		const answer = ctx.input("Title", "placeholder", { timeout: 60 });
		await expect(answer).resolves.toBeUndefined();
		const dialog = events.find((e) => e.type === "ui_dialog");
		expect(dialog !== undefined && dialog.type === "ui_dialog" && dialog.request.timeoutMs).toBe(60);
	});

	it("select() resolves fail-closed (undefined) when opts.signal aborts", async () => {
		const { adapter } = makeAdapter();
		const ctx = adapter.buildContext(SESSION);
		const controller = new AbortController();
		const answer = ctx.select("Pick", ["a", "b"], { signal: controller.signal });
		controller.abort();
		await expect(answer).resolves.toBeUndefined();
	});

	it("confirm() resolves fail-closed (false) when opts.signal aborts", async () => {
		const { adapter } = makeAdapter();
		const ctx = adapter.buildContext(SESSION);
		const controller = new AbortController();
		const answer = ctx.confirm("Sure?", "really", { signal: controller.signal });
		controller.abort();
		await expect(answer).resolves.toBe(false);
	});

	it("a pre-aborted signal settles immediately without emitting a dialog", async () => {
		const { adapter, events } = makeAdapter();
		const ctx = adapter.buildContext(SESSION);
		const controller = new AbortController();
		controller.abort();
		const answer = ctx.select("Pick", ["a"], { signal: controller.signal });
		await expect(answer).resolves.toBeUndefined();
		expect(events.filter((e) => e.type === "ui_dialog")).toEqual([]);
	});

	it("input() honors opts.signal", async () => {
		const { adapter } = makeAdapter();
		const ctx = adapter.buildContext(SESSION);
		const controller = new AbortController();
		const answer = ctx.input("Title", undefined, { signal: controller.signal });
		controller.abort();
		await expect(answer).resolves.toBeUndefined();
	});

	it("a normal answer still resolves the dialog and clears its abort listener", async () => {
		const { adapter, events } = makeAdapter();
		const ctx = adapter.buildContext(SESSION);
		const controller = new AbortController();
		const answer = ctx.confirm("Sure?", "really", { signal: controller.signal });
		const dialog = events.find((e) => e.type === "ui_dialog");
		if (dialog === undefined || dialog.type !== "ui_dialog") throw new Error("no dialog");
		adapter.respond({ requestId: dialog.request.requestId, confirmed: true });
		await expect(answer).resolves.toBe(true);
		// A late abort after settlement must be a no-op (no double-resolve).
		controller.abort();
	});

	it("cancelAll still settles pending dialogs fail-closed", async () => {
		const { adapter } = makeAdapter();
		const ctx = adapter.buildContext(SESSION);
		const confirmAnswer = ctx.confirm("Sure?", "really");
		const selectAnswer = ctx.select("Pick", ["a"]);
		adapter.cancelAll();
		await expect(confirmAnswer).resolves.toBe(false);
		await expect(selectAnswer).resolves.toBeUndefined();
	});
});
