/**
 * RemotePiBackend — placeholder for the pi-server / pi-client CBOR protocol
 * (Unix socket or WebSocket transport). Deliberately unimplemented in chapter 2;
 * the interface exists so UI code can already branch on backend kind.
 *
 * Upstream reference: packages/client + packages/server + packages/protocol in
 * the pi monorepo (length-prefixed CBOR, session leases, snapshots).
 */
import type {
	PiModelInfo,
	PiSessionState,
	PiThinkingLevel,
	UiDialogResponse,
} from "../../shared/pi";
import type { JsonValue } from "../../shared/pi";
import type { BackendOptions, IPiBackend, PromptInput, SetModelResultInfo } from "./backend";

function notImplemented(): Error {
	return new Error(
		"Remote pi sessions (pi-server/pi-client) are not implemented yet — planned after v1"
	);
}

export class RemotePiBackend implements IPiBackend {
	readonly kind = "rpc" as const;

	private readonly options: BackendOptions;

	constructor(options: BackendOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		throw notImplemented();
	}

	async dispose(): Promise<void> {}

	getSessionFile(): string | undefined {
		return undefined;
	}

	getCwd(): string {
		return this.options.cwd;
	}

	async prompt(_input: PromptInput): Promise<void> {
		throw notImplemented();
	}
	async steer(_text: string): Promise<void> {
		throw notImplemented();
	}
	async followUp(_text: string): Promise<void> {
		throw notImplemented();
	}
	async abort(): Promise<void> {
		throw notImplemented();
	}
	async setModel(_provider: string, _modelId: string): Promise<SetModelResultInfo> {
		throw notImplemented();
	}
	async cycleModel(): Promise<SetModelResultInfo | null> {
		throw notImplemented();
	}
	async setThinkingLevel(_level: PiThinkingLevel): Promise<PiThinkingLevel> {
		throw notImplemented();
	}
	async getThinkingLevels(): Promise<PiThinkingLevel[]> {
		throw notImplemented();
	}
	async getAvailableModels(): Promise<PiModelInfo[]> {
		throw notImplemented();
	}
	async compact(_customInstructions?: string): Promise<JsonValue> {
		throw notImplemented();
	}
	async getState(): Promise<PiSessionState> {
		throw notImplemented();
	}
	async getMessages(): Promise<JsonValue[]> {
		throw notImplemented();
	}
	async getCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
		throw notImplemented();
	}
	async getStats(): Promise<JsonValue> {
		throw notImplemented();
	}
	async exportHtml(_outputPath?: string): Promise<string> {
		throw notImplemented();
	}
	async bash(_command: string): Promise<JsonValue> {
		throw notImplemented();
	}
	async abortBash(): Promise<void> {
		throw notImplemented();
	}
	async fork(_entryId: string): Promise<{ text?: string; cancelled: boolean }> {
		throw notImplemented();
	}
	async respondUi(_response: UiDialogResponse): Promise<void> {
		throw notImplemented();
	}
}
