/**
 * Session cwd resolution (audit M-4). Pi's session-directory encoding is lossy,
 * so resuming must prefer a real source over decoding the path.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IPiBackend } from "../../src/main/pi/backend";
import type { RendererEventBus } from "../../src/main/ipc/events";
import { IpcRouter } from "../../src/main/ipc/router";
import {
	deriveCwdFromSessionPath,
	PiService,
	readSessionHeaderCwd,
	resolveResumeCwd,
} from "../../src/main/pi/service";

const FAKE = "/home/x/.pi/agent/sessions/--Users-me-my-app--/s.jsonl";

describe("resolveResumeCwd", () => {
	it("prefers the caller-supplied cwd", () => {
		expect(resolveResumeCwd(FAKE, "/real/my-app", () => "/from-header")).toBe("/real/my-app");
	});

	it("falls back to the session header cwd", () => {
		expect(resolveResumeCwd(FAKE, undefined, () => "/from-header")).toBe("/from-header");
	});

	it("falls back to path derivation when neither is available", () => {
		expect(resolveResumeCwd(FAKE, undefined, () => undefined)).toBe("/Users/me/my/app");
	});

	it("ignores an empty supplied cwd", () => {
		expect(resolveResumeCwd(FAKE, "", () => "/from-header")).toBe("/from-header");
	});
});

describe("readSessionHeaderCwd", () => {
	it("reads cwd from a real session header", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cwd-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			JSON.stringify({
				type: "session",
				version: 1,
				id: "s1",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp/my-app",
			}) + "\n{\"type\":\"message\"}\n"
		);
		expect(readSessionHeaderCwd(file)).toBe("/tmp/my-app");
	});

	it("returns undefined for a malformed header", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cwd-"));
		const file = join(dir, "bad.jsonl");
		writeFileSync(file, "not json\n");
		expect(readSessionHeaderCwd(file)).toBeUndefined();
	});

	it("returns undefined for a missing file", () => {
		expect(readSessionHeaderCwd("/no/such/file.jsonl")).toBeUndefined();
	});
});

describe("deriveCwdFromSessionPath", () => {
	// NOTE: this asserts the WRONG answer on purpose. Pi encodes cwd with
	// `replace(/[/\\:]/g, "-")`, which is not invertible — a hyphen inside a path
	// segment is indistinguishable from a separator. The test pins why derivation
	// must stay the last resort. Do not "fix" it.
	it("is lossy for hyphenated directory names (documented, not a bug to fix)", () => {
		expect(deriveCwdFromSessionPath(FAKE)).toBe("/Users/me/my/app");
	});
});

/**
 * Plan 009 (audit H-2): switching a session used to swap the transcript while
 * every cwd-scoped system kept pointing at the previous project.
 */
describe("session.switch refreshes the registry cwd", () => {
	function writeSessionFile(cwd: string): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-switch-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			JSON.stringify({
				type: "session",
				version: 1,
				id: "s-b",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd,
			}) + "\n"
		);
		return file;
	}

	it("re-points getSessionCwd at the switched-to project", async () => {
		const projectB = join(tmpdir(), "project-b");
		const sessionFile = writeSessionFile(projectB);

		const fakeBus = { send: () => {} } as unknown as RendererEventBus;
		const stubBackend = {
			kind: "sdk" as const,
			switchSession: async () => ({ cancelled: false }),
			getState: async () => ({ sessionId: "s-b", sessionFile }),
			getSessionFile: () => sessionFile,
		} as unknown as IPiBackend;

		const service = new PiService(fakeBus);
		(
			service as unknown as {
				sessions: Map<string, { id: string; cwd: string; backend: IPiBackend }>;
			}
		).sessions.set("s1", { id: "s1", cwd: "/tmp/project-a", backend: stubBackend });

		expect(service.getSessionCwd("s1")).toBe("/tmp/project-a");

		const router = new IpcRouter();
		service.registerHandlers(router);
		await router.dispatch({ type: "session.switch", sessionId: "s1", sessionPath: sessionFile });

		// Header cwd of the target session wins over the boot-time snapshot.
		expect(service.getSessionCwd("s1")).toBe(projectB);
	});

	it("reports the refreshed cwd to onSessionOpened observers", async () => {
		const projectB = join(tmpdir(), "project-b-observed");
		const sessionFile = writeSessionFile(projectB);

		const seen: { cwd: string }[] = [];
		const fakeBus = { send: () => {} } as unknown as RendererEventBus;
		const stubBackend = {
			kind: "sdk" as const,
			switchSession: async () => ({ cancelled: false }),
			getState: async () => ({ sessionId: "s-b", sessionFile }),
			getSessionFile: () => sessionFile,
		} as unknown as IPiBackend;

		const service = new PiService(fakeBus, {
			onSessionOpened: (info) => {
				seen.push({ cwd: info.cwd });
			},
		});
		(
			service as unknown as {
				sessions: Map<string, { id: string; cwd: string; backend: IPiBackend }>;
			}
		).sessions.set("s1", { id: "s1", cwd: "/tmp/project-a", backend: stubBackend });

		const router = new IpcRouter();
		service.registerHandlers(router);
		await router.dispatch({ type: "session.switch", sessionId: "s1", sessionPath: sessionFile });

		// Observers re-scope roots/explorer from this value — it must not be stale.
		expect(seen.at(-1)?.cwd).toBe(projectB);
	});
});
