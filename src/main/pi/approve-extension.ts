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

interface ToolCallSummary {
	/** Short human-readable form for the dialog title (truncated). */
	display: string;
	/**
	 * Full-length identity for the "always allow" memory (audit 6 L-6): keying
	 * on the truncated display made two commands sharing a prefix collide
	 * fail-open.
	 */
	key: string;
}

function summarize(event: ToolCallLike): ToolCallSummary {
	const input = event.input ?? {};
	if (event.toolName === "bash" && typeof input.command === "string") {
		return { display: `$ ${input.command.slice(0, 200)}`, key: `bash:${input.command}` };
	}
	const filePath =
		typeof input.path === "string"
			? input.path
			: typeof input.file_path === "string"
				? input.file_path
				: "(unknown file)";
	return { display: `${event.toolName}: ${filePath}`, key: `${event.toolName}:${filePath}` };
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
 * The permission-mode extension factory.
 *
 * `getAppSessionId` resolves the app-session id that OWNS the session this
 * extension instance is created for. Audit 5 H-1: a single global accessor
 * (most-recently-opened session) made every concurrent session evaluate tool
 * calls against whichever tab was opened last — tab A could be gated by tab
 * B's mode, or escape plan mode via it. PiService now builds one extension
 * per SDK session with the id bound at creation.
 */
export const createPermissionExtension = (
	getAppSessionId: () => string | null,
): ExtensionFactory => {
	// Per-session "always allow this exact call" memory.
	const alwaysAllowed = new Map<string, Set<string>>();

	return ((pi: ExtensionAPI) => {
		pi.on("session_shutdown", (event) => {
			// session_shutdown also fires on in-place session replacement
			// (reason "new" | "resume" | "fork" | "reload") — the app-session id
			// survives those, so wiping state here would silently reset the user's
			// permission mode mid-tab while the composer chip still shows it
			// (audit 6 H-2). Only a real close ("quit") tears down; the mode is
			// also cleared by PiService.closeSession on tab close.
			if (event.reason !== "quit") return;
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
			if (allowedSet?.has(summary.key) === true) return; // previously always-allowed

			if (!isGated(event.toolName, mode)) return;

			// The summary rides in the title, not as option[0] (audit 6 L-6): when
			// the command itself was the first option, picking the highlighted
			// default *denied* the call. Options are now actions only.
			const choice = await ctx.ui.select(
				mode === "plan"
					? `Plan mode — allow this call anyway? ${summary.display}`
					: `Allow ${event.toolName}? ${summary.display}`,
				["Allow once", "Always allow this command", "Deny"],
			);

			if (choice === "Always allow this command") {
				allowedSet ??= new Set();
				alwaysAllowed.set(sessionId, allowedSet);
				allowedSet.add(summary.key);
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
