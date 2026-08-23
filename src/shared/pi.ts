/**
 * Pi-specific IPC contract: events streamed from agent sessions and the
 * request channels used to drive them. Shapes here are JSON-safe projections
 * of pi's own types (AgentSessionEvent, AgentMessage, …) — we never leak
 * pi class instances across the IPC boundary.
 */
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// JSON value helper (pi message shapes are pi-owned; renderer treats them as data)
// ---------------------------------------------------------------------------

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export function toJson(value: unknown): JsonValue {
	if (value === undefined) return null;
	return JSON.parse(
		JSON.stringify(value, (_key, v: unknown) => (typeof v === "function" ? undefined : v))
	) as JsonValue;
}

// ---------------------------------------------------------------------------
// Basic pi domain projections
// ---------------------------------------------------------------------------

export const piThinkingLevels = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type PiThinkingLevel = (typeof piThinkingLevels)[number];

// Explicit literals (not .map) so typebox infers a proper union -> Static union.
export const PiThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

export interface PiModelInfo {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: string[];
	thinkingLevels: PiThinkingLevel[];
}

export interface PiSessionSummary {
	file: string;
	id: string | undefined;
	name: string | undefined;
	cwd: string | undefined;
	modified: number;
	messageCount: number;
}

export interface PiSessionState {
	sessionId: string;
	sessionFile: string | undefined;
	sessionName: string | undefined;
	model: { provider: string; id: string; name: string } | undefined;
	thinkingLevel: PiThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	isBashRunning: boolean;
	autoCompactionEnabled: boolean;
	autoRetryEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

export interface PiImageInput {
	data: string; // base64
	mimeType: string;
}

// ---------------------------------------------------------------------------
// Extension UI (dialogs block until the renderer answers; rest are fire-and-forget)
// ---------------------------------------------------------------------------

export type UiDialogRequest =
	| {
			requestId: string;
			method: "select";
			title: string;
			options: string[];
			timeoutMs?: number;
	  }
	| {
			requestId: string;
			method: "confirm";
			title: string;
			message: string;
			timeoutMs?: number;
	  }
	| {
			requestId: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeoutMs?: number;
	  }
	| {
			requestId: string;
			method: "editor";
			title: string;
			prefill?: string;
	  };

export interface UiDialogResponse {
	requestId: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}

// ---------------------------------------------------------------------------
// PiEvent — JSON-safe projection of AgentSessionEvent + backend lifecycle
// ---------------------------------------------------------------------------

export type PiEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; willRetry: boolean }
	| { type: "agent_settled" }
	| { type: "message_update"; usage?: JsonValue; delta: JsonValue }
	| { type: "message_start"; message: JsonValue }
	| { type: "message_end"; message: JsonValue }
	| { type: "turn_start" }
	| { type: "turn_end"; message?: JsonValue; toolResults?: JsonValue[] }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args?: JsonValue;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			partialResult?: JsonValue;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result?: JsonValue;
			isError: boolean;
	  }
	| { type: "queue_update"; steering: string[]; followUp: string[] }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result?: JsonValue;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
	  }
	| { type: "bash_execution_update"; id?: string; delta: string }
	| { type: "session_info_changed"; name?: string }
	| { type: "thinking_level_changed"; level: PiThinkingLevel }
	| { type: "ui_dialog"; request: UiDialogRequest }
	| { type: "ui_notify"; message: string; notifyType: "info" | "warning" | "error" }
	| { type: "ui_status"; statusKey: string; statusText?: string }
	| { type: "ui_widget"; widgetKey: string; widgetLines?: string[]; placement: "aboveEditor" | "belowEditor" }
	| { type: "ui_title"; title: string }
	| { type: "ui_editor_text"; text: string }
	| { type: "backend_died"; reason: string }
	| { type: "backend_warning"; reason: string }
	| {
			type: "session_replaced";
			cwd?: string;
			sessionFile?: string;
			sessionId?: string;
	  };

/** Events are routed per session. */
export interface PiEventEnvelope {
	sessionId: string;
	event: PiEvent;
}

// ---------------------------------------------------------------------------
// Request schemas (merged into the router map in protocol.ts)
// ---------------------------------------------------------------------------

const sessionIdProp = { sessionId: Type.String({ minLength: 1 }) } as const;

export const sessionCreateRequestSchema = Type.Object({
	type: Type.Literal("session.create"),
	cwd: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String()),
	backend: Type.Optional(Type.Union([Type.Literal("sdk"), Type.Literal("rpc")])),
	noSession: Type.Optional(Type.Boolean()),
});

export const sessionResumeRequestSchema = Type.Object({
	type: Type.Literal("session.resume"),
	sessionPath: Type.String({ minLength: 1 }),
	backend: Type.Optional(Type.Union([Type.Literal("sdk"), Type.Literal("rpc")])),
	/**
	 * True working directory, when the caller knows it (session list rows carry
	 * it). Pi's session-directory encoding is lossy, so it cannot be recovered
	 * from `sessionPath` — see resolveResumeCwd in main/pi/service.ts.
	 */
	cwd: Type.Optional(Type.String({ minLength: 1 })),
});

export const sessionListRequestSchema = Type.Object({
	type: Type.Literal("session.list"),
});

export const sessionCloseRequestSchema = Type.Object({
	type: Type.Literal("session.close"),
	...sessionIdProp,
});

export const sessionPromptRequestSchema = Type.Object({
	type: Type.Literal("session.prompt"),
	...sessionIdProp,
	text: Type.String(),
	images: Type.Optional(
		Type.Array(
			Type.Object({ data: Type.String(), mimeType: Type.String({ minLength: 1 }) })
		)
	),
	streamingBehavior: Type.Optional(
		Type.Union([Type.Literal("steer"), Type.Literal("followUp")])
	),
});

export const sessionSteerRequestSchema = Type.Object({
	type: Type.Literal("session.steer"),
	...sessionIdProp,
	text: Type.String(),
});

export const sessionFollowUpRequestSchema = Type.Object({
	type: Type.Literal("session.follow_up"),
	...sessionIdProp,
	text: Type.String(),
});

export const sessionAbortRequestSchema = Type.Object({
	type: Type.Literal("session.abort"),
	...sessionIdProp,
});

export const sessionSetModelRequestSchema = Type.Object({
	type: Type.Literal("session.set_model"),
	...sessionIdProp,
	provider: Type.String({ minLength: 1 }),
	modelId: Type.String({ minLength: 1 }),
});

export const sessionCycleModelRequestSchema = Type.Object({
	type: Type.Literal("session.cycle_model"),
	...sessionIdProp,
});

export const sessionSetThinkingRequestSchema = Type.Object({
	type: Type.Literal("session.set_thinking"),
	...sessionIdProp,
	level: PiThinkingLevelSchema,
});

export const sessionThinkingLevelsRequestSchema = Type.Object({
	type: Type.Literal("session.thinking_levels"),
	...sessionIdProp,
});

export const sessionTreeRequestSchema = Type.Object({
	type: Type.Literal("session.tree"),
	...sessionIdProp,
});

export const sessionEntriesRequestSchema = Type.Object({
	type: Type.Literal("session.entries"),
	...sessionIdProp,
	since: Type.Optional(Type.String()),
});

export const sessionCloneRequestSchema = Type.Object({
	type: Type.Literal("session.clone"),
	...sessionIdProp,
});

export const sessionSwitchRequestSchema = Type.Object({
	type: Type.Literal("session.switch"),
	...sessionIdProp,
	sessionPath: Type.String({ minLength: 1 }),
});

export const sessionNavigateRequestSchema = Type.Object({
	type: Type.Literal("session.navigate"),
	...sessionIdProp,
	entryId: Type.String({ minLength: 1 }),
	summarize: Type.Optional(Type.Boolean()),
	customInstructions: Type.Optional(Type.String()),
});

export const sessionExportJsonlRequestSchema = Type.Object({
	type: Type.Literal("session.export_jsonl"),
	...sessionIdProp,
	outputPath: Type.Optional(Type.String({ minLength: 1 })),
});

export const sessionCompactRequestSchema = Type.Object({
	type: Type.Literal("session.compact"),
	...sessionIdProp,
	customInstructions: Type.Optional(Type.String()),
});

export const sessionStateRequestSchema = Type.Object({
	type: Type.Literal("session.state"),
	...sessionIdProp,
});

export const sessionMessagesRequestSchema = Type.Object({
	type: Type.Literal("session.messages"),
	...sessionIdProp,
});

export const sessionCommandsRequestSchema = Type.Object({
	type: Type.Literal("session.commands"),
	...sessionIdProp,
});

export const sessionStatsRequestSchema = Type.Object({
	type: Type.Literal("session.stats"),
	...sessionIdProp,
});

export const sessionModelsRequestSchema = Type.Object({
	type: Type.Literal("session.models"),
	...sessionIdProp,
});

export const sessionExportHtmlRequestSchema = Type.Object({
	type: Type.Literal("session.export_html"),
	...sessionIdProp,
	outputPath: Type.Optional(Type.String({ minLength: 1 })),
});

export const sessionBashRequestSchema = Type.Object({
	type: Type.Literal("session.bash"),
	...sessionIdProp,
	command: Type.String({ minLength: 1 }),
	/** Correlates the streamed bash_execution_update blocks for completion. */
	requestId: Type.String({ minLength: 1 }),
	/** `!!` variant: keep output out of LLM context. */
	excludeFromContext: Type.Optional(Type.Boolean()),
});

export const sessionRenameRequestSchema = Type.Object({
	type: Type.Literal("session.rename"),
	...sessionIdProp,
	name: Type.String({ minLength: 1 }),
});

export const workspaceRevealRequestSchema = Type.Object({
	type: Type.Literal("workspace.reveal"),
	path: Type.String({ minLength: 1 }),
});

export const gitContextRequestSchema = Type.Object({
	type: Type.Literal("git.context"),
	root: Type.String({ minLength: 1 }),
});

export const piConfigWriteTrustRequestSchema = Type.Object({
	type: Type.Literal("pi.config.write_trust"),
	content: Type.String(),
});

export const piConfigReadRequestSchema = Type.Object({
	type: Type.Literal("pi.config.read"),
	name: Type.Union([Type.Literal("trust"), Type.Literal("keybindings")]),
});

export const workspaceOpenInEditorRequestSchema = Type.Object({
	type: Type.Literal("workspace.open_in_editor"),
	path: Type.String({ minLength: 1 }),
	line: Type.Optional(Type.Number({ minimum: 1 })),
});

export const sessionAbortBashRequestSchema = Type.Object({
	type: Type.Literal("session.abort_bash"),
	...sessionIdProp,
});

export const sessionForkRequestSchema = Type.Object({
	type: Type.Literal("session.fork"),
	...sessionIdProp,
	entryId: Type.String({ minLength: 1 }),
});

export const sessionDeleteFileRequestSchema = Type.Object({
	type: Type.Literal("session.delete_file"),
	sessionPath: Type.String({ minLength: 1 }),
});

export const dbListRequestSchema = Type.Object({
	type: Type.Literal("db.sessions.list"),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
});

export const dbSearchRequestSchema = Type.Object({
	type: Type.Literal("db.sessions.search"),
	query: Type.String(),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
});

export const usageDailyRequestSchema = Type.Object({
	type: Type.Literal("db.usage.daily"),
	days: Type.Optional(Type.Number({ minimum: 1, maximum: 365 })),
});

export const usageTotalsRequestSchema = Type.Object({
	type: Type.Literal("db.usage.totals"),
});

export const projectsListRequestSchema = Type.Object({
	type: Type.Literal("db.projects.list"),
});

export const indexerRefreshRequestSchema = Type.Object({
	type: Type.Literal("db.indexer.refresh"),
});

// ---------------------------------------------------------------------------
// Auth & settings (chapter 6)
// ---------------------------------------------------------------------------

export interface ProviderAuthInfo {
	id: string;
	name: string;
	configured: boolean;
	authType: "api_key" | "oauth" | "none";
	source?: string;
	usingOAuth: boolean;
	usingSubscription: boolean;
	modelCount: number;
	error?: string;
}

export interface ModelCatalogEntry {
	provider: string;
	providerName: string;
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: string[];
	inputCostPerMtok: number | null;
	outputCostPerMtok: number | null;
}

export const authProvidersRequestSchema = Type.Object({
	type: Type.Literal("auth.providers"),
});

export const authModelsRequestSchema = Type.Object({
	type: Type.Literal("auth.models"),
	provider: Type.Optional(Type.String()),
});

export const authSetKeyRequestSchema = Type.Object({
	type: Type.Literal("auth.set_key"),
	providerId: Type.String({ minLength: 1 }),
	key: Type.String({ minLength: 1 }),
});

export const authRemoveKeyRequestSchema = Type.Object({
	type: Type.Literal("auth.remove_key"),
	providerId: Type.String({ minLength: 1 }),
});

export const authLoginRequestSchema = Type.Object({
	type: Type.Literal("auth.login"),
	providerId: Type.String({ minLength: 1 }),
	authType: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]),
});

export const authRespondLoginRequestSchema = Type.Object({
	type: Type.Literal("auth.respond_login"),
	loginId: Type.String({ minLength: 1 }),
	value: Type.String(),
});

export const authLogoutRequestSchema = Type.Object({
	type: Type.Literal("auth.logout"),
	providerId: Type.String({ minLength: 1 }),
});

export const modelsJsonGetRequestSchema = Type.Object({
	type: Type.Literal("models.json.get"),
});

export const modelsJsonSaveRequestSchema = Type.Object({
	type: Type.Literal("models.json.save"),
	content: Type.String(), // JSON-encoded full models.json
});

export const scopedModelsGetRequestSchema = Type.Object({
	type: Type.Literal("session.scoped_models.get"),
});

export const scopedModelsSetRequestSchema = Type.Object({
	type: Type.Literal("session.scoped_models.set"),
	models: Type.Array(
		Type.Object({
			provider: Type.String(),
			modelId: Type.String(),
			thinkingLevel: Type.Optional(Type.String()),
		})
	),
});

export interface NpmSearchResult {
	name: string;
	description: string;
	version: string;
	publisher: string;
	date: string;
}

export const packagesSearchRequestSchema = Type.Object({
	type: Type.Literal("packages.search"),
	query: Type.Optional(Type.String()),
});

export const packagesListRequestSchema = Type.Object({
	type: Type.Literal("packages.list"),
});

export const packagesInstallRequestSchema = Type.Object({
	type: Type.Literal("packages.install"),
	source: Type.String({ minLength: 1 }),
});

export const packagesRemoveRequestSchema = Type.Object({
	type: Type.Literal("packages.remove"),
	source: Type.String({ minLength: 1 }),
});

export const resourcesReadTextRequestSchema = Type.Object({
	type: Type.Literal("resources.read_text"),
	path: Type.String({ minLength: 1 }),
});

export const piSettingsGetRequestSchema = Type.Object({
	type: Type.Literal("pi.settings.get"),
});

export const piSettingsSetRequestSchema = Type.Object({
	type: Type.Literal("pi.settings.set"),
	key: Type.String({ minLength: 1 }),
	value: Type.String(), // JSON-encoded
});

export const sessionDefaultModelRequestSchema = Type.Object({
	type: Type.Literal("session.default_model"),
	provider: Type.String({ minLength: 1 }),
	modelId: Type.String({ minLength: 1 }),
});

export const fsListRequestSchema = Type.Object({
	type: Type.Literal("fs.list"),
	dirPath: Type.String({ minLength: 1 }),
});

export const fsReadRequestSchema = Type.Object({
	type: Type.Literal("fs.read"),
	filePath: Type.String({ minLength: 1 }),
});

export const workspaceRootsRequestSchema = Type.Object({
	type: Type.Literal("workspace.roots"),
});

export const sidecarSearchRequestSchema = Type.Object({
	type: Type.Literal("sidecar.search"),
	query: Type.String(),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
});

export const sidecarUsageRequestSchema = Type.Object({
	type: Type.Literal("sidecar.usage"),
	days: Type.Optional(Type.Number({ minimum: 1, maximum: 365 })),
});

export const sidecarTopRequestSchema = Type.Object({
	type: Type.Literal("sidecar.top"),
	by: Type.Optional(Type.Union([Type.Literal("cost"), Type.Literal("tokens")])),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
});

export const sidecarRebuildRequestSchema = Type.Object({
	type: Type.Literal("sidecar.rebuild"),
});

export const sidecarStatusRequestSchema = Type.Object({
	type: Type.Literal("sidecar.status"),
});

export const appUserRequestSchema = Type.Object({
	type: Type.Literal("app.user"),
});

export const settingsGetRequestSchema = Type.Object({
	type: Type.Literal("app.settings.get"),
	key: Type.String({ minLength: 1 }),
});

export const settingsSetRequestSchema = Type.Object({
	type: Type.Literal("app.settings.set"),
	key: Type.String({ minLength: 1 }),
	value: Type.String(), // JSON-encoded value
});

export const sessionRespondUiRequestSchema = Type.Object({
	type: Type.Literal("session.respond_ui"),
	...sessionIdProp,
	requestId: Type.String({ minLength: 1 }),
	value: Type.Optional(Type.String()),
	confirmed: Type.Optional(Type.Boolean()),
	cancelled: Type.Optional(Type.Boolean()),
});

// ---------------------------------------------------------------------------
// Response payload types
// ---------------------------------------------------------------------------

export interface SessionOpenedResponse {
	sessionId: string;
	backend: "sdk" | "rpc";
	cwd: string;
	sessionFile: string | undefined;
	model: { provider: string; id: string; name: string } | undefined;
}

export interface SidecarSearchHit {
	session_id: string | null;
	entry_id: string;
	role: string;
	snippet: string;
	cwd: string | null;
	session_name: string | null;
}

export interface IndexedSession {
	id: string;
	filePath: string;
	name: string | null;
	cwd: string | null;
	updatedAt: number | null;
	messageCount: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	modelProvider: string | null;
	modelId: string | null;
	firstMessage: string | null;
}

export type PiCommandInfo = {
	name: string;
	description?: string;
	source: string;
	/** Absolute path of the backing resource (.md), when the command has one. */
	path?: string;
	/** Upstream argument-hint from prompt-template frontmatter. */
	argumentHint?: string;
};

// Static schema instances for the router (payload validation)
export const piRequestSchemas = {
	"session.create": sessionCreateRequestSchema,
	"session.resume": sessionResumeRequestSchema,
	"session.list": sessionListRequestSchema,
	"session.close": sessionCloseRequestSchema,
	"session.prompt": sessionPromptRequestSchema,
	"session.steer": sessionSteerRequestSchema,
	"session.follow_up": sessionFollowUpRequestSchema,
	"session.abort": sessionAbortRequestSchema,
	"session.set_model": sessionSetModelRequestSchema,
	"session.cycle_model": sessionCycleModelRequestSchema,
	"session.set_thinking": sessionSetThinkingRequestSchema,
	"session.thinking_levels": sessionThinkingLevelsRequestSchema,
	"session.tree": sessionTreeRequestSchema,
	"session.entries": sessionEntriesRequestSchema,
	"session.clone": sessionCloneRequestSchema,
	"session.switch": sessionSwitchRequestSchema,
	"session.navigate": sessionNavigateRequestSchema,
	"session.export_jsonl": sessionExportJsonlRequestSchema,
	"session.compact": sessionCompactRequestSchema,
	"session.state": sessionStateRequestSchema,
	"session.messages": sessionMessagesRequestSchema,
	"session.commands": sessionCommandsRequestSchema,
	"session.stats": sessionStatsRequestSchema,
	"session.models": sessionModelsRequestSchema,
	"session.export_html": sessionExportHtmlRequestSchema,
	"session.bash": sessionBashRequestSchema,
	"session.abort_bash": sessionAbortBashRequestSchema,
	"session.fork": sessionForkRequestSchema,
	"session.respond_ui": sessionRespondUiRequestSchema,
	"session.delete_file": sessionDeleteFileRequestSchema,
	"db.sessions.list": dbListRequestSchema,
	"db.sessions.search": dbSearchRequestSchema,
	"db.usage.daily": usageDailyRequestSchema,
	"db.usage.totals": usageTotalsRequestSchema,
	"db.projects.list": projectsListRequestSchema,
	"db.indexer.refresh": indexerRefreshRequestSchema,
	"auth.providers": authProvidersRequestSchema,
	"auth.models": authModelsRequestSchema,
	"auth.set_key": authSetKeyRequestSchema,
	"auth.remove_key": authRemoveKeyRequestSchema,
	"auth.login": authLoginRequestSchema,
	"auth.respond_login": authRespondLoginRequestSchema,
	"auth.logout": authLogoutRequestSchema,
	"models.json.get": modelsJsonGetRequestSchema,
	"models.json.save": modelsJsonSaveRequestSchema,
	"session.scoped_models.get": scopedModelsGetRequestSchema,
	"session.scoped_models.set": scopedModelsSetRequestSchema,
	"packages.search": packagesSearchRequestSchema,
	"packages.list": packagesListRequestSchema,
	"packages.install": packagesInstallRequestSchema,
	"packages.remove": packagesRemoveRequestSchema,
	"resources.read_text": resourcesReadTextRequestSchema,
	"session.rename": sessionRenameRequestSchema,
	"workspace.reveal": workspaceRevealRequestSchema,
	"git.context": gitContextRequestSchema,
	"pi.config.write_trust": piConfigWriteTrustRequestSchema,
	"pi.config.read": piConfigReadRequestSchema,
	"workspace.open_in_editor": workspaceOpenInEditorRequestSchema,
	"pi.settings.get": piSettingsGetRequestSchema,
	"pi.settings.set": piSettingsSetRequestSchema,
	"session.default_model": sessionDefaultModelRequestSchema,
	"fs.list": fsListRequestSchema,
	"fs.read": fsReadRequestSchema,
	"workspace.roots": workspaceRootsRequestSchema,
	"sidecar.search": sidecarSearchRequestSchema,
	"sidecar.usage": sidecarUsageRequestSchema,
	"sidecar.top": sidecarTopRequestSchema,
	"sidecar.rebuild": sidecarRebuildRequestSchema,
	"sidecar.status": sidecarStatusRequestSchema,
	"app.user": appUserRequestSchema,
	"app.settings.get": settingsGetRequestSchema,
	"app.settings.set": settingsSetRequestSchema,
} as const;

export type PiRequestKey = keyof typeof piRequestSchemas;
export type PiRequestMap = {
	[K in PiRequestKey]: Static<(typeof piRequestSchemas)[K]>;
};

/** Response payloads for pi channels (declared, not schema-validated). */
export interface PiResponseMap {
	"session.create": SessionOpenedResponse;
	"session.resume": SessionOpenedResponse;
	"session.list": { sessions: PiSessionSummary[] };
	"session.close": null;
	"session.prompt": null;
	"session.steer": null;
	"session.follow_up": null;
	"session.abort": null;
	"session.set_model": { provider: string; id: string; name: string };
	"session.cycle_model": { provider: string; id: string; name: string } | null;
	"session.set_thinking": { level: PiThinkingLevel };
	"session.thinking_levels": { levels: PiThinkingLevel[] };
	"session.tree": JsonValue;
	"session.entries": { entries: JsonValue[]; leafId: string | null };
	"session.clone": { cancelled: boolean };
	"session.switch": { cancelled: boolean };
	"session.navigate": { text?: string; cancelled: boolean };
	"session.export_jsonl": { path: string };
	"session.compact": JsonValue;
	"session.state": PiSessionState;
	"session.messages": { messages: JsonValue[] };
	"session.commands": { commands: PiCommandInfo[] };
	"session.stats": JsonValue;
	"session.models": { models: PiModelInfo[] };
	"session.export_html": { path: string };
	"session.bash": JsonValue;
	"session.abort_bash": null;
	"session.fork": { text?: string; cancelled: boolean };
	"session.respond_ui": null;
	"session.delete_file": null;
	"db.sessions.list": { sessions: IndexedSession[] };
	"db.sessions.search": { sessions: IndexedSession[] };
	"db.usage.daily": JsonValue;
	"db.usage.totals": { totalCost: number; totalTokens: number };
	"db.projects.list": { projects: Array<{ id: string; path: string; name: string | null }> };
	"db.indexer.refresh": { indexed: number };
	"auth.providers": { providers: ProviderAuthInfo[] };
	"auth.models": { models: ModelCatalogEntry[] };
	"auth.set_key": null;
	"auth.remove_key": null;
	"auth.login": null;
	"auth.respond_login": null;
	"auth.logout": null;
	"models.json.get": JsonValue;
	"models.json.save": null;
	"session.scoped_models.get": { models: Array<{ provider: string; modelId: string; thinkingLevel?: string }> };
	"session.scoped_models.set": null;
	"packages.search": { results: NpmSearchResult[] };
	"packages.list": {
		packages: Array<{
			source: string;
			scope: string;
			filtered: boolean;
			installedPath?: string;
		}>;
	};
	"packages.install": { progress: string[] };
	"packages.remove": null;
	"resources.read_text": { content: string };
	"session.rename": null;
	"workspace.reveal": null;
	"git.context": JsonValue | null;
	"pi.config.write_trust": null;
	"pi.config.read": JsonValue;
	"workspace.open_in_editor": null;
	"pi.settings.get": JsonValue;
	"pi.settings.set": null;
	"session.default_model": null;
	"fs.list": { entries: Array<{ name: string; type: "dir" | "file"; size: number }> };
	"fs.read": { content: string; truncated: boolean };
	"workspace.roots": { roots: string[] };
	"sidecar.search": { hits: SidecarSearchHit[] } | null;
	"sidecar.usage": JsonValue | null;
	"sidecar.top": JsonValue | null;
	"sidecar.rebuild": JsonValue | null;
	"sidecar.status": { status: "starting" | "healthy" | "degraded" | "stopped" };
	"app.user": { name: string };
	"app.settings.get": JsonValue;
	"app.settings.set": null;
}
