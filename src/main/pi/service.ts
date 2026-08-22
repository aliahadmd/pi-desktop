/**
 * PiService — owns the session registry (sessionId → backend), wires backends
 * to the renderer event bus, and implements every `session.*` IPC channel.
 *
 * Session ids are app-generated (uuid) and are the identity used by tabs/UI;
 * pi's own sessionId is data, not the registry key.
 */
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RendererEventBus } from "../ipc/events";
import type { IpcRouter } from "../ipc/router";
import {
	type PiEvent,
	type PiSessionSummary,
	type SessionOpenedResponse,
	type UiDialogResponse,
} from "../../shared/pi";
import { describeError, type BackendOptions, type IPiBackend } from "./backend";
import { RpcPiBackend } from "./rpc-backend";
import { SdkPiBackend } from "./sdk-backend";

interface SessionEntry {
	id: string;
	cwd: string;
	backend: IPiBackend;
}

/** Lifecycle + event hooks for observers (store, usage capture, UI). */
export interface PiServiceHooks {
	onSessionOpened?(info: {
		appSessionId: string;
		piSessionId: string | undefined;
		sessionFile: string | undefined;
		cwd: string;
		backend: "sdk" | "rpc";
	}): void;
	onSessionClosed?(appSessionId: string): void;
	onSessionEvent?(appSessionId: string, event: PiEvent): void;
}

export class PiService {
	private readonly sessions = new Map<string, SessionEntry>();
	private readonly bus: RendererEventBus;
	private readonly hooksList: PiServiceHooks[] = [];
	private sharedRuntime: unknown = undefined;
	private extensionPaths: string[] = [];
	private scopedModels: Array<{ provider: string; modelId: string; thinkingLevel?: string }> = [];
	private desktopTools: unknown[] = [];

	constructor(bus: RendererEventBus, hooks?: PiServiceHooks) {
		this.bus = bus;
		if (hooks !== undefined) this.hooksList.push(hooks);
	}

	/** Register an additional observer (store, usage capture, notifications…). */
	addHooks(hooks: PiServiceHooks): void {
		this.hooksList.push(hooks);
	}

	/** Replace all observers. Idempotent; last wins. */
	setHooks(hooks: PiServiceHooks): void {
		this.hooksList.splice(0, this.hooksList.length, hooks);
	}

	/** Provide the app-level ModelRuntime for all new SDK sessions. */
	setSharedRuntime(runtime: unknown): void {
		this.sharedRuntime = runtime;
	}

	/** Extension files loaded into every SDK session (e.g. approval gate). */
	setExtensionPaths(paths: string[]): void {
		this.extensionPaths = paths;
	}

	setScopedModels(models: Array<{ provider: string; modelId: string; thinkingLevel?: string }>): void {
		this.scopedModels = models;
	}

	setDesktopTools(tools: unknown[]): void {
		this.desktopTools = tools;
	}

	registerHandlers(router: IpcRouter): void {
		router.handle("session.create", (req) => this.openSession(req));
		router.handle("session.resume", (req) => this.resumeSession(req));
		router.handle("session.list", () => this.listSessions());
		router.handle("session.close", async (req) => {
			await this.closeSession(req.sessionId);
			return null;
		});
		router.handle("session.prompt", async (req) => {
			const backend = this.backend(req.sessionId);
			await backend.prompt({
				text: req.text,
				...(req.images !== undefined ? { images: req.images } : {}),
				...(req.streamingBehavior !== undefined
					? { streamingBehavior: req.streamingBehavior }
					: {}),
			});
			return null;
		});
		router.handle("session.steer", async (req) => {
			await this.backend(req.sessionId).steer(req.text);
			return null;
		});
		router.handle("session.follow_up", async (req) => {
			await this.backend(req.sessionId).followUp(req.text);
			return null;
		});
		router.handle("session.abort", async (req) => {
			await this.backend(req.sessionId).abort();
			return null;
		});
		router.handle("session.set_model", async (req) =>
			this.backend(req.sessionId).setModel(req.provider, req.modelId)
		);
		router.handle("session.cycle_model", async (req) =>
			this.backend(req.sessionId).cycleModel()
		);
		router.handle("session.set_thinking", async (req) => {
			const level = await this.backend(req.sessionId).setThinkingLevel(req.level);
			return { level };
		});
		router.handle("session.thinking_levels", async (req) => {
			const levels = await this.backend(req.sessionId).getThinkingLevels();
			return { levels };
		});
		router.handle("session.compact", async (req) =>
			this.backend(req.sessionId).compact(req.customInstructions)
		);
		router.handle("session.state", async (req) => this.backend(req.sessionId).getState());
		router.handle("session.messages", async (req) => {
			const messages = await this.backend(req.sessionId).getMessages();
			return { messages };
		});
		router.handle("session.commands", async (req) => {
			const commands = await this.backend(req.sessionId).getCommands();
			return { commands };
		});
		router.handle("session.stats", async (req) => this.backend(req.sessionId).getStats());
		router.handle("session.models", async (req) => {
			const models = await this.backend(req.sessionId).getAvailableModels();
			return { models };
		});
		router.handle("session.export_html", async (req) => {
			const exported = await this.backend(req.sessionId).exportHtml(req.outputPath);
			return { path: exported };
		});
		router.handle("session.bash", async (req) => {
			let isError = false;
			try {
				return await this.backend(req.sessionId).bash(req.command, {
					...(req.excludeFromContext === true ? { excludeFromContext: true } : {}),
					...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
				});
			} catch (error) {
				isError = true;
				throw error;
			} finally {
				// Complete the streaming bash block in the transcript.
				const event: PiEvent = {
					type: "tool_execution_end",
					toolCallId: req.requestId,
					toolName: "bash",
					isError,
				};
				this.bus.send({ type: "pi_event", sessionId: req.sessionId, event });
				for (const hooks of this.hooksList) {
					hooks.onSessionEvent?.(req.sessionId, event);
				}
			}
		});
		router.handle("session.abort_bash", async (req) => {
			await this.backend(req.sessionId).abortBash();
			return null;
		});
		router.handle("session.fork", async (req) => this.backend(req.sessionId).fork(req.entryId));
		router.handle("session.tree", async (req) => this.backend(req.sessionId).getTree());
		router.handle("session.entries", async (req) =>
			this.backend(req.sessionId).getEntries(req.since)
		);
		router.handle("session.clone", async (req) => {
			const result = await this.backend(req.sessionId).clone();
			await this.notifySessionOpened(req.sessionId);
			return result;
		});
		router.handle("session.switch", async (req) => {
			const result = await this.backend(req.sessionId).switchSession(req.sessionPath);
			// Re-register scoping (roots, dock cwd) for the switched-to project.
			await this.notifySessionOpened(req.sessionId);
			return result;
		});
		router.handle("session.navigate", async (req) => {
			const backend = this.backend(req.sessionId);
			return backend.navigateTree(req.entryId, {
				...(req.summarize !== undefined ? { summarize: req.summarize } : {}),
				...(req.customInstructions !== undefined
					? { customInstructions: req.customInstructions }
					: {}),
			});
		});
		router.handle("session.rename", async (req) => {
			await this.backend(req.sessionId).renameSession(req.name);
			return null;
		});
		router.handle("session.export_jsonl", async (req) => {
			const exported = await this.backend(req.sessionId).exportToJsonl(req.outputPath);
			return { path: exported };
		});
		router.handle("session.respond_ui", async (req) => {
			const response: UiDialogResponse = {
				requestId: req.requestId,
				...(req.value !== undefined ? { value: req.value } : {}),
				...(req.confirmed !== undefined ? { confirmed: req.confirmed } : {}),
				...(req.cancelled !== undefined ? { cancelled: req.cancelled } : {}),
			};
			await this.backend(req.sessionId).respondUi(response);
			return null;
		});
	}

	async disposeAll(): Promise<void> {
		const disposals = [...this.sessions.values()].map((entry) =>
			entry.backend.dispose().catch(() => {})
		);
		await Promise.all(disposals);
		this.sessions.clear();
	}

	get openSessionCount(): number {
		return this.sessions.size;
	}

	/** Project cwd of an open session (for notifications etc.). */
	getSessionCwd(appSessionId: string): string {
		return this.sessions.get(appSessionId)?.cwd ?? "";
	}

	// ---------------------------------------------------------------------------

	/** Re-fire onSessionOpened observers after an in-place replacement. */
	private async notifySessionOpened(appSessionId: string): Promise<void> {
		const entry = this.sessions.get(appSessionId);
		if (entry === undefined) return;
		const state = await entry.backend.getState().catch(() => undefined);
		for (const hooks of this.hooksList) {
			hooks.onSessionOpened?.({
				appSessionId,
				piSessionId: state?.sessionId,
				sessionFile: state?.sessionFile ?? entry.backend.getSessionFile(),
				cwd: entry.cwd,
				backend: entry.backend.kind,
			});
		}
	}

	private backend(sessionId: string): IPiBackend {
		const entry = this.sessions.get(sessionId);
		if (entry === undefined) throw new Error(`unknown session: ${sessionId}`);
		return entry.backend;
	}

	private async openSession(req: {
		cwd: string;
		name?: string;
		backend?: "sdk" | "rpc";
		noSession?: boolean;
	}): Promise<SessionOpenedResponse> {
		return this.startSession({
			cwd: req.cwd,
			...(req.name !== undefined ? { name: req.name } : {}),
			...(req.noSession === true ? { noSession: true } : {}),
			kind: req.backend ?? "sdk",
		});
	}

	private async resumeSession(req: {
		sessionPath: string;
		backend?: "sdk" | "rpc";
	}): Promise<SessionOpenedResponse> {
		// Derive cwd from the session file location (sessions live under
		// ~/.pi/agent/sessions/--<encoded-cwd>--/); the backend re-derives precisely.
		const cwd = deriveCwdFromSessionPath(req.sessionPath);
		return this.startSession({
			cwd,
			kind: req.backend ?? "sdk",
			sessionPath: req.sessionPath,
		});
	}

	private async startSession(opts: {
		cwd: string;
		name?: string;
		kind: "sdk" | "rpc";
		sessionPath?: string;
		noSession?: boolean;
	}): Promise<SessionOpenedResponse> {
		const id = randomUUID();
		const backendOptions: BackendOptions = {
			cwd: opts.cwd,
			...(opts.sessionPath !== undefined ? { sessionPath: opts.sessionPath } : {}),
			...(opts.name !== undefined ? { name: opts.name } : {}),
			...(opts.noSession === true ? { noSession: true } : {}),
			...(this.sharedRuntime !== undefined ? { modelRuntime: this.sharedRuntime } : {}),
			...(this.extensionPaths.length > 0 ? { extensionPaths: this.extensionPaths } : {}),
			...(this.scopedModels.length > 0 ? { scopedModels: this.scopedModels } : {}),
			...(this.desktopTools.length > 0 ? { desktopTools: this.desktopTools } : {}),
			onEvent: (event) => {
				this.bus.send({ type: "pi_event", sessionId: id, event });
				for (const hooks of this.hooksList) hooks.onSessionEvent?.(id, event);
			},
			onDied: (reason) => {
				this.bus.send({
					type: "pi_event",
					sessionId: id,
					event: { type: "backend_died", reason },
				});
			},
		};

		const backend: IPiBackend =
			opts.kind === "rpc"
				? RpcPiBackend.create(backendOptions)
				: SdkPiBackend.create(backendOptions);

		try {
			await backend.start();
		} catch (error) {
			await backend.dispose().catch(() => {});
			throw new Error(
				`failed to start ${opts.kind} session in ${opts.cwd}: ${describeError(error)}`
			);
		}

		this.sessions.set(id, { id, cwd: opts.cwd, backend });
		const state = await backend.getState().catch(() => undefined);
		for (const hooks of this.hooksList) {
			hooks.onSessionOpened?.({
			appSessionId: id,
			piSessionId: state?.sessionId,
			sessionFile: state?.sessionFile ?? backend.getSessionFile(),
				cwd: opts.cwd,
				backend: backend.kind,
			});
		}
		return {
			sessionId: id,
			backend: backend.kind,
			cwd: opts.cwd,
			sessionFile: state?.sessionFile ?? backend.getSessionFile(),
			model: state?.model,
		};
	}

	private async closeSession(sessionId: string): Promise<void> {
		const entry = this.sessions.get(sessionId);
		if (entry === undefined) return;
		this.sessions.delete(sessionId);
		for (const hooks of this.hooksList) hooks.onSessionClosed?.(sessionId);
		await entry.backend.dispose().catch(() => {});
	}

	private async listSessions(): Promise<{ sessions: PiSessionSummary[] }> {
		const infos = await SessionManager.listAll();
		return {
			sessions: infos.map((info) => ({
				file: info.path,
				id: info.id,
				name: info.name,
				cwd: info.cwd === "" ? undefined : info.cwd,
				modified: info.modified.getTime(),
				messageCount: info.messageCount,
			})),
		};
	}
}

/** ~/.pi/agent/sessions/--Users-foo-bar/<file>.jsonl → /Users/foo/bar (best effort). */
export function deriveCwdFromSessionPath(sessionPath: string): string {
	const parts = sessionPath.split("/");
	const dirName = parts[parts.length - 2] ?? "";
	if (dirName.startsWith("--") && dirName.endsWith("--")) {
		const encoded = dirName.slice(2, -2);
		return `/${encoded.replaceAll("-", "/")}`;
	}
	return process.cwd();
}
