/**
 * RPC permission-gate honesty (audit 6 H-3).
 *
 * RPC sessions run without the approval gate — an inline extension factory
 * cannot cross the `pi --mode rpc` subprocess boundary (docs/security.md
 * "Known limitations"). The ModePicker is hidden for RPC tabs so it can't
 * promise gating that nothing enforces, and the FIRST RPC session a user
 * creates gets this one-time transcript warning so the missing gate is
 * discovered rather than assumed. The persistent "Ungated (RPC)" composer
 * chip covers every subsequent RPC session.
 */
import { useSessions } from "../stores/pi-sessions";

const STORAGE_KEY = "pidesktop.rpcUngatedWarningShown";

export function warnRpcUngatedOnce(sessionId: string): void {
	try {
		if (localStorage.getItem(STORAGE_KEY) !== null) return;
		localStorage.setItem(STORAGE_KEY, "1");
	} catch {
		// localStorage unavailable — fail toward showing the notice.
	}
	useSessions
		.getState()
		.pushNotice(
			sessionId,
			"RPC session: permission modes are not enforced here — the agent runs every tool call (edits, bash) without asking. Use an SDK session for gated autonomy.",
			"warn"
		);
}
