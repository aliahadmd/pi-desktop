/**
 * Silent-write class (audit 6 L-1): explicit user writes must surface failure
 * instead of resolving ok:true over a swallowed error.
 *
 *  - app.settings.set: invalid JSON / unopened store used to be guard()-swallowed
 *  - session.delete_file: the DB-row removal after a successful trash was guarded
 *  - window bounds on ⌘Q: the "close" handler wrote after store.stop() closed
 *    the DB — before-quit now snapshots bounds while both are alive
 *    (source-level pin, same approach as pty-dispose-on-close.test.ts)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	shell: { trashItem: vi.fn(async () => undefined) },
}));

import { IpcRouter } from "../../src/main/ipc/router";
import { StoreService } from "../../src/main/store/service";

const INDEX_TS = readFileSync(join(import.meta.dirname, "../../src/main/index.ts"), "utf8");

const tmpDirs: string[] = [];

function makeStore(): { store: StoreService; router: IpcRouter } {
	const dir = mkdtempSync(join(tmpdir(), "pi-silent-writes-"));
	tmpDirs.push(dir);
	const store = new StoreService(dir);
	store.start();
	const router = new IpcRouter();
	store.registerHandlers(router);
	return { store, router };
}

afterEach(() => {
	vi.clearAllMocks();
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

describe("app.settings.set (audit 6 L-1)", () => {
	it("persists a valid write and reads it back", async () => {
		const { router } = makeStore();
		const set = await router.dispatch({
			type: "app.settings.set",
			key: "theme",
			value: JSON.stringify("pi-light"),
		});
		expect(set.ok).toBe(true);
		const get = await router.dispatch({ type: "app.settings.get", key: "theme" });
		expect(get.ok && get.data).toBe("pi-light");
	});

	it("fails the envelope on invalid JSON instead of resolving ok:true", async () => {
		const { router } = makeStore();
		const result = await router.dispatch({
			type: "app.settings.set",
			key: "theme",
			value: "{not json",
		});
		expect(result.ok).toBe(false);
	});

	it("fails the envelope when the store never opened", async () => {
		// A path that is a FILE: openDatabase cannot create pidesktop.db inside it.
		const dir = mkdtempSync(join(tmpdir(), "pi-silent-blocked-"));
		tmpDirs.push(dir);
		const file = join(dir, "not-a-dir");
		writeFileSync(file, "x");
		const store = new StoreService(join(file, "impossible"));
		store.start(); // open fails internally; settings stays null
		const router = new IpcRouter();
		store.registerHandlers(router);

		const result = await router.dispatch({
			type: "app.settings.set",
			key: "theme",
			value: JSON.stringify("pi-dark"),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("store not ready");
	});

	it("setSettingRaw throws instead of no-op when the store is not ready", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-silent-raw-"));
		tmpDirs.push(dir);
		const store = new StoreService(dir);
		// Never start(): settings is null.
		expect(() => store.setSettingRaw("k", "v")).toThrow(/store not ready/);
	});
});

describe("session.delete_file (audit 6 L-1)", () => {
	it("propagates a failed index-row removal instead of resolving ok:true", async () => {
		const { store, router } = makeStore();
		const dir = mkdtempSync(join(tmpdir(), "pi-silent-delete-"));
		tmpDirs.push(dir);
		const file = join(dir, "session.jsonl");
		writeFileSync(file, "{}\n");
		// Register the file in the index via the store's own repo.
		store["sessions"]?.upsert({ id: "s1", file_path: file });
		// Force the post-trash row removal to fail (closed/broken DB shape).
		store["sessions"]!.removeByFilePath = () => {
			throw new Error("db gone");
		};

		const result = await router.dispatch({ type: "session.delete_file", sessionPath: file });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("db gone");
	});
});

describe("window bounds on quit (audit 6 L-1)", () => {
	it("before-quit snapshots bounds before store.stop() closes the DB", () => {
		const beforeQuit = INDEX_TS.match(/app\.on\("before-quit"[\s\S]*?\n\}\);/);
		expect(beforeQuit).not.toBeNull();
		const body = beforeQuit?.[0] ?? "";
		const snapshotAt = body.indexOf("setWindowState(win.getBounds())");
		const stopAt = body.indexOf("closingStore?.stop()");
		expect(snapshotAt).toBeGreaterThanOrEqual(0);
		expect(stopAt).toBeGreaterThan(snapshotAt);
	});
});

describe("Settings page reload merge (audit 6 L-1)", () => {
	// A save-triggered load() used to replace the whole settings object,
	// clobbering an in-progress edit in a sibling field. Source pins (same
	// approach as sheet-focus.test.ts): dirty keys survive the reload.
	const SETTINGS_PAGE = readFileSync(
		join(import.meta.dirname, "../../src/renderer/src/pages/SettingsPage.tsx"),
		"utf8",
	);

	it("tracks uncommitted edits and merges reloads around them", () => {
		expect(SETTINGS_PAGE).toContain("dirtyKeys");
		// The reload merges instead of replacing.
		expect(SETTINGS_PAGE).toMatch(/setSettings\(\(prev\) => \{/);
		// Text inputs mark their key dirty on change.
		expect(SETTINGS_PAGE).toContain('onDirtyKey("defaultProvider")');
		expect(SETTINGS_PAGE).toContain('onDirtyKey("defaultModel")');
		// A successful save commits the key (stops being dirty).
		expect(SETTINGS_PAGE).toContain("dirtyKeys.current.delete(key)");
	});
});
