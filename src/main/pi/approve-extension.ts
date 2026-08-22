/**
 * Pi Desktop approval extension.
 *
 * Ships with the desktop app and is loaded in-process as an inline
 * ExtensionFactory (see PiService.setExtensionFactories) when "confirm before
 * apply" mode is enabled. Routes bash/edit/write tool calls through
 * ctx.ui.confirm, which Pi Desktop bridges to a native dialog.
 * Upstream-friendly: uses only public extension APIs.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

interface ToolCallLike {
	toolName: string;
	input?: {
		command?: unknown;
		path?: unknown;
		file_path?: unknown;
	};
}

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

/** Confirm-before-apply gate: routes bash/edit/write through ctx.ui.confirm. */
export const approveExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.on("tool_call", async (event, ctx) => {
		if (
			event.toolName !== "bash" &&
			event.toolName !== "edit" &&
			event.toolName !== "write"
		) {
			return;
		}
		const ok = await ctx.ui.confirm(
			`Allow ${event.toolName}?`,
			summarize(event as ToolCallLike)
		);
		if (!ok) {
			return { block: true, reason: "Denied by user in Pi Desktop." };
		}
	});
};
