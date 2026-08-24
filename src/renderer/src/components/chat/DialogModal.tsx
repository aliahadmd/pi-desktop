/**
 * Modal for pi extension UI dialogs (select / confirm / input / editor).
 */
import { useState } from "react";
import type { UiDialogRequest } from "../../../../shared/pi";

export function DialogModal({
	request,
	onAnswer,
}: {
	request: UiDialogRequest;
	onAnswer(response: { requestId: string; value?: string; confirmed?: boolean; cancelled?: boolean }): void;
}): React.JSX.Element {
	const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "");

	function answer(payload: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
		onAnswer({ requestId: request.requestId, ...payload });
	}

	return (
		<div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
			<div className="w-[420px] rounded-xl border border-neutral-700 bg-neutral-900 p-5 shadow-2xl">
				<h3 className="mb-1 text-sm font-semibold text-neutral-200">{request.title}</h3>
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
