/**
 * Auto-update (chapter 8). electron-updater against GitHub Releases.
 *
 * Stance: update checks are ON in packaged builds, OFF in dev. The feed is
 * configured by electron-builder's `publish` block; if the repo is not yet
 * public the check fails silently with a log line — never a user-facing error.
 * Signature verification is enforced by electron-updater by default (updates
 * must be signed with the same Developer ID as the installed app).
 */
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;
import type { Logger } from "./services/logging";

export function setupAutoUpdater(logger: Logger): void {
	if (!app_isPackaged()) {
		logger.info("main", "auto-update skipped (dev build)");
		return;
	}

	// Auto-update is disabled until this project has its own signed release feed.
	// Without this guard, autoDownload would install whatever the configured
	// publish target serves — see docs/RELEASE.md.
	if (process.env.PI_DESKTOP_ENABLE_UPDATER !== "1") {
		logger.info("main", "auto-update disabled (no signed release feed configured)");
		return;
	}

	autoUpdater.logger = null; // we do our own logging
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;

	autoUpdater.on("checking-for-update", () => {
		logger.debug("main", "checking for updates");
	});
	autoUpdater.on("update-available", (info) => {
		logger.info("main", `update available: v${String(info.version)}`);
	});
	autoUpdater.on("update-not-available", () => {
		logger.debug("main", "no updates available");
	});
	autoUpdater.on("error", (error) => {
		// Non-fatal: offline, private repo, unsigned feed — log and move on.
		logger.warn("main", `auto-update error: ${String(error)}`);
	});
	autoUpdater.on("update-downloaded", (info) => {
		logger.info("main", `update downloaded: v${String(info.version)}; installs on quit`);
	});

	// Check at launch and every 6 hours.
	void autoUpdater.checkForUpdatesAndNotify().catch(() => {});
	const interval = setInterval(() => {
		void autoUpdater.checkForUpdatesAndNotify().catch(() => {});
	}, 6 * 60 * 60 * 1000);
	interval.unref?.();
}

function app_isPackaged(): boolean {
	try {
		const electron = require("electron") as { app: { isPackaged: boolean } };
		return electron.app.isPackaged;
	} catch {
		return false;
	}
}
