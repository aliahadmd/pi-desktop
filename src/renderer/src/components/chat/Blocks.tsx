/**
 * Transcript blocks: user, assistant (markdown + thinking + inline tool chips),
 * tool calls with live output/diffs, tool groups (ch17), notices.
 */
import { memo, useState, type ReactNode } from "react";
import { useTranscriptUi } from "../../stores/transcript-ui";
import Ansi from "ansi-to-react";
import {
	Check,
	ChevronDown,
	ChevronRight,
	ListTodo,
	LoaderCircle,
	Minus,
	Plus,
	Wrench,
	X,
} from "lucide-react";
import { PERMISSION_BLOCK_REASONS } from "../../../../shared/pi";
import { Markdown } from "./Markdown";
import type {
	AssistantBlock,
	Block,
	NoticeBlock,
	ToolBlock,
	ToolGroupBlock,
	UserBlock,
} from "../../lib/ingest";

function DiffView({ diff }: { diff: string }): ReactNode {
	const lines = diff.split("\n");
	return (
		<div className="overflow-x-auto rounded bg-app-bg font-mono text-[11px] leading-relaxed">
			{lines.map((line, i) => {
				const cls = line.startsWith("+")
					? "bg-success-soft text-app-text"
					: line.startsWith("-")
						? "bg-danger-soft text-app-text"
						: line.startsWith("@@") || line.startsWith("diff") || line.startsWith("index")
							? "text-app-faint"
							: "text-app-muted";
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
			<div className="max-w-[80%] rounded-xl rounded-br-sm bg-user-bubble px-4 py-2.5 text-sm whitespace-pre-wrap text-app-text">
				{block.text}
			</div>
		</div>
	);
});

const ToolBlockView = memo(function ToolBlockView({
	block,
	sessionId,
}: {
	block: ToolBlock;
	sessionId: string;
}) {
	const key = `${sessionId}:${block.id}`;
	const fallback = block.status === "running";
	const expanded = useTranscriptUi((s) => s.isExpanded(key, fallback));
	const toggleExpanded = useTranscriptUi((s) => s.toggleExpanded);
	const isDiffOutput = block.status !== "running" && isDiff(block.output);
	const StatusIcon =
		block.status === "running" ? LoaderCircle : block.status === "error" ? X : Check;
	// A permission-blocked call (plan mode / user denial) reads as "planned,
	// not executed" — distinct from a real failure.
	const blockReason = Object.values(PERMISSION_BLOCK_REASONS).find((reason) =>
		block.status === "error" && block.output.startsWith(reason)
	);
	const blockedByPermission = blockReason !== undefined;
	const statusCls =
		block.status === "running"
			? "text-accent-strong"
			: block.status === "error"
				? "text-danger"
				: "text-green-500";
	// Direct `!`/`!!` composer bash gets a requestId ("bash-…"/"rpc-bash") as its
	// block id; agent-driven bash tool calls must go through session.abort instead.
	const isDirectBash =
		block.toolName === "bash" &&
		(block.id === "rpc-bash" || block.id.startsWith("bash-"));
	return (
		<div className="px-4 py-1" data-kind="tool" data-tool={block.toolName}>
			<div className="flex items-center rounded-lg border border-neutral-800 bg-app-surface/60">
				<button
					type="button"
					onClick={() => toggleExpanded(key, fallback)}
					className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs"
				>
					<span className={`flex shrink-0 items-center ${blockedByPermission ? "text-accent-strong" : statusCls}`}>
						{blockedByPermission ? (
							<ListTodo size={12} strokeWidth={2.25} />
						) : (
							<StatusIcon
								size={12}
								strokeWidth={2.25}
								className={block.status === "running" ? "animate-spin" : undefined}
							/>
						)}
					</span>
					<span className="font-medium text-neutral-300">{block.toolName}</span>
					{block.argsJson !== undefined && (
						<span className="truncate font-mono text-[10px] text-neutral-500">
							{block.argsJson.slice(0, 120)}
						</span>
					)}
					<span className="ml-auto flex shrink-0 items-center text-neutral-600">
						{expanded ? <Minus size={11} /> : <Plus size={11} />}
					</span>
				</button>
				{isDirectBash && block.status === "running" && (
					<button
						type="button"
						data-testid="bash-stop"
						title="Kill this shell command"
						onClick={() => {
							void window.piDesktop.invoke({ type: "session.abort_bash", sessionId });
						}}
						className="mr-2 shrink-0 rounded bg-red-900/70 px-1.5 py-0.5 text-[9px] text-red-300 hover:bg-red-800"
					>
						stop
					</button>
				)}
			</div>
			{expanded && block.output.length > 0 && (
				<div
					className={
						blockedByPermission
							? "rounded-lg border-l-2 border-blue-800 p-3 text-[11px] italic text-neutral-400"
							: "rounded-lg border-t border-neutral-800 p-3"
					}
				>
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
	);
});

function ThinkingPartView({ text, uiKey }: { text: string; uiKey: string }): ReactNode {
	const open = useTranscriptUi((s) => s.isExpanded(uiKey, false));
	const toggleExpanded = useTranscriptUi((s) => s.toggleExpanded);
	return (
		<div className="mb-2">
			<button
				type="button"
				onClick={() => toggleExpanded(uiKey, false)}
				className="text-[10px] tracking-wide text-neutral-500 uppercase hover:text-neutral-400"
			>
				<span className="flex items-center gap-1">
					{open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
					Thinking
				</span>
			</button>
			{open && (
				<div className="mt-1 border-l-2 border-neutral-700 pl-3 text-xs whitespace-pre-wrap text-neutral-400 italic">
					{text}
				</div>
			)}
		</div>
	);
}

const AssistantBlockView = memo(function AssistantBlockView({
	block,
	sessionId,
	onToolClick,
}: {
	block: AssistantBlock;
	sessionId: string;
	onToolClick: ((toolCallId: string) => void) | undefined;
}) {
	const streaming = block.status === "streaming";
	const [copied, setCopied] = useState(false);
	return (
		<div className="px-4 py-2" data-kind="assistant" data-status={block.status}>
			{block.parts.map((part, i) => {
				if (part.type === "thinking") {
					return part.text.length > 0 ? (
						<ThinkingPartView
							key={i}
							text={part.text}
							uiKey={`${sessionId}:${block.id}:think-${String(i)}`}
						/>
					) : null;
				}
				if (part.type === "toolCall") {
					return (
						<button
							key={i}
							type="button"
							onClick={() => onToolClick?.(part.toolCallId)}
							className="mr-2 mb-1 inline-flex items-center gap-1 rounded bg-app-surface2 px-2 py-0.5 font-mono text-[10px] text-app-text hover:bg-app-border"
						>
							<span className={`flex shrink-0 items-center ${streaming ? "text-accent-strong" : "text-success"}`}>
								<Wrench size={10} strokeWidth={2} />
							</span>
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
				<div className="text-xs text-danger">Generation failed.</div>
			)}
			{block.status === "aborted" && <div className="text-xs text-amber-500">Aborted.</div>}
			{!streaming && (
				<div className="mt-1 flex items-center gap-2">
					{block.parts.some((p) => p.type === "text" && p.text.length > 0) && (
						<button
							type="button"
							data-testid="copy-message"
							onClick={() => {
								const text = block.parts
									.filter((p) => p.type === "text")
									.map((p) => p.text)
									.join("\n");
								void navigator.clipboard.writeText(text).then(() => {
									setCopied(true);
									setTimeout(() => setCopied(false), 1200);
								});
							}}
							className="text-[10px] text-neutral-600 hover:text-neutral-300"
						>
							<span className="flex shrink-0 items-center text-[10px]">
							{copied ? (
								<span className="flex items-center gap-1 text-green-500">
									<Check size={10} strokeWidth={2.5} /> copied
								</span>
							) : (
								"copy"
							)}
						</span>
						</button>
					)}
					{(block.usageTokens !== undefined || block.model !== undefined) && (
						<span className="font-mono text-[10px] text-neutral-600">
							{[
								block.model,
								block.usageTokens !== undefined ? `${String(block.usageTokens)} tok` : null,
								block.usageCost !== undefined ? `$${block.usageCost.toFixed(4)}` : null,
							]
								.filter(Boolean)
								.join(" · ")}
						</span>
					)}
				</div>
			)}
		</div>
	);
});

const NoticeBlockView = memo(function NoticeBlockView({
	block,
	sessionId,
}: {
	block: NoticeBlock;
	sessionId: string;
}) {
	const key = `${sessionId}:${block.id}`;
	const dismissed = useTranscriptUi((s) => s.isDismissed(key));
	const dismiss = useTranscriptUi((s) => s.dismiss);
	if (dismissed) return null;
	const cls =
		block.level === "error"
			? "text-danger border-danger/40 bg-danger-soft"
			: block.level === "warn"
				? "text-amber-400 border-amber-900 bg-amber-950/40"
				: "text-neutral-400 border-neutral-800 bg-app-surface/40";
	return (
		<div className="px-4 py-1">
			<div className={`flex items-center gap-2 rounded border px-3 py-1.5 text-xs ${cls}`}>
				<span className="flex-1">{block.text}</span>
				<button
					type="button"
					onClick={() => dismiss(key)}
					className="shrink-0 opacity-50 hover:opacity-100"
						title="Dismiss"
						aria-label="Dismiss notice"
					>
						<X size={12} strokeWidth={2} />
					</button>
			</div>
		</div>
	);
});

const ToolGroupView = function ToolGroupView({
	block,
	sessionId,
	renderChild,
}: {
	block: ToolGroupBlock;
	sessionId: string;
	renderChild(child: ToolBlock): ReactNode;
}): ReactNode {
	const key = `${sessionId}:${block.id}`;
	const fallback = block.status === "running";
	const expanded = useTranscriptUi((s) => s.isExpanded(key, fallback));
	const toggleExpanded = useTranscriptUi((s) => s.toggleExpanded);
	const running = block.children.some((c) => c.status === "running");
	const errored = block.children.some((c) => c.status === "error");
	const label =
		block.tools.length === 1 ? (block.tools[0] ?? "tool") : `Ran ${block.children.length} commands`;
	return (
		<div data-kind="tool-group">
			<button
				type="button"
				onClick={() => toggleExpanded(key, fallback)}
				className="flex w-full items-center gap-2 px-4 py-1 text-left text-xs text-neutral-400 hover:bg-app-surface/50"
			>
				<span className={`flex shrink-0 items-center ${running ? "text-accent-strong" : errored ? "text-danger" : "text-green-500"}`}>
					{running ? (
						<LoaderCircle size={12} strokeWidth={2.25} className="animate-spin" />
					) : errored ? (
						<X size={12} strokeWidth={2.25} />
					) : (
						<Check size={12} strokeWidth={2.25} />
					)}
				</span>
				<span className="flex items-center gap-1">
					{expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
					{running ? label : `${label.charAt(0).toUpperCase()}${label.slice(1)}`}
				</span>
			</button>
			{(expanded || running) && (
				<div>
					{block.children.map((child) => (
						<div key={child.id}>{renderChild(child)}</div>
					))}
				</div>
			)}
		</div>
	);
};

export function BlockView({
	block,
	sessionId,
	onToolClick,
}: {
	block: Block;
	sessionId: string;
	onToolClick: ((toolCallId: string) => void) | undefined;
}): ReactNode {
	switch (block.kind) {
		case "user":
			return <UserBlockView block={block} />;
		case "assistant":
			return <AssistantBlockView block={block} sessionId={sessionId} onToolClick={onToolClick} />;
		case "tool":
			return <ToolBlockView block={block} sessionId={sessionId} />;
		case "toolGroup":
			return (
				<ToolGroupView
					block={block}
					sessionId={sessionId}
					renderChild={(child) => (
						<BlockView block={child} sessionId={sessionId} onToolClick={onToolClick} />
					)}
				/>
			);
		case "notice":
			return <NoticeBlockView block={block} sessionId={sessionId} />;
	}
}
