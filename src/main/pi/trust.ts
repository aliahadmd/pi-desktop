/**
 * Project trust resolution (audit 6 C-1).
 *
 * Upstream pi gates project-local `.pi` resources (extensions, skills, prompt
 * templates) and `.agents/skills` behind per-project trust decisions recorded
 * in `~/.pi/agent/trust.json` — the CLI resolves them via ProjectTrustStore +
 * an interactive prompt and fails CLOSED (untrusted) when no decision exists.
 * The desktop's SDK session path previously constructed
 * `SettingsManager.create(cwd)` with no options, which defaults every project
 * to trusted — hostile repos would auto-execute `.pi/agent/extensions/` in the
 * Electron main process. This module is the single resolution point used by
 * both the session factory (sdk-backend) and the renderer pre-flight channels
 * (PiService).
 */
import {
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";

export interface ProjectTrustStatus {
	/** True when the project has local resources that trust gating applies to. */
	requiresTrust: boolean;
	/** True when loading those resources is allowed (or there is nothing to gate). */
	trusted: boolean;
}

/**
 * Current trust status for a project directory. Fails closed: a project with
 * trust-requiring resources and no recorded decision reports trusted: false.
 * The store reads trust.json on every get(), so TrustPanel / grant_trust
 * writes take effect on the next call.
 */
export function getProjectTrustStatus(
	cwd: string,
	agentDir: string = getAgentDir()
): ProjectTrustStatus {
	if (!hasTrustRequiringProjectResources(cwd)) {
		return { requiresTrust: false, trusted: true };
	}
	const store = new ProjectTrustStore(agentDir);
	return { requiresTrust: true, trusted: store.get(cwd) === true };
}

/**
 * Record (or clear, with null) a trust decision for a project. Uses upstream's
 * ProjectTrustStore as the canonical writer so key normalization and the on-disk
 * format stay identical to the CLI.
 */
export function setProjectTrustDecision(
	cwd: string,
	decision: boolean | null,
	agentDir: string = getAgentDir()
): void {
	new ProjectTrustStore(agentDir).set(cwd, decision);
}
