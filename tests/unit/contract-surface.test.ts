/**
 * Dead/stale contract surface (audit 6 L-3):
 *
 *  - IpcEvent.log was defined but never produced or consumed — deleted.
 *  - ping had no caller anywhere — it is now the boot handshake in main.tsx
 *    (verifies the invoke path and logs main/electron versions).
 *  - packages.search's optional query was accepted and explicitly discarded —
 *    it now narrows the npm search (behavioral test with npm exec mocked).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PROTOCOL_TS = readFileSync(join(import.meta.dirname, "../../src/shared/protocol.ts"), "utf8");
const MAIN_TSX = readFileSync(
	join(import.meta.dirname, "../../src/renderer/src/main.tsx"),
	"utf8",
);

// --- packages.search behavioral half ----------------------------------------

interface ExecCall {
	file: string;
	args: string[];
}
const execCalls: ExecCall[] = [];

vi.mock("electron", () => ({
	safeStorage: {
		isEncryptionAvailable: () => true,
		encryptString: (s: string) => Buffer.from(s),
		decryptString: (b: Buffer) => b.toString(),
	},
}));

vi.mock("node:child_process", () => ({
	execFile: (file: string, args: string[], _options: unknown, callback: unknown) => {
		execCalls.push({ file, args });
		const cb = callback as (err: null, result: { stdout: string; stderr: string }) => void;
		cb(null, { stdout: "[]", stderr: "" });
	},
}));

import { AuthService } from "../../src/main/pi/auth";
import { IpcRouter } from "../../src/main/ipc/router";

function makeAuth(): IpcRouter {
	const auth = new AuthService({
		bus: { send: () => {} } as never,
		getStored: () => null,
		setStored: () => {},
		log: () => {},
		onScopedModelsChanged: () => {},
	});
	const router = new IpcRouter();
	auth.registerHandlers(router);
	return router;
}

beforeEach(() => {
	execCalls.length = 0;
});

describe("IpcEvent.log removal (audit 6 L-3)", () => {
	it("the dead main→renderer log event is gone from the contract", () => {
		// log_write (renderer→main request) stays; the dead EVENT was "log".
		expect(PROTOCOL_TS).not.toContain('Type.Literal("log")');
		expect(PROTOCOL_TS).not.toContain("RendererLogEvent");
	});
});

describe("ping is wired (audit 6 L-3)", () => {
	it("the renderer pings main at boot as an invoke-path handshake", () => {
		expect(MAIN_TSX).toContain('{ type: "ping" }');
	});
});

describe("packages.search honors its query (audit 6 L-3)", () => {
	it("passes a non-empty query to npm as an extra search term", async () => {
		const router = makeAuth();
		const result = await router.dispatch({ type: "packages.search", query: "lint" });
		expect(result.ok).toBe(true);
		expect(execCalls).toHaveLength(1);
		expect(execCalls[0]!.file).toBe("npm");
		expect(execCalls[0]!.args).toEqual(["search", "pi-package", "lint", "--json"]);
	});

	it("omits the term when no query is given (marketplace filters client-side)", async () => {
		const router = makeAuth();
		const result = await router.dispatch({ type: "packages.search" });
		expect(result.ok).toBe(true);
		expect(execCalls[0]!.args).toEqual(["search", "pi-package", "--json"]);
	});

	it("treats a whitespace-only query as absent", async () => {
		const router = makeAuth();
		await router.dispatch({ type: "packages.search", query: "   " });
		expect(execCalls[0]!.args).toEqual(["search", "pi-package", "--json"]);
	});
});
