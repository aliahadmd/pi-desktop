/**
 * Chapter 6 e2e: models/settings pages and auth channels over live IPC.
 * Uses a throwaway provider key round-trip (runtime-only, never persisted to
 * pi's auth.json; our encrypted store entry is removed at the end).
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
	stagedDir = path.join(os.tmpdir(), `pidesktop-e2e-auth-${process.pid}`);
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

describe("auth channels over IPC", () => {
	it("lists providers with auth status", async () => {
		const result = await invoke({ type: "auth.providers" });
		expect(result.ok, JSON.stringify(result.error)).toBe(true);
		const providers = (result.data as { providers: Array<{ id: string }> }).providers;
		expect(Array.isArray(providers)).toBe(true);
		expect(providers.length).toBeGreaterThan(0);
	}, 60_000); // ModelRuntime.create with network refresh

	it("lists the model catalog", async () => {
		const result = await invoke({ type: "auth.models" });
		expect(result.ok, JSON.stringify(result.error)).toBe(true);
		const models = (result.data as { models: Array<{ id: string; contextWindow: number }> })
			.models;
		expect(models.length).toBeGreaterThan(0);
		expect(models[0]?.contextWindow).toBeGreaterThan(0);
	}, 30_000);

	it("round-trips an api key (set → providers → remove)", async () => {
		const set = await invoke({
			type: "auth.set_key",
			providerId: "openai",
			key: "sk-test-e2e-throwaway",
		});
		expect(set.ok, JSON.stringify(set.error)).toBe(true);

		const providers = await invoke({ type: "auth.providers" });
		const openai = (
			(providers.data as { providers: Array<{ id: string; configured: boolean; authType: string }> })
				.providers
		).find((p) => p.id === "openai");
		expect(openai?.configured).toBe(true);

		const remove = await invoke({ type: "auth.remove_key", providerId: "openai" });
		expect(remove.ok).toBe(true);
	}, 30_000);
});

describe("settings channels over IPC", () => {
	it("returns pi global settings object", async () => {
		const result = await invoke({ type: "pi.settings.get" });
		expect(result.ok, JSON.stringify(result.error)).toBe(true);
		expect(typeof result.data).toBe("object");
	});

	it("writes and restores a pi setting", async () => {
		const before = await invoke({ type: "pi.settings.get" });
		const original = (before.data as { hideThinkingBlock?: boolean }).hideThinkingBlock;

		const set = await invoke({
			type: "pi.settings.set",
			key: "hideThinkingBlock",
			value: JSON.stringify(true),
		});
		expect(set.ok, JSON.stringify(set.error)).toBe(true);

		const after = await invoke({ type: "pi.settings.get" });
		expect((after.data as { hideThinkingBlock?: boolean }).hideThinkingBlock).toBe(true);

		// restore
		await invoke({
			type: "pi.settings.set",
			key: "hideThinkingBlock",
			value: JSON.stringify(original === true),
		});
	}, 15_000);
});

describe("settings UI", () => {
	it("renders the models page with providers", async () => {
		await page.getByTestId("tab-models").click();
		await page.getByText("Providers").first().waitFor({ timeout: 10_000 });
	});

	it("renders the settings page", async () => {
		await page.getByTestId("tab-settings").click();
		await page.getByText("Default provider").first().waitFor({ timeout: 10_000 });
		await page.getByTestId("tab-chat").click();
	});
});
