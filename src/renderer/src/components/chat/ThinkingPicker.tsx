/**
 * ThinkingPicker: reasoning-effort selector for the composer control row.
 *
 * Sits next to the model picker. Levels are clamped to what the active model
 * supports (session.thinking_levels); the popover follows the ModelPicker
 * conventions — upward, click-away backdrop, Esc closes.
 */
import { useEffect, useRef, useState } from "react";
import { Brain } from "lucide-react";
import { piThinkingLevels, type PiThinkingLevel } from "../../../../shared/pi";

export function ThinkingPicker({
	level,
	supportedLevels,
	onPick,
}: {
	level?: PiThinkingLevel | undefined;
	/** Supported levels for the active session; empty/unknown → full default list. */
	supportedLevels: PiThinkingLevel[];
	onPick(level: PiThinkingLevel): void;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") setOpen(false);
		};
		const onClick = (e: MouseEvent): void => {
			if (wrapRef.current?.contains(e.target as Node) === true) return;
			setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("mousedown", onClick, true);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("mousedown", onClick, true);
		};
	}, [open]);

	const choices: PiThinkingLevel[] =
		supportedLevels.length > 0 ? supportedLevels : [...piThinkingLevels];

	return (
		<span className="relative" ref={wrapRef}>
			<button
				type="button"
				data-testid="thinking-picker-trigger"
				title="Reasoning effort"
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
			>
				<Brain size={11} strokeWidth={2} />
				{level ?? "off"}
			</button>
			{open && (
				<div
					role="listbox"
					data-testid="thinking-picker-popover"
					className="absolute bottom-full left-0 z-50 mb-1 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl shadow-black/50"
				>
					{choices.map((l) => (
						<button
							key={l}
							type="button"
							role="option"
							aria-selected={level === l}
							onClick={() => {
								setOpen(false);
								onPick(l);
							}}
							className={`block w-full px-4 py-1.5 text-left text-xs hover:bg-neutral-800 ${
								level === l ? "text-blue-400" : "text-neutral-300"
							}`}
						>
							{l}
						</button>
					))}
				</div>
			)}
		</span>
	);
}
