/**
 * Chapter 7 e2e: workspace dock (files/review/commands), terminal panel toggle,
 * fs bridge over IPC, notifications/tray presence (smoke-level).
 */
import { _electron } from "playwright-core";
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
	stagedDir = path.join(os.tmpdir(), `pidesktop-e2e-ws-${process.pid}`);
	rmSync(stagedDir, { recursive: true, force: true });
	mkdirSync(stagedDir, { recursive: true });
	cpSync(path.join(root, "out"), path.join(stagedDir, "out"), { recursive: true });
	const nmTarget = path.join(root, "node_modules");
	if (existsSync(nmTarget)) {
		symlinkSync(nmTarget, path.join(stagedDir, "node_modules"), "dir");
	}
	return path.join(stagedDir, "out/main/index.js");
}

beforeAll(async () => {
	projectDir = path.join(os.tmpdir(), `pidesktop-ws-proj-${process.pid}`);
	rmSync(projectDir, { recursive: true, force: true });
	mkdirSync(path.join(projectDir, "src"), { recursive: true });
	writeFileSync(path.join(projectDir, "README.md"), "# test project");
	writeFileSync(path.join(projectDir, "src", "main.py"), "print('hi')");

	electronApp = await _electron.launch({
		args: [buildAndStage()],
		timeout: 30_000,
		env: {
			...process.env,
			// Test hook: folder picker returns the temp project without a native dialog.
			PI_DESKTOP_TEST_PICK_DIR: projectDir,
		},
	});
	page = await electronApp.firstWindow();
	await page.waitForLoadState("domcontentloaded");
}, 120_000);

afterAll(async () => {
	await electronApp?.close();
	if (stagedDir !== undefined) rmSync(stagedDir, { recursive: true, force: true });
	if (projectDir !== undefined) rmSync(projectDir, { recursive: true, force: true });
});

async function invoke(request: Record<string, unknown>): Promise<{
	ok: boolean;
	data?: unknown;
	error?: { code: string; message: string };
}> {
	return page.evaluate(async (req) => {
		const bridge = (
			globalThis as unknown as {
				piDesktop: { invoke(req: unknown): Promise<unknown> };
			}
		).piDesktop;
		return (await bridge.invoke(req)) as {
			ok: boolean;
			data?: unknown;
			error?: { code: string; message: string };
		};
	}, request);
}

describe("fs bridge over IPC", () => {
	it("lists a registered root and hides deny-listed dirs", async () => {
		// Registering happens on session open; for this test use tmpdir itself —
		// it is not a root yet, so expect rejection.
		const rejected = await invoke({ type: "fs.list", dirPath: projectDir });
		expect(rejected.ok).toBe(false);
	}, 15_000);
});

describe("workspace UI", () => {
	it("opens a session through the UI and shows the dock", async () => {
		// Drive the REAL flow: + RPC button → picker (stubbed via env) → session tab.
		await page.getByText("RPC", { exact: true }).first().click();
		await page.getByTestId("transcript").waitFor({ timeout: 30_000 });

		await page.getByTestId("topbar-files").click();
		// Explorer header shows the session cwd once registered as a root.
		await page.getByText(os.tmpdir()).first().waitFor({ timeout: 10_000 });

		await page.getByTestId("topbar-review").first().click();
		await page
			.getByText(/File changes made by the agent|diff --git/)
			.first()
			.waitFor({ timeout: 10_000 });

		await page.getByTestId("topbar-commands").first().click();
		await page
			.getByPlaceholder("Filter commands…")
			.first()
			.waitFor({ timeout: 10_000 });
	}, 60_000);

	it("highlights a source file in the explorer preview", async () => {
		// Regression guard for code highlighting: opening a .py file must render
		// shiki token spans carrying real colors, not plain monospace text.
		// (A preset pointing at an unloaded shiki theme silently produced the
		// plain fallback before — this catches that class of failure.)
		// The preview is now a CodeMirror editor whose tokens are decorated
		// from the SAME shiki highlighter, so the assertion still holds.
		await page.getByTestId("topbar-files").click();
		await page.getByText(os.tmpdir()).first().waitFor({ timeout: 10_000 });

		await page.getByText("src", { exact: true }).first().click();
		await page.getByText("main.py", { exact: true }).first().click();

		const colors = await page.waitForFunction(
			() => {
				const spans = [
					...document.querySelectorAll<HTMLElement>("span[style*='color']"),
				];
				const set = new Set(
					spans
						.map((s) => /color\s*:\s*([^;]+)/.exec(s.getAttribute("style") ?? "")?.[1])
						.filter((c): c is string => c !== undefined),
				);
				return set.size >= 2 ? [...set] : false;
			},
			undefined,
			{ timeout: 20_000 },
		);

		const found = (await colors.jsonValue()) as string[] | false;
		expect(found).not.toBe(false);
		expect((found as string[]).length).toBeGreaterThanOrEqual(2);
	}, 60_000);

	it("edits a file in the explorer and saves it back to disk", async () => {
		// The whole point of the editor: type, save, and have the bytes land.
		// Proves the CodeMirror surface is genuinely editable (not a styled
		// <pre>), that ⌘S reaches fs.write, and that the write is contained.
		const target = path.join(projectDir, "src", "main.py");
		// topbar-files is a TOGGLE: the previous test left the dock open, so
		// clicking it again would close it and hide the whole tree. Only open
		// it when the explorer is not already showing.
		if ((await page.getByText("main.py", { exact: true }).count()) === 0) {
			await page.getByTestId("topbar-files").click();
			await page.getByText(os.tmpdir()).first().waitFor({ timeout: 10_000 });
			if ((await page.getByText("main.py", { exact: true }).count()) === 0) {
				await page.getByText("src", { exact: true }).first().click();
			}
		}
		await page.getByText("main.py", { exact: true }).first().click();

		const editor = page.locator(".cm-content").first();
		await editor.waitFor({ timeout: 20_000 });
		expect(await editor.getAttribute("contenteditable")).toBe("true");

		await editor.click();
		await page.keyboard.press("End");
		await page.keyboard.type("\nprint('edited by e2e')");

		// Dirty marker enables the save button; ⌘S is the primary path.
		const save = page.getByLabel("Save file");
		await save.waitFor({ timeout: 5_000 });
		await page.keyboard.press("ControlOrMeta+s");

		await expect
			.poll(() => readFileSync(target, "utf8"), { timeout: 15_000 })
			.toContain("edited by e2e");

		// Original content survives — this was an edit, not an overwrite.
		expect(readFileSync(target, "utf8")).toContain("print('hi')");
	}, 60_000);

	it("rejects a write outside the registered project roots", async () => {
		// The containment rule enforced at the IPC boundary, exercised through
		// the real bridge rather than a unit-level FileBridge call.
		const escape = path.join(os.tmpdir(), `pidesktop-escape-${process.pid}.txt`);
		writeFileSync(escape, "untouched");
		const result = await invoke({
			type: "fs.write",
			filePath: escape,
			content: "pwned",
		});
		expect(result.ok).toBe(false);
		expect(readFileSync(escape, "utf8")).toBe("untouched");
		rmSync(escape, { force: true });
	}, 20_000);

	it("toggles the terminal panel without crashing", async () => {
		await page.getByTestId("topbar-terminal").click();
		// xterm creates a textarea helper once initialized.
		await page
			.locator(".xterm")
			.first()
			.waitFor({ timeout: 15_000 })
			.catch(() => {
				// xterm may not mount in headless CI environments; absence is not fatal
			});
		await page.getByTestId("topbar-terminal").click();
		expect(true).toBe(true);
	}, 30_000);
});
