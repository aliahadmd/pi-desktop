/**
 * Tests for the pure transcript-ingestion logic (chapter 3).
 */
import { describe, expect, it } from "vitest";
import {
	applyEvent,
	createContext,
	hydrate,
	type AssistantBlock,
	type ToolBlock,
} from "../../src/renderer/src/lib/ingest";
import type { PiEvent } from "../../src/shared/pi";

function feed(ctx: ReturnType<typeof createContext>, events: PiEvent[]): void {
	for (const e of events) applyEvent(ctx, e);
}

const textDelta = (delta: string, contentIndex = 0): PiEvent => ({
	type: "message_update",
	delta: { type: "text_delta", contentIndex, delta },
});

describe("transcript ingestion", () => {
	it("builds a streaming assistant block from deltas", () => {
		const ctx = createContext();
		feed(ctx, [
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			textDelta("Hello "),
			textDelta("world"),
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "Hello world" }],
					usage: { totalTokens: 42, cost: { total: 0.01 } },
				},
			},
			{ type: "agent_settled" },
		]);
		expect(ctx.phase).toBe("idle");
		expect(ctx.blocks).toHaveLength(1);
		const block = ctx.blocks[0] as AssistantBlock;
		expect(block.kind).toBe("assistant");
		expect(block.status).toBe("complete");
		expect(block.parts[0]).toEqual({ type: "text", text: "Hello world" });
		expect(block.usageTokens).toBe(42);
	});

	it("separates thinking and text by contentIndex", () => {
		const ctx = createContext();
		feed(ctx, [
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", delta: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } },
			textDelta("answer", 1),
		]);
		const block = ctx.blocks[0] as AssistantBlock;
		expect(block.parts[0]).toEqual({ type: "thinking", text: "hmm" });
		expect(block.parts[1]).toEqual({ type: "text", text: "answer" });
	});

	it("tracks tool calls from start through live output to completion", () => {
		const ctx = createContext();
		feed(ctx, [
			{ type: "message_start", message: { role: "assistant" } },
			{
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "bash",
				args: { command: "ls" },
			},
			{
				type: "tool_execution_update",
				toolCallId: "call_1",
				toolName: "bash",
				partialResult: { content: [{ type: "text", text: "file1" }] },
			},
			{
				type: "tool_execution_update",
				toolCallId: "call_1",
				toolName: "bash",
				partialResult: { content: [{ type: "text", text: "file1\nfile2" }] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "call_1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "file1\nfile2" }] },
				isError: false,
			},
		]);
		const tool = ctx.blocks.find((b) => b.kind === "tool") as ToolBlock | undefined;
		expect(tool?.status).toBe("complete");
		expect(tool?.output).toBe("file1\nfile2");
	});

	it("renders edit-tool diffs from details.diff", () => {
		const ctx = createContext();
		const diff = "diff --git a/f b/f\n@@ -1 +1 @@\n-old\n+new";
		feed(ctx, [
			{
				type: "tool_execution_start",
				toolCallId: "call_edit",
				toolName: "edit",
			},
			{
				type: "tool_execution_end",
				toolCallId: "call_edit",
				toolName: "edit",
				result: { content: [], details: { diff } },
				isError: false,
			},
		]);
		const tool = ctx.blocks.find((b) => b.kind === "tool") as ToolBlock;
		expect(tool.output).toBe(diff);
	});

	it("adds and removes retry notices; failure notice persists", () => {
		const ctx = createContext();
		feed(ctx, [
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529" },
		]);
		expect(ctx.blocks.some((b) => b.kind === "notice" && b.level === "warn")).toBe(true);
		feed(ctx, [{ type: "auto_retry_end", success: true, attempt: 2 }]);
		expect(ctx.blocks.some((b) => b.kind === "notice")).toBe(false);

		feed(ctx, [
			{ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 2000, errorMessage: "529" },
		]);
		feed(ctx, [{ type: "auto_retry_end", success: false, attempt: 3, finalError: "overloaded" }]);
		expect(
			ctx.blocks.some(
				(b) => b.kind === "notice" && b.level === "error" && b.text.includes("overloaded")
			)
		).toBe(true);
	});

	it("hydrates blocks from getMessages output", () => {
		const blocks = hydrate([
			{ role: "user", content: "fix the bug" },
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "done" }],
			},
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: "contents" }],
				isError: false,
			},
			{ role: "bashExecution", command: "ls", output: "a\nb" },
		]);
		expect(blocks.map((b) => b.kind)).toEqual(["user", "assistant", "tool", "tool"]);
		const bash = blocks[3] as ToolBlock;
		expect(bash.argsJson).toBe("ls");
		expect(bash.output).toBe("a\nb");
	});
});
