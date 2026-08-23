/**
 * Transport-neutral backend interface for driving one pi agent session.
 *
 * Two implementations exist:
 *  - SdkPiBackend: in-process SDK (@earendil-works/pi-coding-agent) — default
 *  - RpcPiBackend: `pi --mode rpc` subprocess — isolation / experimental
 *
 * A third (RemotePiBackend over pi-client CBOR) is stubbed for later chapters.
 */
import type {
	PiCommandInfo,
	PiEvent,
	PiImageInput,
	PiModelInfo,
	PiSessionState,
	PiThinkingLevel,
	UiDialogResponse,
} from "../../shared/pi";
import { toJson, type JsonValue } from "../../shared/pi";

export interface BackendOptions {
	/** Project working directory for the session. */
	cwd: string;
	/** Resume an existing session file instead of creating a new one. */
	sessionPath?: string;
	/** Session display name at startup. */
	name?: string;
	/** Ephemeral session: do not persist to disk (pi --no-session parity). */
	noSession?: boolean;
	/** Shared app-level ModelRuntime (chapter 6) — keys apply across sessions. */
	modelRuntime?: unknown;
	/** Desktop-owned extensions loaded into every session (e.g. the approval gate). */
	extensionFactories?: unknown[];
	/** Scoped model cycle list ({provider, modelId, thinkingLevel}). */
	scopedModels?: Array<{ provider: string; modelId: string; thinkingLevel?: string }>;
	/** Desktop-native custom tools (chapter 12). */
	desktopTools?: unknown[];
	/** Event sink (already JSON-safe). */
	onEvent(event: PiEvent): void;
	/** Called when the backend dies unexpectedly (crash, exit). */
	onDied(reason: string): void;
}

export interface PromptInput {
	text: string;
	images?: PiImageInput[];
	streamingBehavior?: "steer" | "followUp";
}

export interface SetModelResultInfo {
	provider: string;
	id: string;
	name: string;
}

/**
 * Every method may throw; PiService converts errors into IPC error envelopes.
 * prompt/steer/followUp resolve when accepted (not when the run completes) —
 * completion is observed through events (agent_settled).
 */
export interface IPiBackend {
	readonly kind: "sdk" | "rpc";
	start(): Promise<void>;
	dispose(): Promise<void>;

	getSessionFile(): string | undefined;
	getCwd(): string;

	prompt(input: PromptInput): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	abort(): Promise<void>;

	setModel(provider: string, modelId: string): Promise<SetModelResultInfo>;
	cycleModel(): Promise<SetModelResultInfo | null>;
	setThinkingLevel(level: PiThinkingLevel): Promise<PiThinkingLevel>;
	getThinkingLevels(): Promise<PiThinkingLevel[]>;
	getAvailableModels(): Promise<PiModelInfo[]>;

	compact(customInstructions?: string): Promise<JsonValue>;
	getState(): Promise<PiSessionState>;
	getMessages(): Promise<JsonValue[]>;
	getCommands(): Promise<PiCommandInfo[]>;
	getStats(): Promise<JsonValue>;
	exportHtml(outputPath?: string): Promise<string>;

	bash(
		command: string,
		opts?: { excludeFromContext?: boolean; requestId?: string }
	): Promise<JsonValue>;
	abortBash(): Promise<void>;

	fork(entryId: string): Promise<{ text?: string; cancelled: boolean }>;
	/** Navigate within the session tree; optionally summarize the abandoned branch. */
	navigateTree(
		entryId: string,
		options?: { summarize?: boolean; customInstructions?: string }
	): Promise<{ text?: string; cancelled: boolean }>;
	/** Full session branch tree (JSON-safe projection). */
	getTree(): Promise<JsonValue>;
	/** Entries in append order, optionally after a cursor id. */
	getEntries(since?: string): Promise<{ entries: JsonValue[]; leafId: string | null }>;
	/** Duplicate the current branch into a new session at the current position. */
	clone(): Promise<{ cancelled: boolean }>;
	/** Replace the active session with another session file. */
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
	/** Set the display name of the active session. */
	renameSession(name: string): Promise<void>;
	exportToJsonl(outputPath?: string): Promise<string>;
	respondUi(response: UiDialogResponse): Promise<void>;
}

/** Shared helper: serialize unknown thrown values into messages. */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Shared helper: JSON-safe clone for pi payloads crossing IPC. */
export function safeJson(value: unknown): JsonValue {
	return toJson(value);
}
