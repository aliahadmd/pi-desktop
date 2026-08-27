/**
 * PiService — owns the session registry (sessionId → backend), wires backends
 * to the renderer event bus, and implements every `session.*` IPC channel.
 *
 * Session ids are app-generated (uuid) and are the identity used by tabs/UI;
 * pi's own sessionId is data, not the registry key.
 */
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RendererEventBus } from "../ipc/events";
import type { IpcRouter } from "../ipc/router";
import {
	type PiEvent,
	type PermissionMode,
	type PiSessionSummary,
	type SessionOpenedResponse,
	type UiDialogResponse,
} from "../../shared/pi";
import { describeError, type BackendOptions, type IPiBackend } from "./backend";
import { createPermissionExtension } from "./approve-extension";
import { getProjectTrustStatus, setProjectTrustDecision } from "./trust";
import {
	clearSessionPermissions,
	getMode,
	setDefaultMode,
	setMode,
} from "./permissions";
import { RpcPiBackend } from "./rpc-backend";
import { SdkPiBackend } from "./sdk-backend";

/**
 * Placeholder identifying the desktop permission extension in
 * `extensionFactories`. startSession swaps it for a fresh extension bound to
 * the new session's own app-session id — see the H-1 note there.
 */
export const permissionExtensionMarker = {
	name: "pi-desktop-permissions",
	factory: () => (): void => {},
};

interface SessionEntry {
	id: string;
	/** Live project cwd. Mutable: a session switch re-points it (plan 009). */
	cwd: string;
	backend: IPiBackend;
	/** Epoch ms when this session was opened — used for "most recent" resolution. */
	startedAt: number;
	/** Backing session file, tracked across replacements (used by delete guards). */
	sessionFile?: string;
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
	private extensionFactories: unknown[] = [];
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

	/** Set by index.ts to persist default-mode changes to StoreService. */
	onDefaultModeChange?: (mode: PermissionMode) => void;

	/** Provide the app-level ModelRuntime for all new SDK sessions. */
	setSharedRuntime(runtime: unknown): void {
		this.sharedRuntime = runtime;
	}

	/** Desktop-owned extensions injected into every SDK session. */
	setExtensionFactories(factories: unknown[]): void {
		this.extensionFactories = factories;
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
		// Audit 6 H-1: sessions outlive the window; a reopened renderer rehydrates
		// from this list instead of resuming files into duplicate backends.
		router.handle("session.list_open", () => this.listOpenSessions());
		// Audit 6 C-1: renderer pre-flight for project trust. check_trust reports
		// whether a cwd has trust-requiring .pi resources and whether a decision
		// exists; grant_trust records the user's choice (upstream ProjectTrustStore
		// is the canonical writer). The SDK session factory enforces the decision
		// regardless — these channels only drive the prompt UX.
		router.handle("session.check_trust", (req) => getProjectTrustStatus(req.cwd));
		router.handle("session.grant_trust", (req) => {
			setProjectTrustDecision(req.cwd, req.trusted);
			return null;
		});
		router.handle("session.close", async (req) => {
			await this.closeSession(req.sessionId);
			return null;
		});
		router.handle("permission.set_mode", async (req) => {
			setMode(req.sessionId, req.mode);
			return null;
		});
		router.handle("permission.set_default", async (req) => {
			setDefaultMode(req.mode);
			this.onDefaultModeChange?.(req.mode);
			return null;
		});
		router.handle("permission.get_mode", (req) => ({
			mode: getMode(req.sessionId),
		}));
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
					try {
						hooks.onSessionEvent?.(req.sessionId, event);
					} catch {
						// Observer isolation (audit 6 M-10).
					}
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
			// The runtime rebuilt itself at the target session's cwd. Refresh the
			// registry entry so everything scoped to it (fs-bridge roots, explorer
			// root, new-terminal cwd) follows the switch instead of pinning the
			// project we happened to boot in.
			const entry = this.sessions.get(req.sessionId);
			if (entry !== undefined) {
				entry.cwd = resolveResumeCwd(req.sessionPath, undefined);
			}
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
		for (const entry of this.sessions.values()) {
			clearSessionPermissions(entry.id);
		}
		this.sessions.clear();
	}

	get openSessionCount(): number {
		return this.sessions.size;
	}

	/** Project cwd of an open session (for notifications etc.). */
	getSessionCwd(appSessionId: string): string {
		return this.sessions.get(appSessionId)?.cwd ?? "";
	}

	/** True when an open session is backed by this session file (delete guard). */
	isSessionFileOpen(sessionFile: string): boolean {
		return this.findSessionByFile(sessionFile) !== undefined;
	}

	/** Open session backed by this file, tracked across in-place replacements. */
	private findSessionByFile(sessionFile: string): SessionEntry | undefined {
		for (const entry of this.sessions.values()) {
			if (entry.sessionFile === sessionFile) return entry;
			if (entry.backend.getSessionFile() === sessionFile) return entry;
		}
		return undefined;
	}

	// ---------------------------------------------------------------------------

	/** Re-fire onSessionOpened observers after an in-place replacement. */
	private async notifySessionOpened(appSessionId: string): Promise<void> {
		const entry = this.sessions.get(appSessionId);
		if (entry === undefined) return;
		const state = await entry.backend.getState().catch(() => undefined);
		if (state?.sessionFile !== undefined) entry.sessionFile = state.sessionFile;
		for (const hooks of this.hooksList) {
			try {
				hooks.onSessionOpened?.({
					appSessionId,
					piSessionId: state?.sessionId,
					sessionFile: state?.sessionFile ?? entry.backend.getSessionFile(),
					cwd: entry.cwd,
					backend: entry.backend.kind,
				});
			} catch {
				// Observer isolation (audit 6 M-10): one throwing hook must not break
				// the loop or the session lifecycle.
			}
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
		cwd?: string;
	}): Promise<SessionOpenedResponse> {
		// Audit 6 H-1: resuming a file already bound to a live backend would spawn
		// a second runtime appending to the same JSONL. Reattach to the existing
		// entry instead; the renderer's open() re-focuses and re-hydrates it.
		const existing = this.findSessionByFile(req.sessionPath);
		if (existing !== undefined) {
			const state = await existing.backend.getState().catch(() => undefined);
			return {
				sessionId: existing.id,
				backend: existing.backend.kind,
				cwd: existing.cwd,
				sessionFile: existing.sessionFile ?? existing.backend.getSessionFile(),
				model: state?.model,
			};
		}
		const cwd = resolveResumeCwd(req.sessionPath, req.cwd);
		return this.startSession({
			cwd,
			kind: req.backend ?? "sdk",
			sessionPath: req.sessionPath,
		});
	}

	/** Every open session, shaped like session.create's response (audit 6 H-1). */
	private async listOpenSessions(): Promise<{ sessions: SessionOpenedResponse[] }> {
		const sessions = await Promise.all(
			[...this.sessions.values()].map(async (entry) => {
				const state = await entry.backend.getState().catch(() => undefined);
				return {
					sessionId: entry.id,
					backend: entry.backend.kind,
					cwd: entry.cwd,
					sessionFile: entry.sessionFile ?? entry.backend.getSessionFile(),
					model: state?.model,
				};
			})
		);
		return { sessions };
	}

	private async startSession(opts: {
		cwd: string;
		name?: string;
		kind: "sdk" | "rpc";
		sessionPath?: string;
		noSession?: boolean;
	}): Promise<SessionOpenedResponse> {
		const id = randomUUID();
		// Audit 5 H-1: the permission extension must evaluate tool calls against
		// THIS session's mode. A shared factory list closed over a global
		// "most recently opened" accessor, so with two sessions streaming the
		// older one was gated by the newer one's mode. Bind the id per session.
		const sessionExtensions = this.extensionFactories.map((factory) =>
			factory === permissionExtensionMarker
				? {
						...permissionExtensionMarker,
						factory: createPermissionExtension(() => id),
					}
				: factory,
		);
		const backendOptions: BackendOptions = {
			cwd: opts.cwd,
			...(opts.sessionPath !== undefined ? { sessionPath: opts.sessionPath } : {}),
			...(opts.name !== undefined ? { name: opts.name } : {}),
			...(opts.noSession === true ? { noSession: true } : {}),
			...(this.sharedRuntime !== undefined ? { modelRuntime: this.sharedRuntime } : {}),
			...(sessionExtensions.length > 0
				? { extensionFactories: sessionExtensions }
				: {}),
			...(this.scopedModels.length > 0 ? { scopedModels: this.scopedModels } : {}),
			...(this.desktopTools.length > 0 ? { desktopTools: this.desktopTools } : {}),
			onEvent: (event) => {
				this.bus.send({ type: "pi_event", sessionId: id, event });
				for (const hooks of this.hooksList) {
					try {
						hooks.onSessionEvent?.(id, event);
					} catch {
						// Observer isolation (audit 6 M-10).
					}
				}
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

		const state = await backend.getState().catch(() => undefined);
		const sessionFile = state?.sessionFile ?? backend.getSessionFile();
		this.sessions.set(id, {
			id,
			cwd: opts.cwd,
			backend,
			startedAt: Date.now(),
			...(sessionFile !== undefined ? { sessionFile } : {}),
		});
		for (const hooks of this.hooksList) {
			try {
				hooks.onSessionOpened?.({
					appSessionId: id,
					piSessionId: state?.sessionId,
					sessionFile,
					cwd: opts.cwd,
					backend: backend.kind,
				});
			} catch {
				// Observer isolation (audit 6 M-10): the session is registered and
				// running — a throwing observer must not fail session.create.
			}
		}
		return {
			sessionId: id,
			backend: backend.kind,
			cwd: opts.cwd,
			sessionFile,
			model: state?.model,
		};
	}

	private async closeSession(sessionId: string): Promise<void> {
		const entry = this.sessions.get(sessionId);
		if (entry === undefined) return;
		this.sessions.delete(sessionId);
		clearSessionPermissions(sessionId);
		try {
			for (const hooks of this.hooksList) {
				try {
					hooks.onSessionClosed?.(sessionId);
				} catch {
					// Observer isolation (audit 6 M-10).
				}
			}
		} finally {
			// A throwing hook must never orphan a live backend (zombie sessions).
			await entry.backend.dispose().catch(() => {});
		}
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

/**
 * LAST RESORT ONLY — pi's session-directory encoding is lossy and this decode is
 * wrong for any path segment containing a hyphen. Prefer resolveResumeCwd.
 */
export function deriveCwdFromSessionPath(sessionPath: string): string {
	const parts = sessionPath.split("/");
	const dirName = parts[parts.length - 2] ?? "";
	if (dirName.startsWith("--") && dirName.endsWith("--")) {
		const encoded = dirName.slice(2, -2);
		return `/${encoded.replaceAll("-", "/")}`;
	}
	return process.cwd();
}

/**
 * Read `cwd` from a session file's header (its first JSONL line). Returns
 * undefined for unreadable files or pre-cwd sessions — callers fall back.
 */
export function readSessionHeaderCwd(sessionPath: string): string | undefined {
	try {
		const fd = openSync(sessionPath, "r");
		try {
			// Bounded read: session files can be multi-megabyte; the header is line 1.
			const buf = Buffer.alloc(65536);
			const bytes = readSync(fd, buf, 0, buf.length, 0);
			const firstLine = buf.subarray(0, bytes).toString("utf8").split("\n", 1)[0] ?? "";
			if (firstLine.length === 0) return undefined;
			const header = JSON.parse(firstLine) as { type?: string; cwd?: unknown };
			if (header.type !== "session") return undefined;
			return typeof header.cwd === "string" && header.cwd.length > 0 ? header.cwd : undefined;
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

/**
 * Resolve the working directory for a resumed session.
 *
 * Pi encodes cwd into the session directory name with
 * `cwd.replace(/[/\\:]/g, "-")`, which is lossy — a hyphen inside a path segment
 * is indistinguishable from a separator, so `--Users-me-my-app--` could be
 * /Users/me/my-app or /Users/me/my/app. Never trust the decode when a real
 * source is available.
 */
export function resolveResumeCwd(
	sessionPath: string,
	suppliedCwd: string | undefined,
	readHeaderCwd: (path: string) => string | undefined = readSessionHeaderCwd
): string {
	if (suppliedCwd !== undefined && suppliedCwd.length > 0) return suppliedCwd;
	const headerCwd = readHeaderCwd(sessionPath);
	if (headerCwd !== undefined && headerCwd.length > 0) return headerCwd;
	return deriveCwdFromSessionPath(sessionPath);
}
