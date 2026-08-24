/**
 * Renderer session store: consumes pi_event envelopes, builds transcripts via
 * lib/ingest (rAF-batched for streaming), tracks per-session UI state.
 */
import { create } from "zustand";
import type {
	JsonValue,
	PiEvent,
	PiSessionState,
	UiDialogRequest,
} from "../../../shared/pi";
import type { IpcResult } from "../../../shared/protocol";
import type { PiDesktopBridge } from "../../../shared/protocol";

declare global {
	interface Window {
		piDesktop: PiDesktopBridge;
	}
}
import type { SessionOpenedResponse } from "../../../shared/pi";
import {
	applyEvent,
	createContext,
	hydrate,
	type Block,
	type IngestContext,
} from "../lib/ingest";
import { playSoundIfEnabled } from "../services/sound";

const MAX_BLOCKS = 2000;

export interface SessionUi {
	id: string;
	backend: "sdk" | "rpc";
	cwd: string;
	/** User-set or pi-derived session title; undefined until state refresh. */
	sessionName?: string;
	ctx: IngestContext;
	blocks: Block[];
	phase: "idle" | "streaming" | "compacting" | "retrying";
	model?: { provider: string; id: string; name: string };
	thinkingLevel?: PiSessionState["thinkingLevel"];
	lastUsage?: { tokens: number; cost: number };
	queue: { steering: string[]; followUp: string[] };
	pendingDialog?: UiDialogRequest;
	dead?: string; // reason when backend died
	hydrated: boolean;
}

interface PiSessionsState {
	sessions: Record<string, SessionUi>;
	activeId: string | null;
	open(info: SessionOpenedResponse): void;
	close(id: string): void;
	setActive(id: string): void;
	applyEvent(sessionId: string, event: PiEvent): void;
	refreshState(sessionId: string, state: PiSessionState): void;
	/** Optimistic user message (pi does not echo user prompts as events). */
	addUserBlock(sessionId: string, text: string): void;
	/** Surface an error as a transcript notice. */
	pushErrorNotice(sessionId: string, message: string): void;
	/** Surface a generic notice (info/warn/error). */
	pushNotice(sessionId: string, message: string, level?: "info" | "warn" | "error"): void;
}

export const useSessions = create<PiSessionsState>((set, get) => {
	const buffers = new Map<string, PiEvent[]>();
	let scheduled = false;

	/** rAF in the renderer, immediate-ish fallback elsewhere (unit tests). */
	function scheduleFrame(fn: () => void): void {
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
		else setTimeout(fn, 8);
	}

	function enqueue(sessionId: string, event: PiEvent): void {
		const buffer = buffers.get(sessionId) ?? [];
		buffer.push(event);
		buffers.set(sessionId, buffer);
		if (!scheduled) {
			scheduled = true;
			scheduleFrame(() => {
				scheduled = false;
				flush();
			});
		}
	}

	function flush(): void {
		const state = get();
		const updates: Record<string, { ctx: IngestContext; blocks: Block[]; phase: SessionUi["phase"] }> =
			{};
		for (const [sessionId, events] of buffers) {
			const session = state.sessions[sessionId];
			if (session === undefined) continue;
			// Deep-copy blocks minimally: ingest mutates parts/outputs in place,
			// so we snapshot via new array + shallow block copies for changed ones.
			const ctxCopy: IngestContext = {
				...session.ctx,
				blocks: session.blocks.map((b) =>
					b.kind === "assistant" ? { ...b, parts: [...b.parts] } : { ...b }
				),
			};
			for (const event of events) {
				const wasIdle = ctxCopy.phase === "idle";
				applyEvent(ctxCopy, event);
				// Play the completion sound only when a run actually settles —
				// not on hydration or a stray settle arriving while already idle.
				if (event.type === "agent_settled" && !wasIdle) {
					playSoundIfEnabled("complete");
				}
			}
			if (ctxCopy.blocks.length > MAX_BLOCKS) {
				const trimmed = ctxCopy.blocks.length - MAX_BLOCKS;
				ctxCopy.blocks = ctxCopy.blocks.slice(-MAX_BLOCKS);
				ctxCopy.blocks.unshift({
					kind: "notice",
					id: `trim-${Date.now()}`,
					text: `…${trimmed} earlier messages hidden`,
					level: "info",
				});
			}
			updates[sessionId] = {
				ctx: ctxCopy,
				blocks: ctxCopy.blocks,
				phase: ctxCopy.phase,
			};
		}
		buffers.clear();
		if (Object.keys(updates).length === 0) return;
		set((prev) => {
			const next = { ...prev.sessions };
			for (const [id, u] of Object.entries(updates)) {
				const existing = next[id];
				if (existing === undefined) continue;
				next[id] = { ...existing, ctx: u.ctx, blocks: u.blocks, phase: u.phase };
			}
			return { sessions: next };
		});
	}

	return {
		sessions: {},
		activeId: null,

		open(info) {
			const session: SessionUi = {
				id: info.sessionId,
				backend: info.backend,
				cwd: info.cwd,
				ctx: createContext(),
				blocks: [],
				phase: "idle",
				...(info.model !== undefined ? { model: info.model } : {}),
				queue: { steering: [], followUp: [] },
				hydrated: false,
			};
			set((prev) => ({
				sessions: { ...prev.sessions, [info.sessionId]: session },
				activeId: info.sessionId,
			}));
			// Hydrate transcript from pi's own message history.
			void window.piDesktop
				.invoke({ type: "session.messages", sessionId: info.sessionId })
				.then((result: IpcResult<{ messages: JsonValue[] }>) => {
					if (!result.ok) return;
					const blocks = hydrate(result.data.messages);
					set((prev) => {
						const existing = prev.sessions[info.sessionId];
						if (existing === undefined) return prev;
						return {
							sessions: {
								...prev.sessions,
								[info.sessionId]: { ...existing, blocks, hydrated: true },
							},
						};
					});
				});
			// Pull state (model, thinking level).
			void window.piDesktop
				.invoke({ type: "session.state", sessionId: info.sessionId })
				.then((result: IpcResult<PiSessionState>) => {
					if (!result.ok) return;
					get().refreshState(info.sessionId, result.data);
				});
		},

		close(id) {
			void window.piDesktop.invoke({ type: "session.close", sessionId: id });
			set((prev) => {
				const sessions = { ...prev.sessions };
				delete sessions[id];
				const activeId =
					prev.activeId === id
						? (Object.keys(sessions)[0] ?? null)
						: prev.activeId;
				return { sessions, activeId };
			});
		},

		setActive(id) {
			set({ activeId: id });
		},

		applyEvent(sessionId, event) {
			// Non-block events update session fields directly.
			if (
				event.type === "ui_dialog" ||
				event.type === "queue_update" ||
				event.type === "backend_died" ||
				event.type === "thinking_level_changed" ||
				event.type === "session_info_changed" ||
				event.type === "message_end" ||
				event.type === "session_replaced"
			) {
				set((prev) => {
					const s = prev.sessions[sessionId];
					if (s === undefined) return prev;
					const next: SessionUi = { ...s };
					if (event.type === "ui_dialog") next.pendingDialog = event.request;
					if (event.type === "queue_update") {
						next.queue = { steering: [...event.steering], followUp: [...event.followUp] };
					}
					if (event.type === "backend_died") next.dead = event.reason;
					if (event.type === "session_replaced") {
						// Re-hydrate transcript after fork/clone/switch/navigate.
						next.hydrated = false;
						void window.piDesktop
							.invoke({ type: "session.messages", sessionId })
							.then((r) => {
								if (!r.ok) return;
								const state = useSessions.getState();
								const current = state.sessions[sessionId];
								if (current === undefined) return;
								useSessions.setState({
									sessions: {
										...state.sessions,
										[sessionId]: {
											...current,
											blocks: hydrate(r.data.messages),
											hydrated: true,
											...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
										},
									},
								});
							});
					}
					if (event.type === "thinking_level_changed") next.thinkingLevel = event.level;
					if (event.type === "message_end") {
						const message = event.message as {
							role?: string;
							usage?: { totalTokens?: number; cost?: { total?: number } };
							provider?: string;
							model?: string;
						};
						if (message.role === "assistant" && message.usage !== undefined) {
							next.lastUsage = {
								tokens: message.usage.totalTokens ?? 0,
								cost: message.usage.cost?.total ?? 0,
							};
							if (
								typeof message.provider === "string" &&
								typeof message.model === "string"
							) {
								next.model = { provider: message.provider, id: message.model, name: message.model };
							}
						}
					}
					return { sessions: { ...prev.sessions, [sessionId]: next } };
				});
			}
			enqueue(sessionId, event);
		},

		addUserBlock(sessionId, text) {
			set((prev) => {
				const s = prev.sessions[sessionId];
				if (s === undefined) return prev;
				const block: Block = {
					kind: "user",
					id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
					text,
					ts: Date.now(),
				};
				const ctx: IngestContext = { ...s.ctx, blocks: [...s.blocks, block] };
				return {
					sessions: {
						...prev.sessions,
						[sessionId]: { ...s, ctx, blocks: ctx.blocks },
					},
				};
			});
		},

		pushNotice(sessionId, message, level) {
			set((prev) => {
				const s = prev.sessions[sessionId];
				if (s === undefined) return prev;
				const block: Block = {
					kind: "notice",
					id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
					text: message,
					level: level ?? "info",
				};
				const ctx: IngestContext = { ...s.ctx, blocks: [...s.blocks, block] };
				return {
					sessions: {
						...prev.sessions,
						[sessionId]: { ...s, ctx, blocks: ctx.blocks },
					},
				};
			});
		},

		pushErrorNotice(sessionId, message) {
			set((prev) => {
				const s = prev.sessions[sessionId];
				if (s === undefined) return prev;
				const block: Block = {
					kind: "notice",
					id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
					text: message,
					level: "error",
				};
				const ctx: IngestContext = { ...s.ctx, blocks: [...s.blocks, block] };
				return {
					sessions: {
						...prev.sessions,
						[sessionId]: { ...s, ctx, blocks: ctx.blocks },
					},
				};
			});
		},

		refreshState(sessionId, state) {
			set((prev) => {
				const s = prev.sessions[sessionId];
				if (s === undefined) return prev;
				return {
					sessions: {
						...prev.sessions,
						[sessionId]: {
							...s,
							...(state.model !== undefined ? { model: state.model } : {}),
							...(state.sessionName !== undefined
								? { sessionName: state.sessionName }
								: {}),
							thinkingLevel: state.thinkingLevel,
						},
					},
				};
			});
		},
	};
});

/** Global subscription: call once from the app root. */
export function bindPiEvents(): () => void {
	return window.piDesktop.on((ipcEvent) => {
		if (ipcEvent.type !== "pi_event") return;
		useSessions.getState().applyEvent(ipcEvent.sessionId, ipcEvent.event);
	});
}
