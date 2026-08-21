/**
 * RpcPiBackend — drives one pi session through a `pi --mode rpc` subprocess.
 *
 * Protocol: JSONL over stdin/stdout (see pi docs/rpc.md). Framing is strict:
 * LF-delimited only (JsonlLineReader), request correlation by id, 30 s default
 * command timeout, extension UI dialogs answered via `extension_ui_response`.
 *
 * Binary resolution order:
 *  1. PI_DESKTOP_PI_PATH env — an executable command run directly (tests point
 *     this at a fake responder script).
 *  2. Bundled CLI: Electron run-as-node + @earendil-works/pi-coding-agent cli.js
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
	PiEvent,
	PiModelInfo,
	PiSessionState,
	PiThinkingLevel,
	UiDialogRequest,
	UiDialogResponse,
} from "../../shared/pi";
import type { JsonValue } from "../../shared/pi";
import { safeJson, describeError, type BackendOptions, type IPiBackend, type PromptInput, type SetModelResultInfo } from "./backend";
import { JsonlLineReader } from "./jsonl-reader";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

interface PendingDialog {
	method: UiDialogRequest["method"];
}

export interface RpcBackendLaunchOptions {
	/** Explicit command to spawn (executable). Overrides all defaults. */
	command?: string;
	/** Args appended after the base RPC flags (only for default resolution). */
	extraArgs?: string[];
}

export class RpcPiBackend implements IPiBackend {
	readonly kind = "rpc" as const;

	private readonly options: BackendOptions;
	private readonly launch: RpcBackendLaunchOptions;
	private proc: ChildProcess | null = null;
	private reader = new JsonlLineReader();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly pendingDialogs = new Map<string, PendingDialog>();
	private requestId = 0;
	private stderrTail: string[] = [];
	private started = false;
	private disposed = false;

	private constructor(options: BackendOptions, launch: RpcBackendLaunchOptions) {
		this.options = options;
		this.launch = launch;
	}

	static create(options: BackendOptions, launch: RpcBackendLaunchOptions = {}): RpcPiBackend {
		return new RpcPiBackend(options, launch);
	}

	async start(): Promise<void> {
		if (this.started) return;
		const { command, args, env } = this.resolveLaunch();
		const child = spawn(command, args, {
			cwd: this.options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = child;
		this.started = true;

		child.stdout?.on("data", (chunk: Buffer) => {
			this.consumeStdout(chunk.toString("utf8"));
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail.push(chunk.toString("utf8"));
			if (this.stderrTail.length > 50) this.stderrTail.shift();
		});
		child.on("error", (error) => {
			this.options.onDied(`spawn failed: ${describeError(error)}`);
		});
		child.on("exit", (code, signal) => {
			if (this.disposed) return;
			this.rejectAllPending(`pi rpc process exited (code=${String(code)} signal=${String(signal)})`);
			this.options.onDied(
				`pi rpc process exited unexpectedly (code=${String(code)}) stderr: ${this.getStderrTail()}`
			);
		});
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const child = this.proc;
		this.proc = null;
		this.rejectAllPending("backend disposed");
		if (child === null || child.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 2_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}

	// -------------------------------------------------------------------------
	// IPiBackend commands
	// -------------------------------------------------------------------------

	getSessionFile(): string | undefined {
		// Cheap: requires round-trip in RPC mode, so callers use getState().
		return undefined;
	}

	getCwd(): string {
		return this.options.cwd;
	}

	async prompt(input: PromptInput): Promise<void> {
		const command: Record<string, unknown> = { type: "prompt", message: input.text };
		if (input.images !== undefined) {
			command.images = input.images.map((img) => ({
				type: "image",
				data: img.data,
				mimeType: img.mimeType,
			}));
		}
		if (input.streamingBehavior !== undefined) {
			command.streamingBehavior = input.streamingBehavior;
		}
		await this.request(command);
	}

	async steer(text: string): Promise<void> {
		await this.request({ type: "steer", message: text });
	}

	async followUp(text: string): Promise<void> {
		await this.request({ type: "follow_up", message: text });
	}

	async abort(): Promise<void> {
		await this.request({ type: "abort" });
	}

	async setModel(provider: string, modelId: string): Promise<SetModelResultInfo> {
		const data = (await this.request({ type: "set_model", provider, modelId })) as {
			provider: string;
			id: string;
		};
		return { provider: data.provider, id: data.id, name: data.id };
	}

	async cycleModel(): Promise<SetModelResultInfo | null> {
		const data = (await this.request({ type: "cycle_model" })) as {
			model: { provider: string; id: string };
		} | null;
		if (data === null || data.model === undefined) return null;
		return { provider: data.model.provider, id: data.model.id, name: data.model.id };
	}

	async setThinkingLevel(level: PiThinkingLevel): Promise<PiThinkingLevel> {
		await this.request({ type: "set_thinking_level", level });
		return level;
	}

	async getThinkingLevels(): Promise<PiThinkingLevel[]> {
		const data = (await this.request({ type: "get_available_thinking_levels" })) as {
			levels: PiThinkingLevel[];
		};
		return data.levels;
	}

	async getAvailableModels(): Promise<PiModelInfo[]> {
		const data = (await this.request({ type: "get_available_models" })) as {
			models: Array<{ provider: string; id: string; contextWindow: number; reasoning: boolean }>;
		};
		return data.models.map((m) => ({
			provider: m.provider,
			id: m.id,
			name: m.id,
			contextWindow: m.contextWindow,
			maxTokens: 0,
			reasoning: m.reasoning,
			input: [],
			thinkingLevels: [],
		}));
	}

	async compact(customInstructions?: string): Promise<JsonValue> {
		const command: Record<string, unknown> = { type: "compact" };
		if (customInstructions !== undefined) command.customInstructions = customInstructions;
		const data = await this.request(command);
		return safeJson(data);
	}

	async getState(): Promise<PiSessionState> {
		const data = (await this.request({ type: "get_state" })) as {
			sessionId: string;
			sessionFile?: string;
			sessionName?: string;
			model?: { provider: string; id: string } | null;
			thinkingLevel: PiThinkingLevel;
			isStreaming: boolean;
			isCompacting: boolean;
			autoCompactionEnabled: boolean;
			messageCount: number;
			pendingMessageCount: number;
		};
		return {
			sessionId: data.sessionId,
			sessionFile: data.sessionFile,
			sessionName: data.sessionName,
			model:
				data.model !== null && data.model !== undefined
					? { provider: data.model.provider, id: data.model.id, name: data.model.id }
					: undefined,
			thinkingLevel: data.thinkingLevel,
			isStreaming: data.isStreaming,
			isCompacting: data.isCompacting,
			isRetrying: false, // not exposed by get_state
			isBashRunning: false, // not exposed by get_state
			autoCompactionEnabled: data.autoCompactionEnabled,
			autoRetryEnabled: false, // not exposed by get_state
			messageCount: data.messageCount,
			pendingMessageCount: data.pendingMessageCount,
		};
	}

	async getMessages(): Promise<JsonValue[]> {
		const data = (await this.request({ type: "get_messages" })) as { messages: unknown[] };
		return data.messages.map((m) => safeJson(m));
	}

	async getCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
		const data = (await this.request({ type: "get_commands" })) as {
			commands: Array<{ name: string; description?: string; source: string }>;
		};
		return data.commands;
	}

	async getStats(): Promise<JsonValue> {
		const data = await this.request({ type: "get_session_stats" });
		return safeJson(data);
	}

	async exportHtml(outputPath?: string): Promise<string> {
		const command: Record<string, unknown> = { type: "export_html" };
		if (outputPath !== undefined) command.outputPath = outputPath;
		const data = (await this.request(command)) as { path: string };
		return data.path;
	}

	async bash(command: string): Promise<JsonValue> {
		const data = await this.request({ type: "bash", command });
		return safeJson(data);
	}

	async abortBash(): Promise<void> {
		await this.request({ type: "abort_bash" });
	}

	async fork(entryId: string): Promise<{ text?: string; cancelled: boolean }> {
		const data = (await this.request({ type: "fork", entryId })) as {
			text?: string;
			cancelled: boolean;
		};
		return data;
	}

	async respondUi(response: UiDialogResponse): Promise<void> {
		const dialog = this.pendingDialogs.get(response.requestId);
		this.pendingDialogs.delete(response.requestId);
		const payload: Record<string, unknown> = {
			type: "extension_ui_response",
			id: response.requestId,
		};
		if (response.cancelled === true) {
			payload.cancelled = true;
		} else if (dialog?.method === "confirm") {
			payload.confirmed = response.confirmed === true;
		} else {
			payload.value = response.value ?? "";
		}
		this.writeLine(JSON.stringify(payload));
	}

	/**
	 * Send a raw RPC command (escape hatch for protocol features that do not
	 * map 1:1 onto IPiBackend yet). Exposed for tests and future chapters.
	 */
	rawRequest(command: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
		return this.request(command, timeoutMs);
	}

	// -------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------

	private resolveLaunch(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
		const override = this.launch.command ?? process.env.PI_DESKTOP_PI_PATH;
		const baseArgs = [
			"--mode",
			"rpc",
			...(this.options.name !== undefined ? ["--name", this.options.name] : []),
			...(this.options.sessionPath !== undefined
				? ["--session", this.options.sessionPath]
				: []),
			...(this.options.noSession === true ? ["--no-session"] : []),
			...(this.launch.extraArgs ?? []),
		];
		if (override !== undefined && override.length > 0) {
			return { command: override, args: baseArgs, env: { ...process.env } };
		}
		const appRoot = process.cwd();
		const cliJs = path.join(
			appRoot,
			"node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
		);
		if (!existsSync(cliJs)) {
			throw new Error(
				`pi CLI not found at ${cliJs}; set PI_DESKTOP_PI_PATH to a pi executable`
			);
		}
		// Run the bundled CLI with Electron's embedded Node.
		return {
			command: process.execPath,
			args: [cliJs, ...baseArgs],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		};
	}

	private consumeStdout(chunk: string): void {
		for (const line of this.reader.push(chunk)) {
			if (line.trim().length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				this.options.onEvent({
					type: "backend_warning",
					reason: `unparseable stdout line: ${line.slice(0, 120)}`,
				});
				continue;
			}
			try {
				this.handleMessage(parsed as Record<string, unknown>);
			} catch (error) {
				this.options.onEvent({
					type: "backend_warning",
					reason: `failed to process message: ${describeError(error)}`,
				});
			}
		}
	}

	private handleMessage(msg: Record<string, unknown>): void {
		const type = msg["type"];
		if (type === "response") {
			const id = msg["id"];
			const pending = typeof id === "string" ? this.pending.get(id) : undefined;
			if (pending === undefined) return;
			this.pending.delete(id as string);
			clearTimeout(pending.timer);
			if (msg["success"] === true) {
				pending.resolve(msg["data"]);
			} else {
				pending.reject(new Error(String(msg["error"] ?? "command failed")));
			}
			return;
		}
		if (type === "extension_ui_request") {
			this.handleUiRequest(msg);
			return;
		}
		const event = mapRpcEventToPiEvent(msg);
		if (event !== null) this.options.onEvent(event);
	}

	private handleUiRequest(msg: Record<string, unknown>): void {
		const id = String(msg["id"]);
		const method = msg["method"];
		switch (method) {
			case "select":
			case "confirm":
			case "input":
			case "editor": {
				this.pendingDialogs.set(id, { method });
				const request = mapUiDialog(msg, id);
				this.options.onEvent({ type: "ui_dialog", request });
				return;
			}
			case "notify":
				this.options.onEvent({
					type: "ui_notify",
					message: String(msg["message"] ?? ""),
					notifyType: (msg["notifyType"] as "info" | "warning" | "error") ?? "info",
				});
				return;
			case "setStatus": {
				const statusKey = String(msg["statusKey"] ?? "");
				const rawStatus = msg["statusText"];
				this.options.onEvent(
					rawStatus === undefined || rawStatus === null
						? { type: "ui_status", statusKey }
						: { type: "ui_status", statusKey, statusText: String(rawStatus) }
				);
				return;
			}
			case "setWidget": {
				const widgetKey = String(msg["widgetKey"] ?? "");
				const placement =
					msg["widgetPlacement"] === "belowEditor" ? ("belowEditor" as const) : ("aboveEditor" as const);
				this.options.onEvent(
					Array.isArray(msg["widgetLines"])
						? { type: "ui_widget", widgetKey, widgetLines: msg["widgetLines"] as string[], placement }
						: { type: "ui_widget", widgetKey, placement }
				);
				return;
			}
			case "setTitle":
				this.options.onEvent({ type: "ui_title", title: String(msg["title"] ?? "") });
				return;
			case "set_editor_text":
				this.options.onEvent({ type: "ui_editor_text", text: String(msg["text"] ?? "") });
				return;
			default:
				return;
		}
	}

	private request(command: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
		const child = this.proc;
		if (child === null || child.stdin === null || !child.stdin.writable) {
			return Promise.reject(new Error("RPC process is not running"));
		}
		const id = `req_${++this.requestId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timeout waiting for response to ${String(command.type)}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.writeLine(JSON.stringify({ ...command, id }));
		});
	}

	private writeLine(line: string): void {
		const stdin = this.proc?.stdin;
		if (stdin === null || stdin === undefined || stdin.destroyed) {
			throw new Error("RPC process stdin is not available");
		}
		stdin.write(`${line}\n`);
	}

	private rejectAllPending(reason: string): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
			this.pending.delete(id);
		}
	}

	private getStderrTail(): string {
		return this.stderrTail.join("").slice(-500);
	}
}

// ---------------------------------------------------------------------------
// Event mapping (JsonAgentSessionEvent → PiEvent)
// ---------------------------------------------------------------------------

export function mapRpcEventToPiEvent(msg: Record<string, unknown>): PiEvent | null {
	const mapped = mapRpcEventInner(msg);
	if (mapped === null) return null;
	return stripUndefined(mapped) as PiEvent;
}

function mapRpcEventInner(msg: Record<string, unknown>): Record<string, unknown> | null {
	const type = msg["type"];
	switch (type) {
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end":
			return { type: "agent_end", willRetry: msg["willRetry"] === true };
		case "agent_settled":
			return { type: "agent_settled" };
		case "message_update":
			return {
				type: "message_update",
				usage: safeJson(msg["usage"]),
				delta: safeJson(msg["assistantMessageEvent"]),
			};
		case "message_start":
		case "message_end":
			return { type, message: safeJson(msg["message"]) };
		case "turn_start":
			return { type: "turn_start" };
		case "turn_end":
			return stripUndefined({
				type: "turn_end" as const,
				message: msg["message"] === undefined ? undefined : safeJson(msg["message"]),
				toolResults: Array.isArray(msg["toolResults"])
					? (msg["toolResults"] as unknown[]).map((t) => safeJson(t))
					: undefined,
			});
		case "tool_execution_start":
			return {
				type: "tool_execution_start",
				toolCallId: String(msg["toolCallId"] ?? ""),
				toolName: String(msg["toolName"] ?? ""),
				args: msg["args"] === undefined ? undefined : safeJson(msg["args"]),
			};
		case "tool_execution_update":
			return {
				type: "tool_execution_update",
				toolCallId: String(msg["toolCallId"] ?? ""),
				toolName: String(msg["toolName"] ?? ""),
				partialResult:
					msg["partialResult"] === undefined ? undefined : safeJson(msg["partialResult"]),
			};
		case "tool_execution_end":
			return {
				type: "tool_execution_end",
				toolCallId: String(msg["toolCallId"] ?? ""),
				toolName: String(msg["toolName"] ?? ""),
				result: msg["result"] === undefined ? undefined : safeJson(msg["result"]),
				isError: msg["isError"] === true,
			};
		case "queue_update":
			return {
				type: "queue_update",
				steering: (msg["steering"] as string[]) ?? [],
				followUp: (msg["followUp"] as string[]) ?? [],
			};
		case "compaction_start":
			return {
				type: "compaction_start",
				reason: (msg["reason"] as "manual" | "threshold" | "overflow") ?? "manual",
			};
		case "compaction_end":
			return {
				type: "compaction_end",
				reason: (msg["reason"] as "manual" | "threshold" | "overflow") ?? "manual",
				result: msg["result"] === undefined ? undefined : safeJson(msg["result"]),
				aborted: msg["aborted"] === true,
				willRetry: msg["willRetry"] === true,
				errorMessage:
					msg["errorMessage"] === undefined ? undefined : String(msg["errorMessage"]),
			};
		case "auto_retry_start":
			return {
				type: "auto_retry_start",
				attempt: Number(msg["attempt"] ?? 0),
				maxAttempts: Number(msg["maxAttempts"] ?? 0),
				delayMs: Number(msg["delayMs"] ?? 0),
				errorMessage: String(msg["errorMessage"] ?? ""),
			};
		case "auto_retry_end":
			return {
				type: "auto_retry_end",
				success: msg["success"] === true,
				attempt: Number(msg["attempt"] ?? 0),
				finalError:
					msg["finalError"] === undefined ? undefined : String(msg["finalError"]),
			};
		case "bash_execution_update":
			return {
				type: "bash_execution_update",
				id: msg["id"] === undefined ? undefined : String(msg["id"]),
				delta: String(msg["delta"] ?? ""),
			};
		case "session_info_changed":
			return {
				type: "session_info_changed",
				name: msg["name"] === undefined ? undefined : String(msg["name"]),
			};
		case "thinking_level_changed":
			return { type: "thinking_level_changed", level: msg["level"] as PiThinkingLevel };
		default:
			return null;
	}
}

function mapUiDialog(msg: Record<string, unknown>, id: string): UiDialogRequest {
	const method = msg["method"];
	const timeoutRaw = msg["timeout"];
	const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
	switch (method) {
		case "select": {
			const base = {
				requestId: id,
				method: "select" as const,
				title: String(msg["title"] ?? "Select"),
				options: (msg["options"] as string[]) ?? [],
			};
			return timeoutMs === undefined ? base : { ...base, timeoutMs };
		}
		case "confirm": {
			const base = {
				requestId: id,
				method: "confirm" as const,
				title: String(msg["title"] ?? "Confirm"),
				message: String(msg["message"] ?? ""),
			};
			return timeoutMs === undefined ? base : { ...base, timeoutMs };
		}
		case "input": {
			const rawPlaceholder = msg["placeholder"];
			const base = {
				requestId: id,
				method: "input" as const,
				title: String(msg["title"] ?? "Input"),
			};
			if (rawPlaceholder === undefined) return base;
			return { ...base, placeholder: String(rawPlaceholder) };
		}
		case "editor": {
			const rawPrefill = msg["prefill"];
			const base = {
				requestId: id,
				method: "editor" as const,
				title: String(msg["title"] ?? "Edit"),
			};
			if (rawPrefill === undefined) return base;
			return { ...base, prefill: String(rawPrefill) };
		}
		default:
			throw new Error(`unknown dialog method: ${String(method)}`);
	}
}

/** Remove undefined-valued properties (exactOptionalPropertyTypes friendliness). */
function stripUndefined<T extends object>(obj: T): T {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) out[key] = value;
	}
	return out as T;
}
