/**
 * Chapters 3+4 e2e: app shell tabs, chat page render, SQLite-backed sessions
 * browser and settings channels over the live IPC stack.
 */
import { _electron } from "playwright-core";
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ElectronApplication, Page } from "playwright-core";

let electronApp: ElectronApplication;
let page: Page;
let stagedDir: string;

function buildAndStage(): string {
	const root = path.resolve(import.meta.dirname, "../..");
	execSync("npm run build", { cwd: root, stdio: "pipe" });
	stagedDir = path.join(os.tmpdir(), `pidesktop-e2e-ui-${process.pid}`);
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
	electronApp = await _electron.launch({ args: [buildAndStage()], timeout: 30_000 });
	page = await electronApp.firstWindow();
	await page.waitForLoadState("domcontentloaded");
}, 120_000);

afterAll(async () => {
	await electronApp?.close();
	if (stagedDir !== undefined) rmSync(stagedDir, { recursive: true, force: true });
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

describe("app shell", () => {
	it("renders the sidebar shell and defaults to chat", async () => {
		await page.getByTestId("sidebar").waitFor({ timeout: 10_000 });
		await page.getByText("No open sessions.").first().waitFor({ timeout: 10_000 });
	});

	it("opens the sessions browser sheet from the profile menu and closes it", async () => {
		await page.getByTestId("sidebar-profile").click();
		await page.getByTestId("sidebar-profile-menu").waitFor({ timeout: 10_000 });
		await page.getByTestId("sidebar-history").click();
		await page.getByTestId("sheet-browse").waitFor({ timeout: 10_000 });
		await page.getByText("Usage (14 days)").first().waitFor({ timeout: 10_000 });
		await page.getByText("Close · Esc").first().click();
		await page.getByText("No open sessions.").first().waitFor({ timeout: 10_000 });
	});
});

describe("store channels over IPC", () => {
	it("round-trips app settings", async () => {
		const set = await invoke({
			type: "app.settings.set",
			key: "e2e.probe",
			value: JSON.stringify({ hello: "world" }),
		});
		expect(set.ok).toBe(true);
		const get = await invoke({ type: "app.settings.get", key: "e2e.probe" });
		expect(get.ok).toBe(true);
		expect(get.data).toEqual({ hello: "world" });
	});

	it("runs the indexer without error", async () => {
		const result = await invoke({ type: "db.indexer.refresh" });
		expect(result.ok).toBe(true);
		expect(typeof (result.data as { indexed: number }).indexed).toBe("number");
	});

	it("lists indexed sessions (array shape)", async () => {
		const result = await invoke({ type: "db.sessions.list" });
		expect(result.ok).toBe(true);
		expect(Array.isArray((result.data as { sessions: unknown[] }).sessions)).toBe(true);
	});

	it("returns usage totals", async () => {
		const result = await invoke({ type: "db.usage.totals" });
		expect(result.ok).toBe(true);
		expect(typeof (result.data as { totalCost: number }).totalCost).toBe("number");
	});
});
