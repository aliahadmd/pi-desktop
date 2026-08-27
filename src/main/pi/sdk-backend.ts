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
	hasTrustRequiringProjectResources,
	ModelRuntime,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	type ModelRuntime as PiModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type {
	PiCommandInfo,
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
		const sessionManager =
			sessionPath !== undefined
				? SessionManager.open(sessionPath)
				: this.options.noSession === true
					? SessionManager.inMemory(cwd)
					: SessionManager.create(cwd);

		const customTools = (this.options.desktopTools ?? []) as import("@earendil-works/pi-coding-agent").ToolDefinition[];
		const extensionFactories = (this.options.extensionFactories ?? []) as
			import("@earendil-works/pi-coding-agent").InlineExtension[];
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
			// Audit 6 C-1 + M-12: per-invocation settings manager at the runtime's
			// cwd (a session switch must load the TARGET project's settings), with
			// project trust resolved from the user's trust.json decisions —
			// mirroring upstream's CLI bootstrap (main.ts resolveProjectTrusted).
			// Projects with trust-requiring .pi resources and no recorded decision
			// load UNTRUSTED (fail closed) until the user grants trust.
			const trustStore = new ProjectTrustStore(agentDir);
			const requiresTrust = hasTrustRequiringProjectResources(runtimeCwd);
			const knownDecision = requiresTrust ? trustStore.get(runtimeCwd) : null;
			const projectTrusted = requiresTrust ? knownDecision === true : true;
			const settingsManager = SettingsManager.create(runtimeCwd, agentDir, {
				projectTrusted,
			});
			// The renderer pre-flight (session.check_trust / grant_trust) covers
			// initial creation; an in-place rebuild (switch) into an
			// unknown-decision project can be prompted inline because the renderer
			// already knows this session.
			const canPromptInline = sessionStartEvent !== undefined;
			// Inline extension factories are SDK-mode only: a function cannot cross the
			// `pi --mode rpc` subprocess boundary. RPC sessions run without the gate.
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				...(this.modelRuntime !== null ? { modelRuntime: this.modelRuntime } : {}),
				settingsManager,
				...(requiresTrust && knownDecision === null && canPromptInline
					? {
							resourceLoaderReloadOptions: {
								resolveProjectTrust: async () => {
									const trusted = await this.uiAdapter.confirmProjectTrust(runtimeCwd);
									trustStore.set(runtimeCwd, trusted);
									return trusted;
								},
							},
						}
					: {}),
				...(extensionFactories.length > 0
					? { resourceLoaderOptions: { extensionFactories } }
					: {}),
			});
			// Audit 6 M-8: surface extension/settings diagnostics instead of
			// dropping them — upstream's CLI factory reports these; the desktop
			// returned `diagnostics: []` and a broken extension failed silently.
			const diagnostics = collectStartupDiagnostics(services);
			this.emitDiagnostics(diagnostics);
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: sm,
					...(sessionStartEvent !== undefined ? { sessionStartEvent } : {}),
					...(scopedModels.length > 0 ? { scopedModels } : {}),
					...(customTools.length > 0 ? { customTools } : {}),
				})),
				services,
				diagnostics,
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
			// Stale dialogs belong to the torn-down session — answering them later
			// would resolve a veto in a session that no longer runs.
			this.uiAdapter.cancelAll();
			await this.bindToSession(nextSession);
		});
	}

	async dispose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.uiAdapter.cancelAll();
		// Dispose through the runtime so extensions receive session_shutdown
		// ("quit") and release their resources (audit 6 M-9); fall back to the
		// bare session when start() never completed.
		if (this.runtime !== null) {
			await this.runtime.dispose().catch(() => {});
		} else {
			this.session?.dispose();
		}
		this.session = null;
		this.runtime = null;
	}

	getSessionFile(): string | undefined {
		return this.session?.sessionFile;
	}

	getCwd(): string {
		return this.currentCwd();
	}

	/**
	 * Live cwd of the open session.
	 *
	 * `switchSession` rebuilds the runtime at the target session's cwd, so the
	 * boot-time `options.cwd` goes stale the moment a switch lands. The session
	 * manager is the runtime's own source of truth (upstream reads the target
	 * session header into it), so ask it and fall back to the boot value only
	 * when no session is open yet.
	 */
	private currentCwd(): string {
		const cwd = this.session?.sessionManager.getCwd();
		return cwd !== undefined && cwd.length > 0 ? cwd : this.options.cwd;
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

	async getCommands(): Promise<PiCommandInfo[]> {
		const session = this.requireSession();
		const prompts = session.resourceLoader.getPrompts().prompts.map(
			(p): PiCommandInfo => ({
				name: p.name,
				description: p.description,
				source: "prompt",
				path: p.filePath,
				...(p.argumentHint !== undefined ? { argumentHint: p.argumentHint } : {}),
			})
		);
		const skills = session.resourceLoader.getSkills().skills.map(
			(sk): PiCommandInfo => ({
				name: `skill:${sk.name}`,
				description: sk.description,
				source: "skill",
				path: sk.filePath,
			})
		);
		// Extension-registered slash commands were missing entirely, so packages
		// that register commands were invisible in SDK sessions (the default).
		// Upstream builds its own catalog the same way; the runner may throw if
		// extensions failed to load, so treat it as best-effort.
		let extensions: PiCommandInfo[] = [];
		try {
			extensions = session.extensionRunner.getRegisteredCommands().map(
				(command): PiCommandInfo => ({
					name: command.invocationName,
					...(command.description !== undefined ? { description: command.description } : {}),
					source: "extension",
					// No `path`: handlers are code, not fetchable markdown. The
					// browser degrades these to a plain `/name` insert.
				})
			);
		} catch {
			extensions = [];
		}
		return [...extensions, ...prompts, ...skills];
	}

	async getStats(): Promise<JsonValue> {
		return toJson(this.requireSession().getSessionStats());
	}

	async exportHtml(outputPath?: string): Promise<string> {
		return this.requireSession().exportToHtml(outputPath);
	}

	async bash(
		command: string,
		opts?: { excludeFromContext?: boolean; requestId?: string }
	): Promise<JsonValue> {
		const result = await this.requireSession().executeBash(command, undefined, {
			...(opts?.excludeFromContext === true ? { excludeFromContext: true } : {}),
			...(opts?.requestId !== undefined ? { id: opts.requestId } : {}),
		});
		return toJson(result);
	}

	async abortBash(): Promise<void> {
		this.requireSession().abortBash();
	}

	async fork(entryId: string): Promise<{ text?: string; cancelled: boolean }> {
		const result = await this.requireSession().navigateTree(entryId, { summarize: false });
		if (result.aborted === true) {
			throw new Error("navigation aborted by extension");
		}
		// The active branch changed — re-hydrate like navigateTree does (audit 6 M-5).
		void this.notifyReplaced().catch(() => {});
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
		void this.notifyReplaced().catch(() => {});
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
		const startIndex =
			since === undefined ? 0 : entries.findIndex((e) => e.id === since) + 1;
		// Cursor not found → startIndex 0 → full resync from the start.
		const slice = since === undefined ? entries : entries.slice(Math.max(startIndex, 0));
		return {
			entries: slice.map((e) => toJson(e)),
			leafId: manager.getLeafEntry()?.id ?? null,
		};
	}

	async clone(): Promise<{ cancelled: boolean }> {
		if (this.runtime === null) throw new Error("runtime not available");
		const leaf = this.runtime.session.sessionManager.getLeafEntry();
		if (leaf === undefined) {
			throw new Error("nothing to clone: session has no entries yet");
		}
		const result = await this.runtime.fork(leaf.id, { position: "at" });
		await this.notifyReplaced();
		return { cancelled: result.cancelled };
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		if (this.runtime === null) throw new Error("runtime not available");
		const result = await this.runtime.switchSession(sessionPath);
		await this.notifyReplaced();
		return { cancelled: result.cancelled };
	}

	/**
	 * After a session replacement, tell the renderer to re-hydrate and report
	 * the fresh identity/cwd so scoping (roots, dock header) stays correct.
	 */
	private async notifyReplaced(): Promise<void> {
		const session = this.requireSession();
		this.options.onEvent({
			type: "session_replaced",
			sessionId: session.sessionId,
			...(session.sessionFile !== undefined ? { sessionFile: session.sessionFile } : {}),
			cwd: this.currentCwd(),
		});
	}

	async renameSession(name: string): Promise<void> {
		this.requireSession().setSessionName(name);
	}

	async exportToJsonl(outputPath?: string): Promise<string> {
		return this.requireSession().exportToJsonl(outputPath);
	}

	async respondUi(response: UiDialogResponse): Promise<void> {
		this.uiAdapter.respond(response);
	}

	/**
	 * Forward startup diagnostics as backend_warning events (audit 6 M-8).
	 *
	 * Deferred one macrotask: on initial creation the factory runs before
	 * `session.create` resolves, and the renderer drops events for sessions it
	 * does not know yet. The invoke response and these events travel the same
	 * FIFO channel, so after the deferral the session registration always wins.
	 */
	private emitDiagnostics(diagnostics: AgentSessionRuntimeDiagnostic[]): void {
		if (diagnostics.length === 0) return;
		setTimeout(() => {
			for (const diagnostic of diagnostics) {
				this.options.onEvent({
					type: "backend_warning",
					reason: `[${diagnostic.type}] ${diagnostic.message}`,
				});
			}
		}, 0);
	}

	private requireSession(): AgentSession {
		if (this.session === null) throw new Error("SDK session not started");
		return this.session;
	}
}

// ---------------------------------------------------------------------------
// Event mapping (AgentSessionEvent → PiEvent)
// ---------------------------------------------------------------------------

/**
 * Collect non-fatal setup issues (audit 6 M-8): services diagnostics plus
 * extension load errors, which live on the resource loader, not in
 * services.diagnostics. Exported for tests.
 */
export function collectStartupDiagnostics(
	services: AgentSessionServices
): AgentSessionRuntimeDiagnostic[] {
	return [
		...services.diagnostics,
		...services.resourceLoader.getExtensions().errors.map((e) => ({
			type: "error" as const,
			message: `Extension failed to load: ${e.path}: ${e.error}`,
		})),
	];
}

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
