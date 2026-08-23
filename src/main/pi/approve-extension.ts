/**
 * Pi Desktop permission extension (phase 5).
 *
 * Ships with the desktop app and is loaded in-process as an inline
 * ExtensionFactory. Implements the five-mode autonomy ladder (Plan / Always
 * Ask / Ask Before Edits / Accept File Edits / Bypass) by evaluating each
 * `tool_call` against the live mode from ./permissions and routing gated
 * calls through ctx.ui.select, which Pi Desktop bridges to a renderer dialog.
 *
 * Upstream-friendly: uses only the public tool_call veto
 * ({ block: true, reason }) — no pi changes.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "../../shared/pi";
import { PERMISSION_BLOCK_REASONS } from "../../shared/pi";
import { clearSession, getMode } from "./permissions";

interface ToolCallLike {
	toolName: string;
	input?: {
		command?: unknown;
		path?: unknown;
		file_path?: unknown;
	};
}

/** Tools that never require approval in any mode — research must stay free. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

function summarize(event: ToolCallLike): string {
	const input = event.input ?? {};
	if (event.toolName === "bash" && typeof input.command === "string") {
		return `$ ${input.command.slice(0, 400)}`;
	}
	const filePath =
		typeof input.path === "string"
			? input.path
			: typeof input.file_path === "string"
				? input.file_path
				: "(unknown file)";
	return `${event.toolName}: ${filePath}`;
}

/** Does this mode require approval for this tool? */
function isGated(toolName: string, mode: PermissionMode): boolean {
	if (READ_ONLY_TOOLS.has(toolName)) return false;
	if (mode === "bypass") return false;
	if (mode === "plan") return true; // everything except reads is blocked
	if (mode === "alwaysAsk") return true;
	if (mode === "acceptEdits") return toolName === "bash"; // edits pass, bash gates
	return true; // askBeforeEdits: gate everything not read-only
}

/**
 * The permission-mode extension.
 *
 * Takes an accessor for the currently active app session id so handlers can
 * look up that session's mode; pi's tool_call event does not carry one.
 */
export const createPermissionExtension = (
	getAppSessionId: () => string | null,
): ExtensionFactory => {
	// Per-session "always allow this exact call" memory.
	const alwaysAllowed = new Map<string, Set<string>>();

	return ((pi: ExtensionAPI) => {
		pi.on("session_shutdown", () => {
			const sessionId = getAppSessionId();
			if (sessionId !== null) {
				clearSession(sessionId);
				alwaysAllowed.delete(sessionId);
			}
		});

		pi.on("tool_call", async (event, ctx) => {
			const sessionId = getAppSessionId();
			if (sessionId === null) return;
			const mode = getMode(sessionId);

			const summary = summarize(event as ToolCallLike);
			let allowedSet = alwaysAllowed.get(sessionId);
			if (allowedSet?.has(summary) === true) return; // previously always-allowed

			if (!isGated(event.toolName, mode)) return;

			const choice = await ctx.ui.select(
				mode === "plan"
					? "Plan mode — allow this call anyway?"
					: `Allow ${event.toolName}?`,
				[summary, "Allow once", "Always allow this command", "Deny"],
			);

			if (choice === "Always allow this command") {
				allowedSet ??= new Set();
				alwaysAllowed.set(sessionId, allowedSet);
				allowedSet.add(summary);
				return;
			}
			if (choice === "Allow once") return;

			return {
				block: true,
				reason:
					mode === "plan" ? PERMISSION_BLOCK_REASONS.plan : PERMISSION_BLOCK_REASONS.denied,
			};
		});
	}) as ExtensionFactory;
};
