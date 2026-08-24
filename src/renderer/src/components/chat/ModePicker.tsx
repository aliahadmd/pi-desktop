/**
 * Permission-mode picker for the composer control row (phase 5).
 *
 * Follows ModelPicker conventions: upward popover, click-away backdrop,
 * Esc closes. Shows an icon per mode; bypass tints amber as a caution.
 */
import { useEffect, useRef, useState } from "react";
import {
	FileCheck,
	ListTodo,
	MessageCircleQuestion,
	ShieldAlert,
	Zap,
	type LucideIcon,
} from "lucide-react";
import {
	PERMISSION_MODE_LABEL,
	permissionModes,
	type PermissionMode,
} from "../../../../shared/pi";

const MODE_ICON: Record<PermissionMode, LucideIcon> = {
	plan: ListTodo,
	alwaysAsk: MessageCircleQuestion,
	askBeforeEdits: ShieldAlert,
	acceptEdits: FileCheck,
	bypass: Zap,
};

export const MODE_DESCRIPTION: Record<PermissionMode, string> = {
	plan: "Read-only research — edits and commands blocked",
	alwaysAsk: "Ask before every edit and command",
	askBeforeEdits: "Auto-approve reads; ask for edits and commands",
	acceptEdits: "Auto-approve file edits; still ask for commands",
	bypass: "Approve everything automatically",
};

export function ModePicker({
	mode,
	onPick,
}: {
	mode: PermissionMode;
	onPick(m: PermissionMode): void;
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

	const ActiveIcon = MODE_ICON[mode];

	return (
		<span className="relative" ref={wrapRef}>
			<button
				type="button"
				data-testid="mode-picker-trigger"
				title={`Mode: ${PERMISSION_MODE_LABEL[mode]}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10px] transition-colors ${
					mode === "bypass"
						? "bg-amber-950/60 text-amber-400 hover:bg-amber-950"
						: mode === "plan"
							? "bg-accent-soft text-accent-strong hover:bg-accent-soft"
							: "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
				}`}
			>
				<ActiveIcon size={11} strokeWidth={2} />
				{PERMISSION_MODE_LABEL[mode]}
			</button>
			{open && (
				<div
					role="listbox"
					data-testid="mode-picker-popover"
					className="absolute bottom-full left-0 z-50 mb-1 w-[300px] overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl shadow-black/50"
				>
					{permissionModes.map((m) => {
						const Icon = MODE_ICON[m];
						const active = m === mode;
						return (
							<button
								key={m}
								type="button"
								role="option"
								aria-selected={active}
								data-testid={`mode-option-${m}`}
								onClick={() => {
									setOpen(false);
									onPick(m);
								}}
								className={`flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-neutral-800 ${
									active ? "text-accent-strong" : "text-neutral-300"
								}`}
							>
								<Icon size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
								<span className="min-w-0">
									<span className="block text-xs">{PERMISSION_MODE_LABEL[m]}</span>
									<span className="block text-[10px] text-neutral-500">
										{MODE_DESCRIPTION[m]}
									</span>
								</span>
							</button>
						);
					})}
				</div>
			)}
		</span>
	);
}
