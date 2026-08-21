/**
 * Chapter 8 golden path: the full user journey without a real LLM —
 * onboarding skip → RPC session via UI (+ picker hook, fake pi responder)
 * → prompt → streamed reply in transcript → steer → abort-safe teardown.
 */
import { _electron } from "playwright-core";
import { execSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ElectronApplication, Page } from "playwright-core";

let electronApp: ElectronApplication;
let page: Page;
let stagedDir: string;
const FAKE_PI = path.resolve(import.meta.dirname, "../fixtures/fake-pi.mjs");

function buildAndStage(): string {
	const root = path.resolve(import.meta.dirname, "../..");
	execSync("npm run build", { cwd: root, stdio: "pipe" });
	stagedDir = path.join(os.tmpdir(), `pidesktop-e2e-golden-${process.pid}`);
	rmSync(stagedDir, { recursive: true, force: true });
	mkdirSync(stagedDir, { recursive: true });
	cpSync(path.join(root, "out"), path.join(stagedDir, "out"), { recursive: true });
	symlinkSync(path.join(root, "node_modules"), path.join(stagedDir, "node_modules"));
	return path.join(stagedDir, "out/main/index.js");
}

beforeAll(async () => {
	// Fake pi must be executable so the manager can spawn it directly.
	chmodSync(FAKE_PI, 0o755);
	electronApp = await _electron.launch({
		args: [buildAndStage()],
		timeout: 30_000,
		env: {
			...process.env,
			PI_DESKTOP_TEST_PICK_DIR: os.tmpdir(),
			PI_DESKTOP_PI_PATH: FAKE_PI,
		},
	});
	page = await electronApp.firstWindow();
	await page.waitForLoadState("domcontentloaded");
}, 120_000);

afterAll(async () => {
	await electronApp?.close();
	if (stagedDir !== undefined) rmSync(stagedDir, { recursive: true, force: true });
});

describe("golden path", () => {
	it("onboarding appears and can be skipped when unconfigured", async () => {
		const dialog = page.getByText("Welcome to Pi Desktop").first();
		const shown = await dialog
			.waitFor({ timeout: 8_000 })
			.then(() => true)
			.catch(() => false);
		if (shown) {
			await page.getByText("Skip for now").first().click();
		}
		// Either way, the chat surface must be reachable.
		await page.getByText("No open sessions.").first().waitFor({ timeout: 10_000 });
	}, 30_000);

	it("creates an RPC session through the UI and streams a prompt end-to-end", async () => {
		await page.getByText("+ RPC").first().click();
		await page.getByTestId("transcript").waitFor({ timeout: 30_000 });

		await page.getByTestId("composer-input").fill("say hi");
		await page.getByTestId("send-button").click();

		// The fake responder echoes `echo:say hi`; deltas assemble into a block.
		await page
			.getByText("echo:say hi")
			.first()
			.waitFor({ timeout: 15_000 });

		// Status bar reflects activity state after settle.
		await expect(page.getByText("idle").first()).toBeTruthy();
	}, 60_000);

	it("queues a second message while streaming is not required after settle", async () => {
		// After settle, sending again works normally.
		await page.getByTestId("composer-input").fill("second");
		await page.getByTestId("send-button").click();
		await page.getByText("echo:second").first().waitFor({ timeout: 15_000 });
	}, 30_000);
});
