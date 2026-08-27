/**
 * Packaged-aware application root (audit 6 H-4).
 *
 * `process.cwd()` in a packaged app is the *launch* directory (typically `/`
 * when started from Finder), so anything resolved against it — the bundled pi
 * CLI, an app-level SettingsManager — breaks outside dev. `app.getAppPath()`
 * is the repo root in dev and the `app.asar` path when packaged; both contain
 * `node_modules` (production deps ship inside the asar, and Electron's node
 * reads inside asar even under ELECTRON_RUN_AS_NODE — verified against the
 * shipped build).
 *
 * Falls back to `process.cwd()` only when Electron's app API is unavailable
 * (plain-node unit tests).
 */
import { createRequire } from "node:module";

export function appRoot(): string {
	try {
		// createRequire: this project ships ESM ("type": "module"), so a bare
		// `require` does not exist in the built main bundle.
		const require = createRequire(import.meta.url);
		const electron = require("electron") as { app?: { getAppPath(): string } };
		const appPath = electron.app?.getAppPath();
		if (typeof appPath === "string" && appPath.length > 0) return appPath;
	} catch {
		// Not running under Electron (unit tests): the electron package resolves
		// to a binary-path string without the app API.
	}
	return process.cwd();
}
