/**
 * Marketplace trust + remove-source pins (audit 6 M-23 + M-24). M-23: the
 * remove IPC must carry the stored source verbatim — re-prefixing "npm:" sent
 * a bogus source upstream and the failure was swallowed. M-24: one-click
 * install from a browse surface was the wrong default for arbitrary-code
 * packages; installs go through the same trust interstitial as PackagesPanel.
 *
 * Source pins (unit tests run in node, no jsdom).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MARKETPLACE = readFileSync(
	join(import.meta.dirname, "../../src/renderer/src/pages/PackageMarketplace.tsx"),
	"utf8"
);

describe("marketplace trust interstitial (audit 6 M-24)", () => {
	it("install is gated behind the interstitial, not one click", () => {
		expect(MARKETPLACE).toContain('data-testid="marketplace-trust-interstitial"');
		expect(MARKETPLACE).toContain("Trust this package?");
		expect(MARKETPLACE).toContain("Trust & install");
		// The row's Install button only arms the interstitial…
		expect(MARKETPLACE).toContain("onClick={() => setPendingInstall(pkg.name)}");
		// …and the install IPC exists exactly once, inside confirmInstall.
		expect(MARKETPLACE.match(/packages\.install/g)?.length).toBe(1);
		const at = MARKETPLACE.indexOf("async function confirmInstall");
		expect(at).toBeGreaterThanOrEqual(0);
		expect(MARKETPLACE.slice(at, at + 700)).toContain("packages.install");
	});
});

describe("marketplace remove (audit 6 M-23)", () => {
	const at = MARKETPLACE.indexOf("async function remove");
	const body = MARKETPLACE.slice(at, at + 700);

	it("sends the stored source verbatim — never re-prefixed", () => {
		expect(at).toBeGreaterThanOrEqual(0);
		expect(body).toContain('{ type: "packages.remove", source }');
		expect(body).not.toContain("npm:${");
	});

	it("checks the result envelope instead of printing a fake success", () => {
		expect(body).toContain("if (result.ok)");
		expect(body).toContain("Remove failed:");
	});
});
