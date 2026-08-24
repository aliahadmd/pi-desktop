/**
 * node-pty spawn-helper repair (src/main/pty-native.ts).
 *
 * node-pty 1.1.0 ships the macOS prebuilds with spawn-helper at mode 644
 * (microsoft/node-pty#850). Without the execute bit every terminal dies with
 * "posix_spawnp failed", which is what the user saw. These tests pin the
 * repair so a dependency bump or refactor cannot quietly reintroduce it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
	ensureSpawnHelperExecutable,
	isSpawnHelperFailure,
} from "../../src/main/pty-native";

const require = createRequire(import.meta.url);

/** The spawn-helper this platform actually loads, or null when absent. */
function helperPath(): string | null {
	let root: string;
	try {
		root = path.dirname(path.dirname(require.resolve("node-pty")));
	} catch {
		return null;
	}
	for (const dir of [
		"build/Release",
		"build/Debug",
		`prebuilds/${process.platform}-${process.arch}`,
	]) {
		const candidate = path.join(root, dir, "spawn-helper");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

const helper = helperPath();
const onPosix = process.platform !== "win32";
let originalMode: number | undefined;

beforeEach(() => {
	if (helper !== null) originalMode = statSync(helper).mode;
});

afterEach(() => {
	// Never leave the developer's checkout broken, whatever the test did.
	if (helper !== null && originalMode !== undefined) chmodSync(helper, originalMode);
});

describe.runIf(onPosix && helper !== null)("ensureSpawnHelperExecutable", () => {
	it("restores the execute bit when it is missing", () => {
		chmodSync(helper as string, 0o644);
		expect(statSync(helper as string).mode & 0o111).toBe(0);

		const result = ensureSpawnHelperExecutable();

		expect(result.repaired).toBe(true);
		expect(result.reason).toBe("repaired");
		expect(statSync(helper as string).mode & 0o111).not.toBe(0);
	});

	it("is a no-op when the bit is already present", () => {
		chmodSync(helper as string, 0o755);
		const result = ensureSpawnHelperExecutable();
		expect(result.repaired).toBe(false);
		expect(result.reason).toBe("already-executable");
	});

	it("is idempotent across repeated calls", () => {
		chmodSync(helper as string, 0o644);
		expect(ensureSpawnHelperExecutable().repaired).toBe(true);
		expect(ensureSpawnHelperExecutable().repaired).toBe(false);
		expect(ensureSpawnHelperExecutable().reason).toBe("already-executable");
	});

	it("reports the path it repaired", () => {
		chmodSync(helper as string, 0o644);
		const result = ensureSpawnHelperExecutable();
		expect(result.path).toContain("spawn-helper");
	});
});

describe("isSpawnHelperFailure", () => {
	it("recognizes the posix_spawnp failure node-pty throws", () => {
		expect(isSpawnHelperFailure(new Error("posix_spawnp failed."))).toBe(true);
		expect(isSpawnHelperFailure("posix_spawnp failed.")).toBe(true);
	});

	it("recognizes an explicit spawn-helper complaint", () => {
		expect(isSpawnHelperFailure(new Error("cannot exec spawn-helper"))).toBe(true);
	});

	it("does not swallow unrelated spawn errors", () => {
		// A retry only makes sense for the permission fault; anything else
		// must propagate so the real cause reaches the user.
		expect(isSpawnHelperFailure(new Error("ENOENT: no such file"))).toBe(false);
		expect(isSpawnHelperFailure(new Error("cwd does not exist"))).toBe(false);
	});
});
