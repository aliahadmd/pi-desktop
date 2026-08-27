/**
 * Project-trust prompt modal (audit 6 C-1). Rendered once at the app shell;
 * driven by the useTrustPrompt store via ensureProjectTrust().
 */
import { ShieldAlert } from "lucide-react";
import { useTrustPrompt } from "../../lib/trust";

export function TrustPrompt(): React.JSX.Element | null {
	const pending = useTrustPrompt((s) => s.pending);
	const settle = useTrustPrompt((s) => s.settle);
	if (pending === null) return null;
	return (
		<div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Trust this project?"
				className="w-full max-w-md rounded-xl border border-neutral-700 bg-neutral-900 p-4"
			>
				<div className="mb-2 flex items-center gap-2 text-sm font-medium text-neutral-100">
					<ShieldAlert size={16} className="text-amber-400" aria-hidden />
					Trust this project?
				</div>
				<p className="mb-2 text-xs break-all text-neutral-400">{pending.cwd}</p>
				<p className="mb-4 text-xs text-neutral-500">
					This project contains local .pi resources (extensions, skills, or prompt
					templates) that run as code in this app. Only trust projects whose code you
					are willing to run. Untrusted sessions work normally but skip those
					resources. You can change this later in the Trust panel.
				</p>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={() => settle("cancel")}
						className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={() => settle("untrusted")}
						className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700"
					>
						Open untrusted
					</button>
					<button
						type="button"
						data-testid="trust-project-confirm"
						autoFocus
						onClick={() => settle("trust")}
						className="rounded bg-blue-700 px-3 py-1.5 text-xs text-white hover:bg-blue-600"
					>
						Trust project
					</button>
				</div>
			</div>
		</div>
	);
}
