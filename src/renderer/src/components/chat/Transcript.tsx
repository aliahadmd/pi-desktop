/**
 * Virtualized transcript with stick-to-bottom streaming and tool grouping.
 */
import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { groupToolRuns, type Block } from "../../lib/ingest";
import { useTranscriptUi } from "../../stores/transcript-ui";
import { BlockView } from "./Blocks";

export function Transcript({
	blocks: rawBlocks,
	phase,
	sessionId,
}: {
	blocks: Block[];
	phase: "idle" | "streaming" | "compacting" | "retrying";
	sessionId: string;
}): React.JSX.Element {
	const parentRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);
	const blocks = useMemo(() => groupToolRuns(rawBlocks), [rawBlocks]);
	const toggleExpanded = useTranscriptUi((st) => st.toggleExpanded);
	// Clicking a tool chip in an assistant message expands that tool's output.
	// Tool blocks are keyed by their toolCallId, so the ui key lines up.
	const onToolClick = (toolCallId: string): void => {
		toggleExpanded(`${sessionId}:${toolCallId}`, false);
	};

	const virtualizer = useVirtualizer({
		count: blocks.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 80,
		overscan: 8,
		getItemKey: (index) => blocks[index]?.id ?? `idx-${String(index)}`,
	});

	const totalSize = virtualizer.getTotalSize();

	// Stick to bottom while streaming unless the user scrolled up.
	useEffect(() => {
		const el = parentRef.current;
		if (el === null || !stickToBottom.current) return;
		el.scrollTop = el.scrollHeight;
	}, [totalSize, blocks.length, phase]);

	function handleScroll(): void {
		const el = parentRef.current;
		if (el === null) return;
		stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	}

	return (
		<div
			ref={parentRef}
			onScroll={handleScroll}
			data-testid="transcript"
			className="relative flex-1 overflow-y-auto"
		>
			{blocks.length === 0 ? (
				<div className="flex h-full items-center justify-center text-sm text-neutral-600">
					No messages yet.
				</div>
			) : (
				<div style={{ height: totalSize, position: "relative" }}>
					{virtualizer.getVirtualItems().map((item) => {
						const block = blocks[item.index] as Block;
						return (
							<div
								key={item.key}
								data-index={item.index}
								ref={virtualizer.measureElement}
								className={
									item.index === blocks.length - 1 ? "animate-block-in" : undefined
								}
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									transform: `translateY(${item.start}px)`,
								}}
							>
								<BlockView block={block} sessionId={sessionId} onToolClick={onToolClick} />
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
