/**
 * Transcript blocks: user, assistant (markdown + thinking + inline tool chips),
 * tool calls (live output, ANSI, diffs), notices.
 */
import { memo, useState, type ReactNode } from "react";
import Ansi from "ansi-to-react";
import { Markdown } from "./Markdown";
import type { AssistantBlock, Block, NoticeBlock, ToolBlock, UserBlock } from "../../lib/ingest";

function DiffView({ diff }: { diff: string }): ReactNode {
	const lines = diff.split("\n");
	return (
		<div className="overflow-x-auto rounded bg-neutral-950 font-mono text-[11px] leading-relaxed">
			{lines.map((line, i) => {
				const cls = line.startsWith("+")
					? "bg-green-950/60 text-green-300"
					: line.startsWith("-")
						? "bg-red-950/60 text-red-300"
						: line.startsWith("@@") || line.startsWith("diff") || line.startsWith("index")
							? "text-neutral-500"
							: "text-neutral-300";
				return (
					<div key={i} className={`px-3 whitespace-pre ${cls}`}>
						{line}
					</div>
				);
			})}
		</div>
	);
}

const isDiff = (output: string): boolean =>
	output.startsWith("diff --git") || output.includes("\n@@ ");

export const UserBlockView = memo(function UserBlockView({ block }: { block: UserBlock }) {
	return (
		<div className="flex justify-end px-4 py-2" data-kind="user">
			<div className="max-w-[80%] rounded-xl rounded-br-sm bg-blue-950/70 px-4 py-2.5 text-sm whitespace-pre-wrap text-neutral-100">
				{block.text}
			</div>
		</div>
	);
});

const ToolBlockView = memo(function ToolBlockView({ block }: { block: ToolBlock }) {
	const [expanded, setExpanded] = useState(block.status === "running");
	const isDiffOutput = block.status !== "running" && isDiff(block.output);
	const statusIcon =
		block.status === "running" ? "⟳" : block.status === "error" ? "✗" : "✓";
	const statusCls =
		block.status === "running"
			? "text-blue-400"
			: block.status === "error"
				? "text-red-400"
				: "text-green-500";
	return (
		<div className="px-4 py-1" data-kind="tool" data-tool={block.toolName}>
			<div className="rounded-lg border border-neutral-800 bg-neutral-900/60">
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
				>
					<span className={statusCls}>{statusIcon}</span>
					<span className="font-medium text-neutral-300">{block.toolName}</span>
					{block.argsJson !== undefined && (
						<span className="truncate font-mono text-[10px] text-neutral-500">
							{block.argsJson.slice(0, 120)}
						</span>
					)}
					<span className="ml-auto text-[10px] text-neutral-600">{expanded ? "−" : "+"}</span>
				</button>
				{expanded && block.output.length > 0 && (
					<div className="border-t border-neutral-800 p-3">
						{isDiffOutput ? (
							<DiffView diff={block.output} />
						) : (
							<pre className="max-h-64 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-neutral-300">
								<Ansi>{block.output.slice(0, 20_000)}</Ansi>
							</pre>
						)}
					</div>
				)}
			</div>
		</div>
	);
});

function ThinkingPartView({ text }: { text: string }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="mb-2">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="text-[10px] tracking-wide text-neutral-500 uppercase hover:text-neutral-400"
			>
				{open ? "▾" : "▸"} Thinking
			</button>
			{open && (
				<div className="mt-1 border-l-2 border-neutral-700 pl-3 text-xs whitespace-pre-wrap text-neutral-400 italic">
					{text}
				</div>
			)}
		</div>
	);
}

export const AssistantBlockView = memo(function AssistantBlockView({
	block,
	onToolClick,
}: {
	block: AssistantBlock;
	onToolClick: ((toolCallId: string) => void) | undefined;
}) {
	const streaming = block.status === "streaming";
	return (
		<div className="px-4 py-2" data-kind="assistant" data-status={block.status}>
			{block.parts.map((part, i) => {
				if (part.type === "thinking") {
					return part.text.length > 0 ? <ThinkingPartView key={i} text={part.text} /> : null;
				}
				if (part.type === "toolCall") {
					return (
						<button
							key={i}
							type="button"
							onClick={() => onToolClick?.(part.toolCallId)}
							className="mr-2 mb-1 inline-flex items-center gap-1 rounded bg-neutral-800 px-2 py-0.5 font-mono text-[10px] text-neutral-300 hover:bg-neutral-700"
						>
							<span className={streaming ? "text-blue-400" : "text-green-500"}>⚒</span>
							{part.toolName}
						</button>
					);
				}
				return part.text.length > 0 ? (
					<div key={i} className="mb-1">
						<Markdown text={part.text} />
						{streaming && i === block.parts.length - 1 && (
							<span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-blue-400 align-middle" />
						)}
					</div>
				) : null;
			})}
			{block.status === "error" && (
				<div className="text-xs text-red-400">Generation failed.</div>
			)}
			{block.status === "aborted" && (
				<div className="text-xs text-amber-500">Aborted.</div>
			)}
			{!streaming && (block.usageTokens !== undefined || block.model !== undefined) && (
				<div className="mt-1 font-mono text-[10px] text-neutral-600">
					{[block.model, block.usageTokens !== undefined ? `${block.usageTokens} tok` : null,
						block.usageCost !== undefined ? `$${block.usageCost.toFixed(4)}` : null]
						.filter(Boolean)
						.join(" · ")}
				</div>
			)}
		</div>
	);
});

const NoticeBlockView = memo(function NoticeBlockView({ block }: { block: NoticeBlock }) {
	const cls =
		block.level === "error"
			? "text-red-400 border-red-900 bg-red-950/40"
			: block.level === "warn"
				? "text-amber-400 border-amber-900 bg-amber-950/40"
				: "text-neutral-400 border-neutral-800 bg-neutral-900/40";
	return (
		<div className="px-4 py-1">
			<div className={`rounded border px-3 py-1.5 text-xs ${cls}`}>{block.text}</div>
		</div>
	);
});

export function BlockView({
	block,
	onToolClick,
}: {
	block: Block;
	onToolClick: ((toolCallId: string) => void) | undefined;
}): ReactNode {
	switch (block.kind) {
		case "user":
			return <UserBlockView block={block} />;
		case "assistant":
			return <AssistantBlockView block={block} onToolClick={onToolClick} />;
		case "tool":
			return <ToolBlockView block={block} />;
		case "notice":
			return <NoticeBlockView block={block} />;
	}
}
