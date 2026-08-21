/**
 * Pure transcript-building logic: maps pi event streams into renderable
 * blocks. No React/electron imports — fully unit-testable.
 */
import type { PiEvent } from "../../../shared/pi";

// ---------------------------------------------------------------------------
// Block model
// ---------------------------------------------------------------------------

export interface TextPart {
	type: "text";
	text: string;
}
export interface ThinkingPart {
	type: "thinking";
	text: string;
}
export interface ToolCallPart {
	type: "toolCall";
	toolCallId: string;
	toolName: string;
	argsText: string;
}
export type AssistantPart = TextPart | ThinkingPart | ToolCallPart;

export interface UserBlock {
	kind: "user";
	id: string;
	text: string;
	ts: number;
}
export interface AssistantBlock {
	kind: "assistant";
	id: string;
	parts: AssistantPart[];
	status: "streaming" | "complete" | "error" | "aborted";
	model?: string;
	usageTokens?: number;
	usageCost?: number;
}
export interface ToolBlock {
	kind: "tool";
	id: string;
	toolName: string;
	argsJson?: string;
	output: string;
	status: "running" | "complete" | "error";
}
export interface NoticeBlock {
	kind: "notice";
	id: string;
	text: string;
	level: "info" | "warn" | "error";
}
export type Block = UserBlock | AssistantBlock | ToolBlock | NoticeBlock;

/** Mutable per-session ingestion context (kept outside React state). */
export interface IngestContext {
	blocks: Block[];
	streamingAssistantId: string | null;
	phase: "idle" | "streaming" | "compacting" | "retrying";
	retryNoticeId: string | null;
	seq: number;
}

export function createContext(): IngestContext {
	return {
		blocks: [],
		streamingAssistantId: null,
		phase: "idle",
		retryNoticeId: null,
		seq: 0,
	};
}

function nextId(ctx: IngestContext, prefix: string): string {
	ctx.seq += 1;
	return `${prefix}-${ctx.seq}`;
}

function findTool(blocks: Block[], toolCallId: string): ToolBlock | undefined {
	for (let i = blocks.length - 1; i >= 0; i--) {
		const b = blocks[i];
		if (b !== undefined && b.kind === "tool" && b.id === toolCallId) return b;
	}
	return undefined;
}

function appendToLastAssistant(
	ctx: IngestContext,
	part: AssistantPart,
	contentIndex: number
): void {
	let id = ctx.streamingAssistantId;
	if (id === null) {
		// Defensive: some backends may emit deltas without message_start.
		id = nextId(ctx, "asst");
		ctx.blocks.push({ kind: "assistant", id, parts: [], status: "streaming" });
		ctx.streamingAssistantId = id;
	}
	for (let i = ctx.blocks.length - 1; i >= 0; i--) {
		const b = ctx.blocks[i];
		if (b !== undefined && b.kind === "assistant" && b.id === id) {
			const existing = b.parts[contentIndex];
			if (existing !== undefined) {
				if (
					existing.type === part.type &&
					(existing.type === "text" || existing.type === "thinking") &&
					(part.type === "text" || part.type === "thinking")
				) {
					existing.text += part.text;
				} else {
					b.parts[contentIndex] = part;
				}
			} else {
				b.parts[contentIndex] = part;
			}
			return;
		}
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) =>
				typeof c === "object" && c !== null && (c as {type?:string}).type === "text"
					? String((c as { text?: string }).text ?? "")
					: ""
			)
			.join("");
	}
	return "";
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

export function applyEvent(ctx: IngestContext, event: PiEvent): void {
	switch (event.type) {
		case "agent_start":
			ctx.phase = "streaming";
			break;

		case "agent_settled":
		case "agent_end":
			if (event.type === "agent_end") break;
			ctx.phase = "idle";
			break;

		case "message_start": {
			const message = event.message as { role?: string } | undefined;
			if (message?.role === "assistant") {
				const id = nextId(ctx, "asst");
				ctx.blocks.push({ kind: "assistant", id, parts: [], status: "streaming" });
				ctx.streamingAssistantId = id;
			}
			break;
		}

		case "message_update": {
			const delta = event.delta as {
				type?: string;
				contentIndex?: number;
				delta?: string;
				id?: string;
				toolName?: string;
			};
			const idx = delta.contentIndex ?? 0;
			if (delta.type === "text_delta" && typeof delta.delta === "string") {
				appendToLastAssistant(ctx, { type: "text", text: delta.delta }, idx);
			} else if (delta.type === "thinking_delta" && typeof delta.delta === "string") {
				appendToLastAssistant(ctx, { type: "thinking", text: delta.delta }, idx);
			} else if (delta.type === "toolcall_start") {
				appendToLastAssistant(
					ctx,
					{
						type: "toolCall",
						toolCallId: delta.id ?? nextId(ctx, "call"),
						toolName: delta.toolName ?? "unknown",
						argsText: "",
					},
					idx
				);
			} else if (delta.type === "toolcall_delta" && typeof delta.delta === "string") {
				// args accumulate into the matching toolCall part
				const id = ctx.streamingAssistantId;
				if (id !== null) {
					for (const b of ctx.blocks) {
						if (b.kind === "assistant" && b.id === id) {
							const part = b.parts[idx];
							if (part?.type === "toolCall") part.argsText += delta.delta;
							break;
						}
					}
				}
			}
			break;
		}

		case "message_end": {
			const message = event.message as {
				role?: string;
				content?: Array<Record<string, unknown>>;
				stopReason?: string;
				usage?: { totalTokens?: number; cost?: { total?: number } };
				provider?: string;
				model?: string;
			};
			if (message.role === "assistant") {
				const id = ctx.streamingAssistantId;
				for (let i = ctx.blocks.length - 1; i >= 0; i--) {
					const b = ctx.blocks[i];
					if (
						b !== undefined &&
						b.kind === "assistant" &&
						b.status === "streaming" &&
						(id === null || b.id === id)
					) {
						b.parts = (message.content ?? []).map((c) => {
							if (c.type === "thinking") {
								return { type: "thinking" as const, text: String(c.thinking ?? "") };
							}
							if (c.type === "toolCall") {
								return {
									type: "toolCall" as const,
									toolCallId: String(c.id ?? ""),
									toolName: String(c.name ?? ""),
									argsText: JSON.stringify(c.arguments ?? {}),
								};
							}
							return { type: "text" as const, text: String(c.text ?? "") };
						});
						b.status =
							message.stopReason === "error"
								? "error"
								: message.stopReason === "aborted"
									? "aborted"
									: "complete";
						if (typeof message.provider === "string" && typeof message.model === "string") {
							b.model = `${message.provider}/${message.model}`;
						}
						if (message.usage?.totalTokens !== undefined) {
							b.usageTokens = message.usage.totalTokens;
						}
						if (message.usage?.cost?.total !== undefined) {
							b.usageCost = message.usage.cost.total;
						}
						break;
					}
				}
				ctx.streamingAssistantId = null;
			}
			break;
		}

		case "turn_end":
			// Authoritative tool results arrive via tool_execution_* events.
			break;

		case "tool_execution_start":
			ctx.blocks.push({
				kind: "tool",
				id: event.toolCallId,
				toolName: event.toolName,
				...(event.args === undefined
					? {}
					: { argsJson: JSON.stringify(event.args, null, 2) }),
				output: "",
				status: "running",
			});
			break;

		case "tool_execution_update": {
			const tool = findTool(ctx.blocks, event.toolCallId);
			if (tool !== undefined && event.partialResult !== undefined) {
				const partial = event.partialResult as {
					content?: Array<{ type?: string; text?: string }>;
				};
				const text = (partial.content ?? [])
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("");
				tool.output = text;
			}
			break;
		}

		case "tool_execution_end": {
			const tool = findTool(ctx.blocks, event.toolCallId);
			if (tool !== undefined) {
				tool.status = event.isError ? "error" : "complete";
				if (event.result !== undefined) {
					const result = event.result as {
						content?: Array<{ type?: string; text?: string }>;
						details?: { diff?: string };
					};
					const text = (result.content ?? [])
						.filter((c) => c.type === "text")
						.map((c) => c.text ?? "")
						.join("");
					if (text.length > 0) tool.output = text;
					// Edit/write tools expose a unified diff for rendering.
					if (typeof result.details?.diff === "string" && result.details.diff.length > 0) {
						tool.output = result.details.diff;
					}
				}
			}
			break;
		}

		case "queue_update":
			// handled at store level (needs queue state, not blocks)
			break;

		case "compaction_start":
			ctx.phase = "compacting";
			ctx.blocks.push({
				kind: "notice",
				id: nextId(ctx, "notice"),
				text: `Compacting context (${event.reason})…`,
				level: "info",
			});
			break;

		case "compaction_end": {
			ctx.phase = "streaming";
			const ok = !event.aborted && event.errorMessage === undefined;
			ctx.blocks.push({
				kind: "notice",
				id: nextId(ctx, "notice"),
				text: ok ? "Context compacted." : `Compaction failed: ${event.errorMessage ?? "aborted"}`,
				level: ok ? "info" : "warn",
			});
			break;
		}

		case "auto_retry_start":
			ctx.phase = "retrying";
			ctx.retryNoticeId = nextId(ctx, "notice");
			ctx.blocks.push({
				kind: "notice",
				id: ctx.retryNoticeId,
				text: `Retrying (${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s — ${event.errorMessage.slice(0, 120)}`,
				level: "warn",
			});
			break;

		case "auto_retry_end": {
			if (ctx.retryNoticeId !== null) {
				const idx = ctx.blocks.findIndex((b) => b.id === ctx.retryNoticeId);
				if (idx >= 0) ctx.blocks.splice(idx, 1);
				ctx.retryNoticeId = null;
			}
			if (!event.success) {
				ctx.blocks.push({
					kind: "notice",
					id: nextId(ctx, "notice"),
					text: `Retry failed permanently: ${event.finalError ?? "unknown error"}`,
					level: "error",
				});
			}
			ctx.phase = "streaming";
			break;
		}

		case "bash_execution_update": {
			// Direct RPC bash output; keyed by request id.
			const key = event.id ?? "rpc-bash";
			let tool = findTool(ctx.blocks, key);
			if (tool === undefined) {
				tool = {
					kind: "tool",
					id: key,
					toolName: "bash",
					output: "",
					status: "running",
				};
				ctx.blocks.push(tool);
			}
			tool.output += event.delta;
			break;
		}

		default:
			// ui_*, backend_* handled at store level
			break;
	}
}

// ---------------------------------------------------------------------------
// Hydration from getMessages() (resume / attach)
// ---------------------------------------------------------------------------

interface HydrateMessage {
	role?: string;
	content?: unknown;
	stopReason?: string;
	timestamp?: number;
	provider?: string;
	model?: string;
	command?: string;
	output?: string;
}

export function hydrate(messages: unknown[]): Block[] {
	const blocks: Block[] = [];
	for (const raw of messages) {
		const m = raw as HydrateMessage;
		if (m.role === "user") {
			blocks.push({
				kind: "user",
				id: `u-${blocks.length}`,
				text: extractText(m.content),
				ts: m.timestamp ?? 0,
			});
		} else if (m.role === "assistant") {
			const parts: AssistantPart[] = Array.isArray(m.content)
				? (m.content as Array<Record<string, unknown>>).map((c) => {
						if (c.type === "thinking") {
							return { type: "thinking" as const, text: String(c.thinking ?? "") };
						}
						if (c.type === "toolCall") {
							return {
								type: "toolCall" as const,
								toolCallId: String(c.id ?? ""),
								toolName: String(c.name ?? ""),
								argsText: JSON.stringify(c.arguments ?? {}),
							};
						}
						return { type: "text" as const, text: String(c.text ?? "") };
					})
				: [{ type: "text", text: extractText(m.content) }];
			blocks.push({
				kind: "assistant",
				id: `a-${blocks.length}`,
				parts,
				status:
					m.stopReason === "error"
						? "error"
						: m.stopReason === "aborted"
							? "aborted"
							: "complete",
			});
		} else if (m.role === "toolResult") {
			blocks.push({
				kind: "tool",
				id: String((raw as { toolCallId?: string }).toolCallId ?? `t-${blocks.length}`),
				toolName: String((raw as { toolName?: string }).toolName ?? "tool"),
				output: extractText(m.content),
				status: (raw as { isError?: boolean }).isError === true ? "error" : "complete",
			});
		} else if (m.role === "bashExecution") {
			blocks.push({
				kind: "tool",
				id: `b-${blocks.length}`,
				toolName: "bash",
				...(typeof m.command === "string" ? { argsJson: m.command } : {}),
				output: typeof m.output === "string" ? m.output : "",
				status: "complete",
			});
		}
	}
	return blocks;
}
