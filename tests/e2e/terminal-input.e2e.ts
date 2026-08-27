/**
 * Terminal input e2e (user-reported: "cannot type into the terminal").
 *
 * Regression coverage for the three root causes found while investigating:
 *  1. The panel never took keyboard focus — opening the terminal from the top
 *     bar left focus on the button, so typed text went nowhere until the user
 *     clicked inside the terminal.
 *  2. Adding a second terminal tab started a scrollbar feedback loop on the
 *     dock body (overflow-y-auto vs xterm's fractional-pixel fit), oscillating
 *     the layout ~1px forever.
 *  3. Keystrokes typed before node-pty finished spawning were silently
 *     dropped main-side (`terms.get(id)` undefined); they are now buffered
 *     and flushed into the shell on spawn.
 */
import { _electron } from "playwright-core";
import { execSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ElectronApplication, Page } from "playwright-core";

let electronApp: ElectronApplication;
let page: Page;
let stagedDir: string;
let projectDir: string;

function buildAndStage(): string {
	const root = path.resolve(import.meta.dirname, "../..");
	execSync("npm run build", { cwd: root, stdio: "pipe" });
	stagedDir = path.join(os.tmpdir(), `pidesktop-e2e-term-${process.pid}`);
	rmSync(stagedDir, { recursive: true, force: true });
	mkdirSync(stagedDir, { recursive: true });
	cpSync(path.join(root, "out"), path.join(stagedDir, "out"), { recursive: true });
	const nmTarget = path.join(root, "node_modules");
	if (existsSync(nmTarget)) {
		symlinkSync(nmTarget, path.join(stagedDir, "node_modules"), "dir");
	}
	return path.join(stagedDir, "out/main/index.js");
}

async function typeAndExpect(marker: string, timeout = 15_000): Promise<void> {
	await page.keyboard.type(`echo ${marker}`);
	await page.keyboard.press("Enter");
	await page.waitForFunction(
		(m) =>
			[...document.querySelectorAll(".xterm-screen")]
				.map((el) => el.textContent ?? "")
				.join("\n")
				.includes(m),
		marker,
		{ timeout }
	);
}

beforeAll(async () => {
	projectDir = path.join(os.tmpdir(), `pidesktop-term-proj-${process.pid}`);
	rmSync(projectDir, { recursive: true, force: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(path.join(projectDir, "README.md"), "# terminal e2e");

	electronApp = await _electron.launch({
		args: [buildAndStage()],
		timeout: 30_000,
		env: { ...process.env, PI_DESKTOP_TEST_PICK_DIR: projectDir },
	});
	page = await electronApp.firstWindow();
	await page.waitForLoadState("domcontentloaded");

	// One SDK session for the whole file.
	await page.getByText("New SDK session…").first().click();
	await page.getByTestId("transcript").waitFor({ timeout: 30_000 });
}, 120_000);

afterAll(async () => {
	await electronApp?.close();
	if (stagedDir !== undefined) rmSync(stagedDir, { recursive: true, force: true });
	if (projectDir !== undefined) rmSync(projectDir, { recursive: true, force: true });
});

describe("terminal keyboard input", () => {
	it("accepts typed input WITHOUT clicking first (auto-focus on open)", async () => {
		await page.getByTestId("topbar-terminal").click();
		await page.locator(".xterm-screen").first().waitFor({ timeout: 20_000 });
		// Focus must be inside xterm without an explicit click.
		await page.waitForFunction(
			() =>
				document.activeElement?.classList.contains("xterm-helper-textarea") === true,
			undefined,
			{ timeout: 5_000 }
		);
		// Typed immediately — also exercises the spawn-window write buffer.
		await typeAndExpect("NOCLICK_42");
	}, 60_000);

	it("keeps a stable layout after adding a second terminal tab", async () => {
		// The tab strip's "+" is the last button in the strip.
		await page.evaluate(() => {
			const t1 = [...document.querySelectorAll("button")].find((b) =>
				b.textContent?.includes("Terminal 1")
			);
			const strip = t1?.parentElement;
			if (strip == null) throw new Error("terminal tab strip not found");
			const plus = [...strip.querySelectorAll("button")].pop();
			plus?.click();
		});
		await page.getByText("Terminal 2", { exact: true }).waitFor({ timeout: 5_000 });
		await page.waitForTimeout(1500); // beyond any mount animation

		// The visible terminal's bounding box must be constant across samples.
		const boxes: string[] = await page.evaluate(async () => {
			const el = [...document.querySelectorAll(".xterm-screen")].find(
				(e) => (e as HTMLElement).offsetParent !== null
			);
			if (el === undefined) return ["<none>"];
			const out: string[] = [];
			for (let i = 0; i < 8; i++) {
				const r = el.getBoundingClientRect();
				out.push(`${Math.round(r.width)}x${Math.round(r.height)}`);
				await new Promise((res) => setTimeout(res, 200));
			}
			return out;
		});
		expect(new Set(boxes).size).toBe(1);

		// And the second terminal accepts input too.
		await typeAndExpect("TAB2_77");
	}, 60_000);

	it("keeps accepting input after switching dock tabs away and back", async () => {
		await page.getByTestId("topbar-files").click();
		await page.waitForTimeout(300);
		await page.getByTestId("topbar-terminal").click();
		await page.waitForFunction(
			() =>
				document.activeElement?.classList.contains("xterm-helper-textarea") === true,
			undefined,
			{ timeout: 5_000 }
		);
		await typeAndExpect("BACK_99");
	}, 60_000);
});
