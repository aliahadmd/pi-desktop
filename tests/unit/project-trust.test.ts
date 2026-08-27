/**
 * Project trust resolution (audit 6 C-1): getProjectTrustStatus must fail
 * closed for projects with trust-requiring resources and no recorded decision,
 * and setProjectTrustDecision must round-trip via upstream's ProjectTrustStore
 * so the CLI and the desktop share the same trust.json.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getProjectTrustStatus,
	setProjectTrustDecision,
} from "../../src/main/pi/trust";

const tmpDirs: string[] = [];

function makeTmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

describe("project trust", () => {
	it("trusts directories with no trust-requiring resources", () => {
		const cwd = makeTmp("pi-trust-plain-");
		expect(getProjectTrustStatus(cwd, makeTmp("pi-trust-agent-"))).toEqual({
			requiresTrust: false,
			trusted: true,
		});
	});

	it("requires trust for .pi/extensions and fails closed by default", () => {
		const cwd = makeTmp("pi-trust-ext-");
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		const status = getProjectTrustStatus(cwd, makeTmp("pi-trust-agent-"));
		expect(status.requiresTrust).toBe(true);
		expect(status.trusted).toBe(false);
	});

	it("requires trust for .pi/settings.json", () => {
		const cwd = makeTmp("pi-trust-settings-");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		// settings.json is on upstream's trust-requiring resource list.
		writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
		expect(getProjectTrustStatus(cwd, makeTmp("pi-trust-agent-")).requiresTrust).toBe(true);
	});

	it("round-trips trust/deny decisions through the shared trust.json", () => {
		const cwd = makeTmp("pi-trust-roundtrip-");
		mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
		const agentDir = makeTmp("pi-trust-agent-");

		setProjectTrustDecision(cwd, true, agentDir);
		expect(getProjectTrustStatus(cwd, agentDir).trusted).toBe(true);

		setProjectTrustDecision(cwd, false, agentDir);
		expect(getProjectTrustStatus(cwd, agentDir).trusted).toBe(false);

		setProjectTrustDecision(cwd, null, agentDir);
		expect(getProjectTrustStatus(cwd, agentDir).trusted).toBe(false);

		// On-disk format is upstream's: keyed by canonicalized path.
		const data = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf-8")) as Record<
			string,
			boolean
		>;
		expect(Object.keys(data)).toHaveLength(0);
	});

	it("honors a parent-directory trust decision for nested projects", () => {
		const parent = makeTmp("pi-trust-parent-");
		const cwd = join(parent, "nested");
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		const agentDir = makeTmp("pi-trust-agent-");

		setProjectTrustDecision(parent, true, agentDir);
		expect(getProjectTrustStatus(cwd, agentDir).trusted).toBe(true);
	});
});
