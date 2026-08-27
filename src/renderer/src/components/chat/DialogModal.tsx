/**
 * Modal for pi extension UI dialogs (select / confirm / input / editor).
 *
 * Main parks the agent on the dialog promise until an answer arrives, with a
 * default 5-minute timeout (src/main/pi/extension-ui.ts). Requests carry the
 * effective deadline as timeoutMs: the modal shows it and dismisses itself
 * just after it passes, so a dialog that already timed out main-side never
 * lingers as a dead modal. Every method can be cancelled (Cancel button or
 * Esc), which resolves the dialog fail-closed (confirm → false, others →
 * undefined) via session.respond_ui.
 */
import { useEffect, useState } from "react";
import type { UiDialogRequest } from "../../../../shared/pi";

export function DialogModal({
	request,
	onAnswer,
}: {
	request: UiDialogRequest;
	onAnswer(response: { requestId: string; value?: string; confirmed?: boolean; cancelled?: boolean }): void;
}): React.JSX.Element {
	const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "");
	const [remainingS, setRemainingS] = useState<number | null>(null);

	function answer(payload: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
		onAnswer({ requestId: request.requestId, ...payload });
	}

	// Esc cancels — the same fail-closed answer as the Cancel button.
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") answer({ cancelled: true });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	// Deadline hint + self-dismiss. Main's own timer resolves the dialog at
	// timeoutMs; the 1s grace lets that win, making our late cancel a harmless
	// no-op (the adapter finds nothing pending) instead of a duplicate answer.
	useEffect(() => {
		const timeoutMs = request.timeoutMs;
		if (timeoutMs === undefined) return;
		const startedAt = Date.now();
		setRemainingS(Math.ceil(timeoutMs / 1000));
		const tick = setInterval(() => {
			setRemainingS(Math.max(0, Math.ceil((timeoutMs - (Date.now() - startedAt)) / 1000)));
		}, 1000);
		const dismiss = setTimeout(() => answer({ cancelled: true }), timeoutMs + 1000);
		return () => {
			clearInterval(tick);
			clearTimeout(dismiss);
		};
		// Keyed on the request identity: a replacement dialog re-arms both timers.
	}, [request.requestId, request.timeoutMs]);

	return (
		<div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
			<div className="w-[420px] rounded-xl border border-neutral-700 bg-neutral-900 p-5 shadow-2xl">
				<h3 className="mb-1 text-sm font-semibold text-neutral-200">{request.title}</h3>
				{remainingS !== null && (
					<p className="mb-3 text-[11px] text-neutral-500">
						Auto-dismisses in {Math.floor(remainingS / 60)}:{String(remainingS % 60).padStart(2, "0")} if left unanswered.
					</p>
				)}
				{request.method === "confirm" && (
					<>
						<p className="mb-4 text-xs text-neutral-400">{request.message}</p>
						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={() => answer({ confirmed: false })}
								className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700"
							>
								Deny
							</button>
							<button
								type="button"
								onClick={() => answer({ confirmed: true })}
								data-testid="dialog-confirm"
								className="rounded bg-blue-600 px-3 py-1.5 text-xs text-on-accent hover:bg-blue-500"
							>
								Allow
							</button>
						</div>
					</>
				)}
				{request.method === "select" && (
					<div className="flex flex-col gap-1">
						{request.options.map((option: string) => (
							<button
								key={option}
								type="button"
								onClick={() => answer({ value: option })}
								className="rounded px-3 py-2 text-left text-xs text-neutral-200 hover:bg-neutral-800"
							>
								{option}
							</button>
						))}
						<div className="mt-2 flex justify-end">
							<button
								type="button"
								onClick={() => answer({ cancelled: true })}
								data-testid="dialog-cancel"
								className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700"
							>
								Cancel
							</button>
						</div>
					</div>
				)}
				{(request.method === "input" || request.method === "editor") && (
					<>
						{request.method === "input" ? (
							<input
								value={value}
								onChange={(e) => setValue(e.target.value)}
								placeholder={request.placeholder}
								autoFocus
								className="mb-4 w-full rounded border border-neutral-700 bg-app-bg px-3 py-2 text-sm outline-none focus:border-blue-500"
							/>
						) : (
							<textarea
								value={value}
								onChange={(e) => setValue(e.target.value)}
								rows={8}
								autoFocus
								className="mb-4 w-full resize-none rounded border border-neutral-700 bg-app-bg px-3 py-2 font-mono text-xs outline-none focus:border-blue-500"
							/>
						)}
						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={() => answer({ cancelled: true })}
								className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={() => answer({ value })}
								className="rounded bg-blue-600 px-3 py-1.5 text-xs text-on-accent hover:bg-blue-500"
							>
								OK
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
