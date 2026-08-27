/**
 * Onboarding provider-detection failure (audit 6 M-26): a keychain-locked or
 * otherwise errored detection used to masquerade as "nothing configured" —
 * or worse, loop the welcome modal forever. Source pins on the App side
 * (error state + routing) and the Onboarding side (banner + load failure).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = readFileSync(
	join(import.meta.dirname, "../../src/renderer/src/App.tsx"),
	"utf8"
);
const ONBOARDING = readFileSync(
	join(import.meta.dirname, "../../src/renderer/src/pages/Onboarding.tsx"),
	"utf8"
);

describe("onboarding detection error (audit 6 M-26)", () => {
	it("App surfaces a failed auth.providers call into onboarding", () => {
		expect(APP).toContain("setOnboardingError(r.error.message)");
	});

	it("App distinguishes all-providers-errored from nothing-configured", () => {
		expect(APP).toContain("errors.length === providers.length");
		expect(APP).toContain("setOnboardingError(errors[0]");
	});

	it("App passes the error through to the Onboarding sheet", () => {
		expect(APP).toContain("{ detectionError: onboardingError }");
	});

	it("Onboarding renders the detection-error banner", () => {
		expect(ONBOARDING).toContain("detectionError?: string");
		expect(ONBOARDING).toContain('data-testid="onboarding-detection-error"');
	});

	it("Onboarding's own provider load surfaces failure instead of an empty list", () => {
		expect(ONBOARDING).toContain("Could not load providers:");
	});
});
