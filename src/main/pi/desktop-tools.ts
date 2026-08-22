/**
 * Desktop tools bundle (chapter 12): custom pi tools giving the agent native
 * desktop capabilities. Registered via the SDK `customTools` option — runs in
 * the main process with scoped-path enforcement for anything filesystem-bound.
 */
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface DesktopToolsDeps {
	notify(title: string, body: string): void;
	writeClipboard(text: string): void;
	assertRealScoped(path: string): Promise<string>;
	showItemInFolder(path: string): void;
}

export function createDesktopTools(deps: DesktopToolsDeps): ToolDefinition[] {
	return [
		defineTool({
			name: "desktop_notify",
			label: "Notify (desktop)",
			description:
				"Show a native macOS notification to the user. Use to alert the user when a long task finishes or needs attention.",
			parameters: Type.Object({
				title: Type.String({ description: "Notification title" }),
				body: Type.String({ description: "Notification body" }),
			}),
			execute: async (_toolCallId, params) => {
				deps.notify(params.title, params.body);
				return {
					content: [{ type: "text", text: "Notification shown." }],
					details: {},
				};
			},
		}),

		defineTool({
			name: "desktop_clipboard_write",
			label: "Clipboard write",
			description:
				"Copy text to the system clipboard. Useful for handing back code blocks, commands, or URLs to the user.",
			parameters: Type.Object({
				text: Type.String({ description: "Text to copy" }),
			}),
			execute: async (_toolCallId, params) => {
				deps.writeClipboard(params.text);
				return {
					content: [{ type: "text", text: `Copied ${params.text.length} chars to clipboard.` }],
					details: {},
				};
			},
		}),

		defineTool({
			name: "desktop_open_path",
			label: "Reveal in Finder",
			description:
				'Reveal a file or directory in Finder. Path must be inside the current project. Prefer relative paths from the project root.',
			parameters: Type.Object({
				path: Type.String({ description: "File or directory path (project-relative or absolute)" }),
			}),
			execute: async (_toolCallId, params) => {
				try {
					const scoped = await deps.assertRealScoped(params.path);
					deps.showItemInFolder(scoped);
					return {
						content: [{ type: "text", text: `Revealed in Finder: ${scoped}` }],
						details: {},
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: `Refused: ${message}` }],
						details: {},
					};
				}
			},
		}),
	];
}
