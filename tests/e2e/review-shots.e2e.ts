/**
 * Phase-3 UX review driver: walks the real app (real sessions/config) and
 * captures screenshots of every surface for design review.
 */
import { _electron } from "playwright-core";
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import type { ElectronApplication, Page } from "playwright-core";

let electronApp: ElectronApplication;
let page: Page;
let stagedDir: string;
const SHOTS = "/tmp/pireview";

async function shot(name: string): Promise<void> {
	await page.waitForTimeout(600);
	await page.screenshot({ path: `${SHOTS}/${name}.png` });
	console.log(`shot: ${name}`);
}

beforeAll(async () => {
	execSync(`rm -rf ${SHOTS} && mkdir -p ${SHOTS}`, { shell: "/bin/bash" });
	const root = path.resolve(import.meta.dirname, "../..");
	execSync("npm run build", { cwd: root, stdio: "pipe" });
	stagedDir = path.join(os.tmpdir(), `pidesktop-review-${process.pid}`);
	rmSync(stagedDir, { recursive: true, force: true });
	mkdirSync(stagedDir, { recursive: true });
	cpSync(path.join(root, "out"), path.join(stagedDir, "out"), { recursive: true });
	symlinkSync(path.join(root, "node_modules"), path.join(stagedDir, "node_modules"));
	electronApp = await _electron.launch({
		args: [path.join(stagedDir, "out/main/index.js")],
		timeout: 30_000,
	});
	page = await electronApp.firstWindow();
	await page.setViewportSize?.({ width: 1440, height: 900 } as never);
	await page.waitForLoadState("domcontentloaded");
	await page.waitForTimeout(4000);
}, 60_000);

afterAll(async () => {
	await electronApp?.close();
});

test("01 initial shell", async () => {
	await shot("01-initial-shell");
});

test("02 dismiss onboarding", async () => {
	const skip = page.getByText("Skip for now").first();
	if (await skip.isVisible().catch(() => false)) {
		await skip.click();
		await page.waitForTimeout(400);
	}
	await shot("02-after-skip");
});

test("03 open most recent session", async () => {
	const row = page.locator('[data-testid^="sidebar-session-"]').first();
	if (await row.isVisible().catch(() => false)) {
		await row.click();
		await page.waitForTimeout(5000);
	}
	await shot("03-session-history");
});

test("04 files dock", async () => {
	const files = page.getByText("Files", { exact: true }).first();
	if (await files.isVisible().catch(() => false)) {
		await files.click();
		await page.waitForTimeout(1500);
	}
	await shot("04-files-dock");
});

test("05 commands dock", async () => {
	const cmds = page.getByText("Commands", { exact: true }).first();
	if (await cmds.isVisible().catch(() => false)) {
		await cmds.click();
		await page.waitForTimeout(1200);
	}
	await shot("05-commands-dock");
});

test("06 terminal", async () => {
	const t = page.getByTestId("toggle-terminal");
	if (await t.isVisible().catch(() => false)) {
		await t.click();
		await page.waitForTimeout(2500);
	}
	await shot("06-terminal");
});

test("07 models sheet", async () => {
	const m = page.getByTestId("sidebar-models");
	if (await m.isVisible().catch(() => false)) {
		await m.click();
		await page.waitForTimeout(3000);
	}
	await shot("07-models-sheet");
	const close = page.getByText("Close · Esc").first();
	if (await close.isVisible().catch(() => false)) await close.click();
	await page.waitForTimeout(400);
});

test("08 settings sheet", async () => {
	const st = page.getByTestId("sidebar-settings");
	if (await st.isVisible().catch(() => false)) {
		await st.click();
		await page.waitForTimeout(1200);
	}
	await shot("08-settings-sheet");
	const close = page.getByText("Close · Esc").first();
	if (await close.isVisible().catch(() => false)) await close.click();
	await page.waitForTimeout(400);
});

test("09 history sheet", async () => {
	const h = page.getByTestId("sidebar-history");
	if (await h.isVisible().catch(() => false)) {
		await h.click();
		await page.waitForTimeout(1500);
	}
	await shot("09-history-sheet");
	const close = page.getByText("Close · Esc").first();
	if (await close.isVisible().catch(() => false)) await close.click();
	await page.waitForTimeout(400);
});
