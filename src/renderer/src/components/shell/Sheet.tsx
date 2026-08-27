/**
 * Slide-over sheet primitive (chapter 14, revised after UX review):
 * FULL-WINDOW surface — the app has hiddenInset traffic lights and no real
 * titlebar, so the sheet owns the whole window. Header clears the traffic
 * lights (pl-20) and is a drag region so the window stays movable.
 *
 * Focus (audit 6 M-20): opening moves focus INTO the sheet (it previously
 * stayed in the covered composer, so keystrokes landed behind the sheet) and
 * Tab loops within it (`role="dialog" aria-modal`).
 *
 * Esc (audit 6 M-27): blurs the focused control BEFORE closing so onBlur-save
 * fields (Settings text inputs) commit instead of silently losing the edit.
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
	const sheetRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (open) {
			triggerRef.current = document.activeElement;
			// Focus the sheet container so typing no longer lands behind it.
			sheetRef.current?.focus();
		} else {
			(triggerRef.current as HTMLElement | null)?.focus?.();
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				// Commit any focused onBlur-save field before closing (M-27).
				const el = document.activeElement;
				if (el instanceof HTMLElement) el.blur();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	/** Loop Tab/Shift+Tab within the sheet (focus trap, M-20). */
	function onKeyDown(e: React.KeyboardEvent): void {
		if (e.key !== "Tab") return;
		const root = sheetRef.current;
		if (root === null) return;
		const focusables = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
			(el) => el.offsetParent !== null || el === document.activeElement
		);
		if (focusables.length === 0) {
			e.preventDefault();
			return;
		}
		const first = focusables[0] as HTMLElement;
		const last = focusables[focusables.length - 1] as HTMLElement;
		const current = document.activeElement;
		if (!root.contains(current)) {
			e.preventDefault();
			first.focus();
		} else if (e.shiftKey && current === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && current === last) {
			e.preventDefault();
			first.focus();
		}
	}

	return (
		<AnimatePresence>
			{open && (
				<motion.div
					ref={sheetRef}
					/* fixed, not absolute: the sheet is a full-window surface and must not
					   depend on the App root staying unpositioned. */
					className="fixed inset-0 z-40 flex flex-col bg-app-bg outline-none"
					data-testid={testId}
					role="dialog"
					aria-modal="true"
					aria-label={title}
					tabIndex={-1}
					onKeyDown={onKeyDown}
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
