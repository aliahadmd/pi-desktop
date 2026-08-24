/**
 * The permission ladder applied to manual editor saves (fs.write).
 *
 * Decision under test: Plan mode is read-only research, so it blocks the
 * editor's saves exactly as it blocks the agent's writes — otherwise the same
 * window would both enforce and ignore the mode. Every other mode allows the
 * save without a prompt, because a ⌘S is already an explicit user action and a
 * second confirmation would add a click without adding a decision.
 *
 * This mirrors the gate in src/main/index.ts's "fs.write" handler; the handler
 * itself needs a live Electron app, so the rule is asserted against the same
 * permissions store the handler reads.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearSession,
	getDefaultMode,
	getMode,
	setDefaultMode,
	setMode,
} from "../../src/main/pi/permissions";
import { DEFAULT_PERMISSION_MODE, permissionModes } from "../../src/shared/pi";

/** The handler's rule, kept in one place so the test states it exactly. */
function saveAllowed(sessionId: string | undefined): boolean {
	const mode = sessionId !== undefined && sessionId !== "" ? getMode(sessionId) : getDefaultMode();
	return mode !== "plan";
}

beforeEach(() => {
	setDefaultMode(DEFAULT_PERMISSION_MODE);
	clearSession("s1");
	clearSession("s2");
});

describe("fs.write permission gating", () => {
	it("blocks saves in plan mode", () => {
		setMode("s1", "plan");
		expect(saveAllowed("s1")).toBe(false);
	});

	it("allows saves in every non-plan mode", () => {
		for (const mode of permissionModes.filter((m) => m !== "plan")) {
			setMode("s1", mode);
			expect(saveAllowed("s1"), `${mode} should allow manual saves`).toBe(true);
		}
	});

	it("gates by the session's own mode, not another session's", () => {
		// Audit-5 H-1 in miniature: with two tabs open, a save must follow the
		// mode of the session it belongs to.
		setMode("s1", "plan");
		setMode("s2", "acceptEdits");
		expect(saveAllowed("s1")).toBe(false);
		expect(saveAllowed("s2")).toBe(true);
	});

	it("falls back to the default mode when no session is supplied", () => {
		setDefaultMode("plan");
		expect(saveAllowed(undefined)).toBe(false);
		setDefaultMode("askBeforeEdits");
		expect(saveAllowed(undefined)).toBe(true);
	});

	it("treats an empty session id as no session", () => {
		setDefaultMode("plan");
		expect(saveAllowed("")).toBe(false);
	});

	it("stops blocking once the session leaves plan mode", () => {
		setMode("s1", "plan");
		expect(saveAllowed("s1")).toBe(false);
		setMode("s1", "askBeforeEdits");
		expect(saveAllowed("s1")).toBe(true);
	});
});
