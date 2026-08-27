/**
 * Audit 6 H-4: the RPC backend must resolve the bundled pi CLI against the
 * packaged-aware app root, not process.cwd() (the launch directory — "/" from
 * Finder in packaged builds). The resolution root is injectable so tests
 * exercise the default code path against a staged temp layout.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appRoot } from "../../src/main/pi/app-root";
import { RpcPiBackend } from "../../src/main/pi/rpc-backend";

const FAKE_PI = path.join(import.meta.dirname, "../fixtures/fake-pi.mjs");
const CLI_REL = "node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

let tmp: string | undefined;
let backend: RpcPiBackend | undefined;

afterEach(async () => {
	await backend?.dispose().catch(() => {});
	backend = undefined;
	if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
	tmp = undefined;
});

/** Stage a fake "app root" with the bundled CLI path populated. */
function stageAppRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-desktop-launch-"));
	const cliTarget = path.join(root, CLI_REL);
	mkdirSync(path.dirname(cliTarget), { recursive: true });
	copyFileSync(FAKE_PI, cliTarget);
	return root;
}

describe("RPC CLI resolution (audit 6 H-4)", () => {
	it("appRoot() falls back to process.cwd() when Electron's app API is absent", () => {
		// Under vitest (plain node) require("electron") yields a binary-path
		// string without .app — the documented test fallback.
		expect(appRoot()).toBe(process.cwd());
	});

	it("spawns the bundled CLI from the injected app root via the default path", async () => {
		delete process.env.PI_DESKTOP_PI_PATH; // the env override would win
		tmp = stageAppRoot();
		const b = RpcPiBackend.create(
			{ cwd: "/tmp", onEvent: () => {}, onDied: () => {} },
			// No `command` override: exercise the real default resolution, which
			// must find <appRoot>/node_modules/.../cli.js and run it with the
			// current runtime (plain node here, Electron run-as-node in the app).
			{ appRoot: tmp }
		);
		backend = b;
		await b.start();
		const state = await b.getState();
		expect(state.sessionId).toBe("fake-session");
	});

	it("fails with a helpful error when the CLI is missing from every candidate root", async () => {
		delete process.env.PI_DESKTOP_PI_PATH;
		tmp = mkdtempSync(path.join(tmpdir(), "pi-desktop-launch-empty-"));
		// resolveLaunch falls back to process.cwd() for stripped harness copies;
		// point it at the empty root too so the "missing everywhere" error path
		// is what this test exercises.
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
		try {
			const b = RpcPiBackend.create(
				{ cwd: "/tmp", onEvent: () => {}, onDied: () => {} },
				{ appRoot: tmp }
			);
			backend = b;
			await expect(b.start()).rejects.toThrow(/pi CLI not found/);
		} finally {
			cwdSpy.mockRestore();
		}
	});
});
