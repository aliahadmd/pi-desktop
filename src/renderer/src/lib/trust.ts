/**
 * Project-trust pre-flight (audit 6 C-1).
 *
 * SDK sessions resolve project trust in the main process and fail CLOSED when
 * a project with trust-requiring .pi resources has no recorded decision. This
 * helper gives create/resume call sites a prompt-first UX: check the decision,
 * ask once via the TrustPrompt modal, record the answer (upstream
 * ProjectTrustStore is the canonical writer), then proceed. An "untrusted"
 * choice still proceeds — upstream opens untrusted sessions fine, it just
 * doesn't load project resources.
 */
import { create } from "zustand";

export type TrustDecision = "trust" | "untrusted" | "cancel";

interface TrustPromptState {
	pending: { cwd: string; resolve: (decision: TrustDecision) => void } | null;
	request(cwd: string): Promise<TrustDecision>;
	settle(decision: TrustDecision): void;
}

export const useTrustPrompt = create<TrustPromptState>((set, get) => ({
	pending: null,
	request(cwd) {
		// A new prompt supersedes any unanswered one (single modal surface).
		get().pending?.resolve("cancel");
		return new Promise((resolve) => set({ pending: { cwd, resolve } }));
	},
	settle(decision) {
		const pending = get().pending;
		if (pending === null) return;
		set({ pending: null });
		pending.resolve(decision);
	},
}));

/**
 * Returns true when the caller should open the session: no trust-requiring
 * resources, already trusted, or the user picked Trust / Open untrusted.
 * False only when the user cancels. On IPC failure, proceed — the
 * main-process factory still fails closed regardless.
 */
export async function ensureProjectTrust(cwd: string): Promise<boolean> {
	try {
		const status = await window.piDesktop.invoke({ type: "session.check_trust", cwd });
		if (!status.ok || !status.data.requiresTrust || status.data.trusted) return true;
	} catch {
		return true;
	}
	const decision = await useTrustPrompt.getState().request(cwd);
	if (decision === "cancel") return false;
	await window.piDesktop
		.invoke({ type: "session.grant_trust", cwd, trusted: decision === "trust" })
		.catch(() => {});
	return true;
}
