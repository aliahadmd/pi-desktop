/**
 * Adapter that bridges pi extension UI calls (ExtensionUIContext) to the
 * renderer. Dialog methods (select/confirm/input/editor) block until the user
 * answers via `session.respond_ui`; fire-and-forget methods become ui_* events.
 *
 * TUI-specific methods are no-ops — same degraded parity as pi's own RPC mode
 * (see packages/coding-agent/docs/rpc.md §Extension UI Protocol).
 */
import type { AgentSession, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { PiEvent, UiDialogRequest, UiDialogResponse } from "../../shared/pi";

type DialogAnswer = string | undefined | boolean;
type DialogMethod = "select" | "confirm" | "input" | "editor";

interface PendingDialog {
	method: DialogMethod;
	resolve(answer: DialogAnswer): void;
	timer: NodeJS.Timeout | undefined;
}

/** Omit that distributes over unions (keeps variant-specific properties). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class SdkExtensionUiAdapter {
	private readonly onEvent: (event: PiEvent) => void;
	private readonly pending = new Map<string, PendingDialog>();
	private nextId = 0;

	constructor(onEvent: (event: PiEvent) => void) {
		this.onEvent = onEvent;
	}

	respond(response: UiDialogResponse): void {
		const pending = this.pending.get(response.requestId);
		if (pending === undefined) return;
		if (pending.timer !== undefined) clearTimeout(pending.timer);
		this.pending.delete(response.requestId);
		if (response.cancelled === true) {
			pending.resolve(pending.method === "confirm" ? false : undefined);
		} else if (pending.method === "confirm") {
			pending.resolve(response.confirmed === true);
		} else {
			pending.resolve(response.value ?? undefined);
		}
	}

	buildContext(_session: AgentSession): ExtensionUIContext {
		const adapter = this;
		const emit = this.onEvent;

		const ctx: ExtensionUIContext = {
			select(title, options, opts) {
				return adapter.openDialog(
					{ method: "select", title, options },
					opts?.timeout
				) as Promise<string | undefined>;
			},
			confirm(title, message, opts) {
				return adapter.openDialog(
					{ method: "confirm", title, message },
					opts?.timeout
				) as Promise<boolean>;
			},
			input(title, placeholder) {
				return adapter.openDialog(
					placeholder === undefined
						? { method: "input", title }
						: { method: "input", title, placeholder },
					undefined
				) as Promise<string | undefined>;
			},
			editor(title, prefill) {
				return adapter.openDialog(
					prefill === undefined ? { method: "editor", title } : { method: "editor", title, prefill },
					undefined
				) as Promise<string | undefined>;
			},
			notify(message, type) {
				emit({ type: "ui_notify", message, notifyType: type ?? "info" });
			},
			setStatus(key, text) {
				emit(
					text === undefined
						? { type: "ui_status", statusKey: key }
						: { type: "ui_status", statusKey: key, statusText: text }
				);
			},
			onTerminalInput: () => () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget(key, content, options) {
				if (typeof content !== "function") {
					emit(
						content === undefined
							? {
									type: "ui_widget",
									widgetKey: key,
									placement:
										options?.placement === "belowEditor" ? "belowEditor" : "aboveEditor",
								}
							: {
									type: "ui_widget",
									widgetKey: key,
									widgetLines: content,
									placement:
										options?.placement === "belowEditor" ? "belowEditor" : "aboveEditor",
								}
					);
				}
			},
			setFooter: () => {},
			setHeader: () => {},
			setTitle(title) {
				emit({ type: "ui_title", title });
			},
			custom<T>() {
				return Promise.resolve(undefined as T);
			},
			pasteToEditor(text) {
				emit({ type: "ui_editor_text", text });
			},
			setEditorText(text) {
				emit({ type: "ui_editor_text", text });
			},
			getEditorText: () => "",
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false as const, error: "theme switching not supported in desktop app yet" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
			// No TUI theme registry in the desktop app; extensions reading theme
			// metadata get an empty stub (same as RPC mode's degraded parity).
			theme: {} as Theme,
		};

		return ctx;
	}

	/** Open a dialog: assign an id, emit to renderer, wait for respond()/timeout. */
	private openDialog(
		request: DistributiveOmit<UiDialogRequest, "requestId">,
		timeoutMs: number | undefined
	): Promise<DialogAnswer> {
		return new Promise((resolve) => {
			const requestId = `ui_${++this.nextId}`;
			const pending: PendingDialog = {
				method: request.method,
				resolve,
				timer:
					timeoutMs === undefined
						? undefined
						: setTimeout(() => {
								this.pending.delete(requestId);
								resolve(request.method === "confirm" ? false : undefined);
							}, timeoutMs),
			};
			this.pending.set(requestId, pending);
			this.onEvent({ type: "ui_dialog", request: { ...request, requestId } as UiDialogRequest });
		});
	}
}
