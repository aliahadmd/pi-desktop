/**
 * session.delete_file containment (audit 6 H-5 + audit 5 H-3): the only
 * fs-mutating IPC channel without root containment must refuse paths the
 * indexer does not know about, and must refuse to delete the file backing a
 * currently-open session (zombie tab).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	shell: { trashItem: vi.fn(async () => undefined) },
}));

import { shell } from "electron";
import { IpcRouter } from "../../src/main/ipc/router";
import type { PiService } from "../../src/main/pi/service";
import { StoreService } from "../../src/main/store/service";

const trashItem = vi.mocked(shell.trashItem);

interface OpenedHook {
	onSessionOpened(info: {
		appSessionId: string;
		piSessionId: string | undefined;
		sessionFile: string | undefined;
		cwd: string;
		backend: "sdk" | "rpc";
	}): void;
}

const tmpDirs: string[] = [];

function setup(isSessionFileOpen: (path: string) => boolean): {
	router: IpcRouter;
	hooks: OpenedHook;
} {
	const dir = mkdtempSync(join(tmpdir(), "pi-store-guard-"));
	tmpDirs.push(dir);
	const store = new StoreService(dir);
	store.start();
	const router = new IpcRouter();
	store.registerHandlers(router);
	let captured: OpenedHook | null = null;
	const piServiceStub = {
		addHooks(hooks: OpenedHook): void {
			captured = hooks;
		},
		isSessionFileOpen,
	};
	store.attachPiService(piServiceStub as unknown as PiService);
	if (captured === null) throw new Error("hooks not captured");
	const hooks: OpenedHook = captured;
	return { router, hooks };
}

afterEach(() => {
	vi.clearAllMocks();
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

describe("session.delete_file guard", () => {
	it("refuses a path the indexer does not know about", async () => {
		const { router } = setup(() => false);
		const result = await router.dispatch({
			type: "session.delete_file",
			sessionPath: "/etc/passwd",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("not an indexed session file");
		expect(trashItem).not.toHaveBeenCalled();
	});

	it("refuses to delete the file backing an open session", async () => {
		const { router, hooks } = setup(() => true);
		const dir = mkdtempSync(join(tmpdir(), "pi-store-open-"));
		tmpDirs.push(dir);
		const file = join(dir, "session.jsonl");
		writeFileSync(file, "{}\n");
		hooks.onSessionOpened({
			appSessionId: "a1",
			piSessionId: "p1",
			sessionFile: file,
			cwd: dir,
			backend: "sdk",
		});

		const result = await router.dispatch({ type: "session.delete_file", sessionPath: file });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("currently open");
		expect(trashItem).not.toHaveBeenCalled();
	});

	it("deletes an indexed, closed session file", async () => {
		const { router, hooks } = setup(() => false);
		const dir = mkdtempSync(join(tmpdir(), "pi-store-closed-"));
		tmpDirs.push(dir);
		const file = join(dir, "session.jsonl");
		writeFileSync(file, "{}\n");
		hooks.onSessionOpened({
			appSessionId: "a1",
			piSessionId: "p1",
			sessionFile: file,
			cwd: dir,
			backend: "sdk",
		});

		const result = await router.dispatch({ type: "session.delete_file", sessionPath: file });
		expect(result.ok).toBe(true);
		expect(trashItem).toHaveBeenCalledWith(file);

		const list = await router.dispatch({ type: "db.sessions.list" });
		expect(list.ok).toBe(true);
		if (list.ok) expect((list.data as { sessions: unknown[] }).sessions).toHaveLength(0);
	});
});
