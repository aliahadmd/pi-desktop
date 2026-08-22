/**
 * SdkPiBackend — runs pi in-process via @earendil-works/pi-coding-agent's SDK.
 * Default backend: full type safety, no subprocess framing.
 *
 * A provider crash can take the app down; PiService catches unexpected throws
 * and offers reopening the session in RPC (isolation) mode.
 */
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ModelRuntime as PiModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type {
	PiEvent,
	PiModelInfo,
	PiSessionState,
	PiThinkingLevel,
	UiDialogResponse,
} from "../../shared/pi";
import { toJson, type JsonValue } from "../../shared/pi";
import { describeError, type BackendOptions, type IPiBackend, type PromptInput, type SetModelResultInfo } from "./backend";
import { SdkExtensionUiAdapter } from "./extension-ui";

export class SdkPiBackend implements IPiBackend {
	readonly kind = "sdk" as const;

	private session: AgentSession | null = null;
	private runtime: AgentSessionRuntime | null = null;
	private unsubscribe: (() => void) | null = null;
	private modelRuntime: PiModelRuntime | null = null;
	private readonly options: BackendOptions;
	private readonly uiAdapter: SdkExtensionUiAdapter;

	private constructor(options: BackendOptions) {
		this.options = options;
		this.uiAdapter = new SdkExtensionUiAdapter(options.onEvent);
	}

	static create(options: BackendOptions): SdkPiBackend {
		return new SdkPiBackend(options);
	}

	async start(): Promise<void> {
		if (this.session !== null) return;
		const { cwd, sessionPath, name } = this.options;

		this.modelRuntime =
			(this.options.modelRuntime as PiModelRuntime | undefined) ??
			(await ModelRuntime.create());
		const settingsManager = SettingsManager.create(cwd);
		const sessionManager =
			sessionPath !== undefined
				? SessionManager.open(sessionPath)
				: this.options.noSession === true
					? SessionManager.inMemory(cwd)
					: SessionManager.create(cwd);

		const customTools = (this.options.desktopTools ?? []) as import("@earendil-works/pi-coding-agent").ToolDefinition[];
		const scopedModels = (this.options.scopedModels ?? [])
			.map((entry: { provider: string; modelId: string; thinkingLevel?: string }) => {
				const model = this.modelRuntime?.getModel(entry.provider, entry.modelId);
				if (model === undefined) return null;
				return {
					model,
					...(entry.thinkingLevel !== undefined
						? { thinkingLevel: entry.thinkingLevel as never }
						: {}),
				};
			})
			.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

		const runtimeFactory: CreateAgentSessionRuntimeFactory = async ({
			cwd: runtimeCwd,
			agentDir,
			sessionManager: sm,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				...(this.modelRuntime !== null ? { modelRuntime: this.modelRuntime } : {}),
				settingsManager,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: sm,
					...(sessionStartEvent !== undefined ? { sessionStartEvent } : {}),
					...(scopedModels.length > 0 ? { scopedModels } : {}),
					...(customTools.length > 0 ? { customTools } : {}),
				})),
				services,
				diagnostics: [],
			};
		};

		const runtime = await createAgentSessionRuntime(runtimeFactory, {
			cwd,
			agentDir: getAgentDir(),
			sessionManager,
		});
		this.runtime = runtime;
		const session = runtime.session;

		await this.bindToSession(session);
		this.session = session;

		if (name !== undefined) {
			session.setSessionName(name);
		}
	}

	/**
	 * Bind UI adapter + event subscription to a session. Re-invoked on every
	 * session replacement (fork/clone/switch) via AgentSessionRuntime.
	 */
	private async bindToSession(session: AgentSession): Promise<void> {
		await session.bindExtensions({
			uiContext: this.uiAdapter.buildContext(session),
			mode: "rpc", // degraded UI parity: dialogs forwarded, TUI-specific calls no-op
		});
		this.unsubscribe?.();
		this.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			const mapped = mapSdkEventToPiEvent(event);
			if (mapped !== null) this.options.onEvent(mapped);
		});
		this.runtime?.setRebindSession(async (nextSession: AgentSession) => {
			this.session = nextSession;
			await this.bindToSession(nextSession);
		});
	}

	async dispose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.session?.dispose();
		this.session = null;
		this.runtime = null;
	}

	getSessionFile(): string | undefined {
		return this.session?.sessionFile;
	}

	getCwd(): string {
		return this.options.cwd;
	}

	async prompt(input: PromptInput): Promise<void> {
		const session = this.requireSession();
		await session.prompt(input.text, {
			...(input.images !== undefined && input.images.length > 0
				? {
						images: input.images.map((img) => ({
							type: "image" as const,
							data: img.data,
							mimeType: img.mimeType,
						})),
					}
				: {}),
			...(input.streamingBehavior !== undefined
				? { streamingBehavior: input.streamingBehavior }
				: {}),
		});
	}

	async steer(text: string): Promise<void> {
		await this.requireSession().steer(text);
	}

	async followUp(text: string): Promise<void> {
		await this.requireSession().followUp(text);
	}

	async abort(): Promise<void> {
		await this.requireSession().abort();
	}

	async setModel(provider: string, modelId: string): Promise<SetModelResultInfo> {
		const session = this.requireSession();
		const model = session.modelRuntime.getModel(provider, modelId);
		if (model === undefined) {
			throw new Error(`model not found: ${provider}/${modelId}`);
		}
		await session.setModel(model);
		return { provider, id: model.id, name: String(model.name ?? model.id) };
	}

	async cycleModel(): Promise<SetModelResultInfo | null> {
		const result = await this.requireSession().cycleModel();
		if (result === undefined) return null;
		return {
			provider: String(result.model.provider),
			id: result.model.id,
			name: String(result.model.name ?? result.model.id),
		};
	}

	async setThinkingLevel(level: PiThinkingLevel): Promise<PiThinkingLevel> {
		const session = this.requireSession();
		session.setThinkingLevel(level);
		return session.thinkingLevel;
	}

	async getThinkingLevels(): Promise<PiThinkingLevel[]> {
		return this.requireSession().getAvailableThinkingLevels();
	}

	async getAvailableModels(): Promise<PiModelInfo[]> {
		const runtime = this.modelRuntime;
		if (runtime === null) return [];
		const available = await runtime.getAvailable();
		return available.map((m) => ({
			provider: String(m.provider),
			id: m.id,
			name: String(m.name ?? m.id),
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			reasoning: m.reasoning === true,
			input: [...m.input],
			thinkingLevels: [],
		}));
	}

	async compact(customInstructions?: string): Promise<JsonValue> {
		const result = await this.requireSession().compact(customInstructions);
		return toJson(result);
	}

	async getState(): Promise<PiSessionState> {
		const s = this.requireSession();
		const model = s.model;
		return {
			sessionId: s.sessionId,
			sessionFile: s.sessionFile,
			sessionName: s.sessionName,
			model:
				model === undefined
					? undefined
					: {
							provider: String(model.provider),
							id: model.id,
							name: String(model.name ?? model.id),
						},
			thinkingLevel: s.thinkingLevel,
			isStreaming: s.isStreaming,
			isCompacting: s.isCompacting,
			isRetrying: s.isRetrying,
			isBashRunning: s.isBashRunning,
			autoCompactionEnabled: s.autoCompactionEnabled,
			autoRetryEnabled: s.autoRetryEnabled,
			messageCount: s.messages.length,
			pendingMessageCount: s.pendingMessageCount,
		};
	}

	async getMessages(): Promise<JsonValue[]> {
		return this.requireSession().messages.map((m) => toJson(m));
	}

	async getCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
		const session = this.requireSession();
		const prompts = session.resourceLoader.getPrompts().prompts.map((p) => ({
			name: p.name,
			description: p.description,
			source: "prompt",
		}));
		const skills = session.resourceLoader.getSkills().skills.map((sk) => ({
			name: `skill:${sk.name}`,
			description: sk.description,
			source: "skill",
		}));
		return [...prompts, ...skills];
	}

	async getStats(): Promise<JsonValue> {
		return toJson(this.requireSession().getSessionStats());
	}

	async exportHtml(outputPath?: string): Promise<string> {
		return this.requireSession().exportToHtml(outputPath);
	}

	async bash(
		command: string,
		opts?: { excludeFromContext?: boolean }
	): Promise<JsonValue> {
		const result = await this.requireSession().executeBash(command, undefined, {
			...(opts?.excludeFromContext === true ? { excludeFromContext: true } : {}),
		});
		return toJson(result);
	}

	async abortBash(): Promise<void> {
		this.requireSession().abortBash();
	}

	async fork(entryId: string): Promise<{ text?: string; cancelled: boolean }> {
		const result = await this.requireSession().navigateTree(entryId, { summarize: false });
		return result.editorText === undefined
			? { cancelled: result.cancelled }
			: { text: result.editorText, cancelled: result.cancelled };
	}

	async navigateTree(
		entryId: string,
		options?: { summarize?: boolean; customInstructions?: string }
	): Promise<{ text?: string; cancelled: boolean }> {
		const result = await this.requireSession().navigateTree(entryId, {
			...(options?.summarize !== undefined ? { summarize: options.summarize } : {}),
			...(options?.customInstructions !== undefined
				? { customInstructions: options.customInstructions }
				: {}),
		});
		if (result.aborted === true) {
			throw new Error("navigation aborted by extension");
		}
		return result.editorText === undefined
			? { cancelled: result.cancelled }
			: { text: result.editorText, cancelled: result.cancelled };
	}

	async getTree(): Promise<JsonValue> {
		const manager = this.requireSession().sessionManager;
		return toJson(manager.getTree());
	}

	async getEntries(since?: string): Promise<{ entries: JsonValue[]; leafId: string | null }> {
		const manager = this.requireSession().sessionManager;
		const entries = manager.getEntries();
		const startIndex = since === undefined ? 0 : entries.findIndex((e) => e.id === since) + 1;
		if (since !== undefined && startIndex === 0 && entries[0]?.id !== since && entries.length > 0) {
			// cursor not found — treat as full sync from the start
		}
		const slice = since === undefined ? entries : entries.slice(Math.max(startIndex, 0));
		return {
			entries: slice.map((e) => toJson(e)),
			leafId: manager.getLeafEntry()?.id ?? null,
		};
	}

	async clone(): Promise<{ cancelled: boolean }> {
		if (this.runtime === null) throw new Error("runtime not available");
		const leaf = this.runtime.session.sessionManager.getLeafEntry();
		const result = await this.runtime.fork(leaf?.id ?? "", { position: "at" });
		await this.bindToSession(this.runtime.session);
		return { cancelled: result.cancelled };
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		if (this.runtime === null) throw new Error("runtime not available");
		const result = await this.runtime.switchSession(sessionPath);
		await this.bindToSession(this.runtime.session);
		return { cancelled: result.cancelled };
	}

	async exportToJsonl(outputPath?: string): Promise<string> {
		return this.requireSession().exportToJsonl(outputPath);
	}

	async respondUi(response: UiDialogResponse): Promise<void> {
		this.uiAdapter.respond(response);
	}

	private requireSession(): AgentSession {
		if (this.session === null) throw new Error("SDK session not started");
		return this.session;
	}
}

// ---------------------------------------------------------------------------
// Event mapping (AgentSessionEvent → PiEvent)
// ---------------------------------------------------------------------------

export function mapSdkEventToPiEvent(event: AgentSessionEvent): PiEvent | null {
	const mapped = mapSdkEventInner(event);
	if (mapped === null) return null;
	return stripUndefined(mapped) as PiEvent;
}

function mapSdkEventInner(event: AgentSessionEvent): Record<string, unknown> | null {
	switch (event.type) {
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end":
			return { type: "agent_end", willRetry: event.willRetry };
		case "agent_settled":
			return { type: "agent_settled" };
		case "message_update":
			return { type: "message_update", delta: toJson(event.assistantMessageEvent) };
		case "message_start":
		case "message_end":
			return { type: event.type, message: toJson(event.message) };
		case "turn_start":
			return { type: "turn_start" };
		case "turn_end":
			return {
				type: "turn_end",
				message: event.message === undefined ? undefined : toJson(event.message),
				toolResults: event.toolResults?.map((t) => toJson(t)),
			};
		case "summarization_retry_scheduled":
		case "summarization_retry_attempt_start":
		case "summarization_retry_finished":
		case "entry_appended":
			return null;
		case "tool_execution_start":
			return {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: toJson(event.args),
			};
		case "tool_execution_update":
			return {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				partialResult:
					event.partialResult === undefined ? undefined : toJson(event.partialResult),
			};
		case "tool_execution_end":
			return {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result === undefined ? undefined : toJson(event.result),
				isError: event.isError === true,
			};
		case "queue_update":
			return {
				type: "queue_update",
				steering: [...event.steering],
				followUp: [...event.followUp],
			};
		case "compaction_start":
			return { type: "compaction_start", reason: event.reason };
		case "compaction_end":
			return {
				type: "compaction_end",
				reason: event.reason,
				result: event.result === undefined ? undefined : toJson(event.result),
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
			};
		case "auto_retry_start":
			return {
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			};
		case "auto_retry_end":
			return {
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
			};
		case "bash_execution_update":
			return {
				type: "bash_execution_update",
				id: event.id,
				delta: event.delta,
			};
		case "session_info_changed":
			return { type: "session_info_changed", name: event.name };
		case "thinking_level_changed":
			return { type: "thinking_level_changed", level: event.level };
		default:
			// entry_appended and summarization_retry_* are internal for now.
			return null;
	}
}

export { describeError };

/** Remove undefined-valued properties (exactOptionalPropertyTypes friendliness). */
function stripUndefined<T extends object>(obj: T): T {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) out[key] = value;
	}
	return out as T;
}
