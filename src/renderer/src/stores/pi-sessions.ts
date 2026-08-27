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
	/** Bumped on every session_replaced so effects can re-seed per rebuild. */
	replacedNonce?: number;
	/**
	 * Extension-pushed composer text (ui_editor_text → setEditorText/
	 * pasteToEditor, audit 6 M-11). ChatPage feeds it to the Composer and
	 * clears it via clearInsertText once consumed.
	 */
	insertText?: string;
}

interface PiSessionsState {
	sessions: Record<string, SessionUi>;
	activeId: string | null;
	open(info: SessionOpenedResponse): void;
	close(id: string): void;
	setActive(id: string): void;
	applyEvent(sessionId: string, event: PiEvent): void;
	refreshState(sessionId: string, state: PiSessionState): void;
	/**
	 * Optimistic user message (pi does not echo user prompts as events).
	 * Returns the block id so a failed prompt can remove it again (audit 6
	 * M-15); null when the session is unknown.
	 */
	addUserBlock(sessionId: string, text: string): string | null;
	/** Remove a block by id (phantom-prompt rollback, audit 6 M-15). */
	removeBlock(sessionId: string, blockId: string): void;
	/** Surface an error as a transcript notice. */
	pushErrorNotice(sessionId: string, message: string): void;
	/** Surface a generic notice (info/warn/error). */
	pushNotice(sessionId: string, message: string, level?: "info" | "warn" | "error"): void;
	/** Clear routed ui_editor_text after the composer consumed it (M-11). */
	clearInsertText(sessionId: string): void;
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
		requestFlush();
	}

	function requestFlush(): void {
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
		// Only sessions whose transcript is settled may ingest: while a
		// (re-)hydration is in flight the buffer must wait, or the async
		// hydrate would clobber event-derived blocks when it lands
		// (audit 6 M-16). Buffers for closed sessions are dropped.
		const ready = new Map<string, PiEvent[]>();
		for (const [sessionId, events] of buffers) {
			const session = state.sessions[sessionId];
			if (session === undefined) buffers.delete(sessionId);
			else if (session.hydrated) ready.set(sessionId, events);
		}
		for (const id of ready.keys()) buffers.delete(id);
		if (ready.size === 0) return;

		let playComplete = false;
		// Compute inside set(): re-reading prev.sessions here (instead of the
		// pre-set snapshot) is what closes the race with an async hydrate that
		// lands between event capture and commit (audit 6 M-16).
		set((prev) => {
			const next = { ...prev.sessions };
			for (const [sessionId, events] of ready) {
				const existing = next[sessionId];
				if (existing === undefined) continue;
				// Deep-copy blocks minimally: ingest mutates parts/outputs in place,
				// so we snapshot via new array + shallow block copies for changed ones.
				const ctxCopy: IngestContext = {
					...existing.ctx,
					blocks: existing.blocks.map((b) =>
						b.kind === "assistant" ? { ...b, parts: [...b.parts] } : { ...b }
					),
				};
				let compactedCleanly = false;
				for (const event of events) {
					const wasIdle = ctxCopy.phase === "idle";
					applyEvent(ctxCopy, event);
					// Play the completion sound only when a run actually settles —
					// not on hydration or a stray settle arriving while already idle.
					if (event.type === "agent_settled" && !wasIdle) {
						playComplete = true;
					}
					if (
						event.type === "compaction_end" &&
						!event.aborted &&
						event.errorMessage === undefined
					) {
						compactedCleanly = true;
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
					// The streaming target may have been trimmed away; reset it so
					// later deltas start a fresh block instead of being silently
					// dropped (audit 6 L-13).
					if (
						ctxCopy.streamingAssistantId !== null &&
						!ctxCopy.blocks.some(
							(b) =>
								b.kind === "assistant" && b.id === ctxCopy.streamingAssistantId
						)
					) {
						ctxCopy.streamingAssistantId = null;
					}
				}
				const updated: SessionUi = {
					...existing,
					ctx: ctxCopy,
					blocks: ctxCopy.blocks,
					phase: ctxCopy.phase,
				};
				// After a compaction the pre-compaction token/cost figures describe
				// a context that no longer exists — blank them (audit 6 L-13).
				if (compactedCleanly) delete updated.lastUsage;
				next[sessionId] = updated;
			}
			return { sessions: next };
		});
		if (playComplete) playSoundIfEnabled("complete");
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
			// Hydrate transcript from pi's own message history. Events buffer
			// until this resolves (flush skips un-hydrated sessions), so a
			// mid-run resume never loses early events to a late hydrate
			// (audit 6 M-16).
			void window.piDesktop
				.invoke({ type: "session.messages", sessionId: info.sessionId })
				.then((result: IpcResult<{ messages: JsonValue[] }>) => {
					set((prev) => {
						const existing = prev.sessions[info.sessionId];
						if (existing === undefined) return prev;
						if (!result.ok) {
							// A failed hydrate must still release the event buffer.
							return {
								sessions: {
									...prev.sessions,
									[info.sessionId]: { ...existing, hydrated: true },
								},
							};
						}
						const blocks = hydrate(result.data.messages);
						// Seed the status bar from the last assistant message that
						// reported usage — otherwise it stays blank after a resume
						// until the next completed turn (audit 6 L-13).
						let lastUsage: SessionUi["lastUsage"];
						for (const raw of result.data.messages) {
							const m = raw as {
								role?: string;
								usage?: { totalTokens?: number; cost?: { total?: number } };
							};
							if (m.role === "assistant" && m.usage?.totalTokens !== undefined) {
								lastUsage = {
									tokens: m.usage.totalTokens,
									cost: m.usage.cost?.total ?? 0,
								};
							}
						}
						return {
							sessions: {
								...prev.sessions,
								[info.sessionId]: {
									...existing,
									blocks,
									ctx: { ...createContext(), blocks },
									...(lastUsage !== undefined ? { lastUsage } : {}),
									hydrated: true,
								},
							},
						};
					});
					// Release anything that buffered while hydrating.
					requestFlush();
				})
				.catch(() => {
					set((prev) => {
						const existing = prev.sessions[info.sessionId];
						if (existing === undefined || existing.hydrated) return prev;
						return {
							sessions: {
								...prev.sessions,
								[info.sessionId]: { ...existing, hydrated: true },
							},
						};
					});
					requestFlush();
				});
			// Pull state (model, thinking level).
			void window.piDesktop
				.invoke({ type: "session.state", sessionId: info.sessionId })
				.then((result: IpcResult<PiSessionState>) => {
					if (!result.ok) return;
					get().refreshState(info.sessionId, result.data);
				})
				.catch(() => {});
		},

		close(id) {
			void window.piDesktop.invoke({ type: "session.close", sessionId: id });
			buffers.delete(id);
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
			// Audit 6 M-11: extension notifications, editor-text pushes, and
			// backend warnings used to fall through every filter and vanish.
			// Route them instead of dropping.
			if (event.type === "ui_notify" || event.type === "backend_warning") {
				const text = event.type === "ui_notify" ? event.message : event.reason;
				const level =
					event.type === "backend_warning"
						? "warn"
						: event.notifyType === "error"
							? "error"
							: event.notifyType === "warning"
								? "warn"
								: "info";
				get().pushNotice(sessionId, text, level);
				return;
			}
			if (event.type === "ui_editor_text") {
				// setEditorText/pasteToEditor → composer insertion (append-only;
				// the composer has no replace-channel). Empty text is a no-op.
				if (event.text.length === 0) return;
				set((prev) => {
					const s = prev.sessions[sessionId];
					if (s === undefined) return prev;
					return {
						sessions: { ...prev.sessions, [sessionId]: { ...s, insertText: event.text } },
					};
				});
				return;
			}
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
					// Rename: pi emits session_info_changed after setSessionName.
					// The filter below admitted this event but no branch consumed it,
					// so the tab label stayed stale until an unrelated refresh
					// (audit 5 M-2).
					if (event.type === "session_info_changed" && event.name !== undefined) {
						next.sessionName = event.name;
					}
					if (event.type === "queue_update") {
						next.queue = { steering: [...event.steering], followUp: [...event.followUp] };
					}
					if (event.type === "backend_died") next.dead = event.reason;
					if (event.type === "session_replaced") {
						// Re-hydrate transcript after fork/clone/switch/navigate.
						// Reset the ingest ctx and drop buffered pre-replace events:
						// a stale ctx.streamingAssistantId silently swallowed the new
						// branch's first deltas, and stale buffered events would land
						// on the replacement transcript (audit 6 M-16).
						buffers.delete(sessionId);
						next.hydrated = false;
						next.replacedNonce = (s.replacedNonce ?? 0) + 1;
						next.ctx = { ...createContext(), blocks: next.blocks };
						void window.piDesktop
							.invoke({ type: "session.messages", sessionId })
							.then((r) => {
								const state = useSessions.getState();
								const current = state.sessions[sessionId];
								if (current === undefined) return;
								if (!r.ok) {
									// Release the event buffer even when re-hydration fails.
									useSessions.setState({
										sessions: {
											...state.sessions,
											[sessionId]: { ...current, hydrated: true },
										},
									});
									return;
								}
								const blocks = hydrate(r.data.messages);
								useSessions.setState({
									sessions: {
										...state.sessions,
										[sessionId]: {
											...current,
											blocks,
											ctx: { ...createContext(), blocks },
											hydrated: true,
											...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
										},
									},
								});
							})
							.catch(() => {
								const state = useSessions.getState();
								const current = state.sessions[sessionId];
								if (current === undefined || current.hydrated) return;
								useSessions.setState({
									sessions: {
										...state.sessions,
										[sessionId]: { ...current, hydrated: true },
									},
								});
							})
							.finally(() => {
								// Release events that buffered while re-hydrating.
								requestFlush();
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
			const block: Block = {
				kind: "user",
				id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				text,
				ts: Date.now(),
			};
			let added = false;
			set((prev) => {
				const s = prev.sessions[sessionId];
				if (s === undefined) return prev;
				added = true;
				const ctx: IngestContext = { ...s.ctx, blocks: [...s.blocks, block] };
				return {
					sessions: {
						...prev.sessions,
						[sessionId]: { ...s, ctx, blocks: ctx.blocks },
					},
				};
			});
			return added ? block.id : null;
		},

		removeBlock(sessionId, blockId) {
			set((prev) => {
				const s = prev.sessions[sessionId];
				if (s === undefined || !s.blocks.some((b) => b.id === blockId)) return prev;
				const ctx: IngestContext = {
					...s.ctx,
					blocks: s.blocks.filter((b) => b.id !== blockId),
				};
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

		clearInsertText(sessionId) {
			set((prev) => {
				const s = prev.sessions[sessionId];
				if (s === undefined || s.insertText === undefined) return prev;
				const next: SessionUi = { ...s };
				delete next.insertText;
				return { sessions: { ...prev.sessions, [sessionId]: next } };
			});
		},

		refreshState(sessionId, state) {
			set((prev) => {
				const s = prev.sessions[sessionId];
				if (s === undefined) return prev;
				// A model switch invalidates the status bar's usage figures — they
				// were produced by (and priced at) the previous model (audit 6 L-13).
				const modelChanged =
					state.model !== undefined &&
					(s.model === undefined ||
						s.model.provider !== state.model.provider ||
						s.model.id !== state.model.id);
				const next: SessionUi = {
					...s,
					...(state.model !== undefined ? { model: state.model } : {}),
					...(state.sessionName !== undefined
						? { sessionName: state.sessionName }
						: {}),
					thinkingLevel: state.thinkingLevel,
				};
				if (modelChanged) delete next.lastUsage;
				return {
					sessions: { ...prev.sessions, [sessionId]: next },
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

/**
 * Window-reopen / renderer-reload reattach (audit 6 H-1): sessions live in the
 * main process and survive the window. On mount, adopt every already-open
 * session the store doesn't know about. Ids already present are skipped —
 * open() would otherwise wipe their blocks and re-hydrate a live transcript.
 */
export async function rehydrateOpenSessions(): Promise<void> {
	const result = await window.piDesktop.invoke({ type: "session.list_open" });
	if (!result.ok) return;
	for (const info of result.data.sessions) {
		if (useSessions.getState().sessions[info.sessionId] !== undefined) continue;
		useSessions.getState().open(info);
	}
}
