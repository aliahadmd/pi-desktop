/**
 * Virtualized transcript with stick-to-bottom streaming and tool grouping.
 */
import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { groupToolRuns, type Block } from "../../lib/ingest";
import { BlockView } from "./Blocks";

export function Transcript({
	blocks: rawBlocks,
	phase,
}: {
	blocks: Block[];
	phase: "idle" | "streaming" | "compacting" | "retrying";
}): React.JSX.Element {
	const parentRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);
	const blocks = groupToolRuns(rawBlocks);
	const noopToolClick = (toolCallId: string): void => {
		void toolCallId;
	};

	const virtualizer = useVirtualizer({
		count: blocks.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 80,
		overscan: 8,
	});

	// Stick to bottom while streaming unless the user scrolled up.
	useEffect(() => {
		const el = parentRef.current;
		if (el === null || !stickToBottom.current) return;
		el.scrollTop = el.scrollHeight;
	}, [blocks.length, phase]);

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
				<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
					{virtualizer.getVirtualItems().map((item) => {
						const block = blocks[item.index] as Block;
						return (
							<div
								key={`${block.kind}-${String(item.key)}`}
								data-index={item.index}
								ref={virtualizer.measureElement}
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									transform: `translateY(${item.start}px)`,
									animation: "block-enter var(--dur-med) var(--ease-standard)",
								}}
							>
								<BlockView block={block} onToolClick={noopToolClick} />
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
