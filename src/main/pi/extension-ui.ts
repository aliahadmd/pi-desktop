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

/**
 * Default timeout for blocking dialogs (audit 6 M-1): a dialog the user never
 * answers must not park the agent forever. Matches AuthService's 5-minute
 * login prompt timeout.
 */
const DEFAULT_DIALOG_TIMEOUT_MS = 5 * 60_000;

interface PendingDialog {
	method: DialogMethod;
	/** Idempotent settlement: clears timer/abort listener, removes the entry. */
	settle(answer: DialogAnswer): void;
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
		if (response.cancelled === true) {
			pending.settle(pending.method === "confirm" ? false : undefined);
		} else if (pending.method === "confirm") {
			pending.settle(response.confirmed === true);
		} else {
			pending.settle(response.value ?? undefined);
		}
	}

	buildContext(_session: AgentSession): ExtensionUIContext {
		const adapter = this;
		const emit = this.onEvent;

		const ctx: ExtensionUIContext = {
			select(title, options, opts) {
				return adapter.openDialog(
					{ method: "select", title, options },
					opts?.timeout,
					opts?.signal
				) as Promise<string | undefined>;
			},
			confirm(title, message, opts) {
				return adapter.openDialog(
					{ method: "confirm", title, message },
					opts?.timeout,
					opts?.signal
				) as Promise<boolean>;
			},
			// input() previously dropped its opts entirely (audit 6 L-5).
			input(title, placeholder, opts) {
				return adapter.openDialog(
					placeholder === undefined
						? { method: "input", title }
						: { method: "input", title, placeholder },
					opts?.timeout,
					opts?.signal
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

	/** Open a dialog: assign an id, emit to renderer, wait for respond()/timeout/signal. */
	private openDialog(
		request: DistributiveOmit<UiDialogRequest, "requestId">,
		timeoutMs: number | undefined,
		signal?: AbortSignal
	): Promise<DialogAnswer> {
		return new Promise((resolve) => {
			const requestId = `ui_${++this.nextId}`;
			const effectiveTimeout = timeoutMs ?? DEFAULT_DIALOG_TIMEOUT_MS;
			const cancelAnswer: DialogAnswer = request.method === "confirm" ? false : undefined;
			let onAbort: (() => void) | undefined;
			const pending: PendingDialog = {
				method: request.method,
				timer: undefined,
				settle: (answer) => {
					if (this.pending.get(requestId) !== pending) return; // already settled
					if (pending.timer !== undefined) clearTimeout(pending.timer);
					if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
					this.pending.delete(requestId);
					resolve(answer);
				},
			};
			pending.timer = setTimeout(() => pending.settle(cancelAnswer), effectiveTimeout);
			this.pending.set(requestId, pending);
			// opts.signal (audit 6 L-5): programmatic dismissal resolves fail-closed,
			// the same as a user cancel or timeout.
			if (signal !== undefined) {
				if (signal.aborted) {
					pending.settle(cancelAnswer);
					return;
				}
				onAbort = () => pending.settle(cancelAnswer);
				signal.addEventListener("abort", onAbort, { once: true });
			}
			// Ship the effective deadline with the request so the renderer can
			// show it and dismiss in step with the timer above — a dialog that
			// already timed out main-side must not linger as a dead modal.
			this.onEvent({
				type: "ui_dialog",
				request: { ...request, requestId, timeoutMs: effectiveTimeout } as UiDialogRequest,
			});
		});
	}

	/**
	 * Settle every pending dialog as cancelled (backend dispose / session
	 * replacement) so a gated tool call is never parked on a dead session.
	 */
	cancelAll(): void {
		for (const pending of [...this.pending.values()]) {
			pending.settle(pending.method === "confirm" ? false : undefined);
		}
	}

	/**
	 * Ask the user whether a project's local .pi resources may load (audit 6
	 * C-1). Used for in-place session rebuilds (switch) where the renderer
	 * already knows the session and can serve the dialog. Fails closed on
	 * timeout/cancel.
	 */
	async confirmProjectTrust(cwd: string): Promise<boolean> {
		const answer = await this.openDialog(
			{
				method: "select",
				title: `Load project resources from ${cwd}/.pi? Only trust projects whose code you are willing to run.`,
				options: ["Trust project", "Stay untrusted"],
			},
			DEFAULT_DIALOG_TIMEOUT_MS
		);
		return answer === "Trust project";
	}
}
