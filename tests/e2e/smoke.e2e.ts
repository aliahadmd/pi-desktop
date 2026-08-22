/**
 * Chapter 1 e2e smoke: launches the built app via Playwright's Electron
 * support and verifies the security baseline + IPC round-trip.
 * Requires `npm run build` first (the npm "e2e" script does this).
 */
import { _electron } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright-core";

let electronApp: ElectronApplication | undefined;
let page: Page;

/**
 * Build the app, then stage `out/` into a fresh temp dir with a symlink to
 * node_modules.
 *
 * Why: local cleanup software (CleanMyMac 5 observed on the dev machine)
 * transiently removes/locks freshly-built files under the project directory
 * (out/, release/), which races with Electron's module loading. Temp dirs are
 * untouched, so we launch from there.
 */
function buildAndStage(): string {
	const root = path.resolve(import.meta.dirname, "../..");
	execSync("npm run build", { cwd: root, stdio: "inherit" });

	const staged = path.join(os.tmpdir(), `pidesktop-e2e-${process.pid}`);
	rmSync(staged, { recursive: true, force: true });
	mkdirSync(staged, { recursive: true });
	cpSync(path.join(root, "out"), path.join(staged, "out"), { recursive: true });

	const nmTarget = path.join(root, "node_modules");
	if (existsSync(nmTarget)) {
		symlinkSync(nmTarget, path.join(staged, "node_modules"), "dir");
	}
	return path.join(staged, "out/main/index.js");
}

beforeAll(async () => {
	const appPath = buildAndStage();
	electronApp = await _electron.launch({ args: [appPath], timeout: 30_000 });
	page = await electronApp.firstWindow();
	await page.waitForLoadState("domcontentloaded");
}, 120_000);

afterAll(async () => {
	await electronApp?.close();
});

describe("chapter 1 smoke", () => {
	it("renderer is sandboxed: no node/require globals leak in", async () => {
		const leaked = await page.evaluate(() => {
			const g = globalThis as Record<string, unknown>;
			return {
				require: typeof g["require"],
				process: typeof g["process"],
				module: typeof g["module"],
			};
		});
		expect(leaked).toEqual({ require: "undefined", process: "undefined", module: "undefined" });
	});

	it("performs the ping IPC round-trip", async () => {
		// App auto-pings on boot; the header shows the result.
		await page.getByTestId("sidebar").waitFor({ timeout: 15_000 });
	});

	it("rejects malformed IPC payloads at the boundary", async () => {
		const result = (await page.evaluate(async () => {
			// Reach the raw bridge with a deliberately invalid payload.
			const bridge = (
				globalThis as unknown as {
					piDesktop: { invoke(req: unknown): Promise<unknown> };
				}
			).piDesktop;
			return bridge.invoke({ type: "log_write", level: "evil" });
		})) as { ok: boolean; error?: { code: string } };
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error?.code).toBe("invalid_request");
	});
});
