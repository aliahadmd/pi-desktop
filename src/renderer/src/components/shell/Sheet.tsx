/**
 * Slide-over sheet primitive (chapter 14, revised after UX review):
 * FULL-WINDOW surface — the app has hiddenInset traffic lights and no real
 * titlebar, so the sheet owns the whole window. Header clears the traffic
 * lights (pl-20) and is a drag region so the window stays movable.
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

export function Sheet({
	open,
	title,
	onClose,
	children,
	testId,
}: {
	open: boolean;
	title: string;
	onClose(): void;
	children: ReactNode;
	testId?: string;
}): React.JSX.Element {
	const triggerRef = useRef<Element | null>(null);

	useEffect(() => {
		if (open) {
			triggerRef.current = document.activeElement;
		} else {
			(triggerRef.current as HTMLElement | null)?.focus?.();
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	return (
		<AnimatePresence>
			{open && (
				<motion.div
					/* fixed, not absolute: the sheet is a full-window surface and must not
					   depend on the App root staying unpositioned. */
					className="fixed inset-0 z-40 flex flex-col bg-[#141416]"
					data-testid={testId}
					initial={{ opacity: 0, y: 12 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: 8 }}
					transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
				>
					{/* Header doubles as the draggable titlebar; pl clears traffic lights */}
					<div className="titlebar-drag flex h-[52px] shrink-0 items-center border-b border-neutral-800 pl-24 pr-4">
						<h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
						<button
							type="button"
							onClick={onClose}
							className="titlebar-nodrag ml-auto rounded px-3 py-1 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
						>
							Close · Esc
						</button>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto">
						<div className="sheet-body h-full">{children}</div>
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
