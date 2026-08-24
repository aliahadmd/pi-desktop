/**
 * node-pty native binary repair.
 *
 * node-pty 1.1.0 publishes the macOS prebuilds with `spawn-helper` at mode
 * 644 — no execute bit (microsoft/node-pty#850, fixed upstream only in the
 * 1.2.0 betas). node-pty spawns that helper to launch the shell, so every
 * terminal dies with the opaque message "posix_spawnp failed."
 *
 * It surfaces whenever node-pty is used straight from `prebuilds/` rather than
 * a locally compiled `build/Release`: a fresh `npm install`, a packaged app
 * (electron-builder copies node_modules verbatim and `npmRebuild` is off), or
 * any install where electron-rebuild has not run. `scripts/setup-native.sh`
 * masked it by rebuilding from source, which is why it only shows up on
 * machines that never ran that script — including every end user's.
 *
 * Rather than making the terminal depend on a build toolchain, the app repairs
 * the bit itself at runtime: chmod 755 on a binary already shipped inside our
 * own node_modules, which is strictly less privilege than compiling it.
 */
import { chmodSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Mirrors node-pty's own lookup order in lib/utils.js `loadNativeModule`. */
const NATIVE_DIRS = [
	"build/Release",
	"build/Debug",
	`prebuilds/${process.platform}-${process.arch}`,
];

export interface SpawnHelperRepair {
	/** Path that was inspected, when one was found. */
	path?: string;
	/** True when this call added the execute bit. */
	repaired: boolean;
	/** Why no repair happened (already fine, not found, not applicable). */
	reason: "repaired" | "already-executable" | "not-found" | "not-posix" | "failed";
	error?: string;
}

/** Locate node-pty's package root without hardcoding a relative path. */
function resolveNodePtyRoot(): string | null {
	try {
		// import.meta.url works in the ESM bundle electron-vite emits for main.
		const require = createRequire(import.meta.url);
		// node-pty's main is lib/index.js → package root is two levels up.
		return path.dirname(path.dirname(require.resolve("node-pty")));
	} catch {
		return null;
	}
}

/**
 * Ensure node-pty's `spawn-helper` is executable, repairing it if not.
 *
 * Safe to call repeatedly; it stats first and only writes when the bit is
 * genuinely missing. Windows has no spawn-helper and is skipped.
 */
export function ensureSpawnHelperExecutable(): SpawnHelperRepair {
	if (process.platform === "win32") return { repaired: false, reason: "not-posix" };

	const root = resolveNodePtyRoot();
	if (root === null) return { repaired: false, reason: "not-found" };

	for (const dir of NATIVE_DIRS) {
		// electron-builder unpacks native modules beside the asar; node-pty
		// rewrites its own path the same way, so mirror that here.
		const helper = path
			.join(root, dir, "spawn-helper")
			.replace("app.asar", "app.asar.unpacked")
			.replace("node_modules.asar", "node_modules.asar.unpacked");
		let mode: number;
		try {
			mode = statSync(helper).mode;
		} catch {
			continue; // this variant is not the one in use
		}
		const executable = (mode & constants.S_IXUSR) !== 0;
		if (executable) return { path: helper, repaired: false, reason: "already-executable" };
		try {
			chmodSync(helper, 0o755);
			return { path: helper, repaired: true, reason: "repaired" };
		} catch (error) {
			return {
				path: helper,
				repaired: false,
				reason: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
	return { repaired: false, reason: "not-found" };
}

/** Does this error look like the missing-execute-bit failure? */
export function isSpawnHelperFailure(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("posix_spawnp") || message.includes("spawn-helper");
}
