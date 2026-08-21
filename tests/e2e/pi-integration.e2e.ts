/**
 * Chapter 2 e2e: drives a REAL pi --mode rpc subprocess through the full
 * Electron IPC stack (renderer → main → backend → pi). Uses an ephemeral
 * session (--no-session) in a temp cwd so no user data is touched, and only
 * commands that work without provider auth.
 *
 * Requires the staged app from smoke.e2e.ts's buildAndStage — we rebuild+stage
 * here independently so this file is self-contained.
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
	stagedDir = path.join(os.tmpdir(), `pidesktop-e2e-pi-${process.pid}`);
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

/** Invoke the app's IPC bridge from inside the renderer. */
async function invoke(request: Record<string, unknown>): Promise<{
	ok: boolean;
	data?: Record<string, unknown>;
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
			data?: Record<string, unknown>;
			error?: { code: string; message: string };
		};
	}, request);
}

describe("pi integration over full IPC stack (rpc backend)", () => {
	let sessionId: string;

	it("creates an ephemeral rpc session with real pi", async () => {
		const result = await invoke({
			type: "session.create",
			cwd: os.tmpdir(),
			backend: "rpc",
			noSession: true,
		});
		expect(result.ok, JSON.stringify(result.error)).toBe(true);
		const data = result.data as unknown as {
			sessionId: string;
			backend: string;
			model?: unknown;
		};
		sessionId = data.sessionId;
		expect(data.backend).toBe("rpc");
	}, 30_000);

	it("returns live state from the running pi process", async () => {
		const result = await invoke({ type: "session.state", sessionId });
		expect(result.ok, JSON.stringify(result.error)).toBe(true);
		const state = result.data as unknown as { sessionId: string; isStreaming: boolean };
		expect(state.sessionId).toBeTruthy();
		expect(state.isStreaming).toBe(false);
	}, 15_000);

	it("lists available commands without auth", async () => {
		const result = await invoke({ type: "session.commands", sessionId });
		expect(result.ok, JSON.stringify(result.error)).toBe(true);
		expect(Array.isArray((result.data as { commands: unknown[] }).commands)).toBe(true);
	}, 15_000);

	it("closes the session and terminates the subprocess", async () => {
		const result = await invoke({ type: "session.close", sessionId });
		expect(result.ok, JSON.stringify(result.error)).toBe(true);
	}, 15_000);

	it("rejects operations on unknown sessions", async () => {
		const result = await invoke({ type: "session.state", sessionId: "does-not-exist" });
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("internal_error");
	});

	describe("sdk backend (in-process)", () => {
		let sdkSessionId: string;

		it("creates an ephemeral in-process sdk session", async () => {
			const result = await invoke({
				type: "session.create",
				cwd: os.tmpdir(),
				backend: "sdk",
				noSession: true,
			});
			expect(result.ok, JSON.stringify(result.error)).toBe(true);
			const data = result.data as unknown as { sessionId: string; backend: string };
			sdkSessionId = data.sessionId;
			expect(data.backend).toBe("sdk");
		}, 60_000);

		it("returns live state from the in-process session", async () => {
			const result = await invoke({ type: "session.state", sessionId: sdkSessionId });
			expect(result.ok, JSON.stringify(result.error)).toBe(true);
			const state = result.data as unknown as {
				sessionId: string;
				isStreaming: boolean;
				autoCompactionEnabled: boolean;
			};
			expect(state.sessionId).toBeTruthy();
			expect(state.isStreaming).toBe(false);
		}, 15_000);

		it("closes cleanly", async () => {
			const result = await invoke({ type: "session.close", sessionId: sdkSessionId });
			expect(result.ok, JSON.stringify(result.error)).toBe(true);
		});
	});
});
