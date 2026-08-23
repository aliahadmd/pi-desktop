/**
 * Filesystem layout under Electron's userData directory:
 *   ~/Library/Application Support/PiDesktop/
 *     logs/            rotating JSONL logs
 *     sessions-cache/  future session index scratch space (chapter 4)
 *     pidesktop.db     SQLite database (chapter 4)
 */
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export interface AppPaths {
	appSupport: string;
	logs: string;
	sessionsCache: string;
	db: string;
}

export function resolveAppPaths(userDataDir: string): AppPaths {
	return {
		appSupport: userDataDir,
		logs: path.join(userDataDir, "logs"),
		sessionsCache: path.join(userDataDir, "sessions-cache"),
		db: path.join(userDataDir, "pidesktop.db"),
	};
}

export function ensureAppPaths(paths: AppPaths): void {
	for (const dir of [paths.appSupport, paths.logs, paths.sessionsCache]) {
		mkdirSync(dir, { recursive: true });
	}
}

const LOG_RETENTION_DAYS = 14;

/** Delete log files older than LOG_RETENTION_DAYS. Best-effort; never throws. */
export function pruneOldLogs(logsDir: string, now = Date.now()): void {
	try {
		for (const name of readdirSync(logsDir)) {
			// Rotation renames `pidesktop-YYYYMMDD.log` to
			// `pidesktop-YYYYMMDD.log.<ts>.rotated`, so an `.endsWith(".log")`
			// test never matched the rotated chunks and they lived forever.
			// Match the whole family, and nothing that is not ours.
			if (!name.startsWith("pidesktop-") || !name.includes(".log")) continue;
			const filePath = path.join(logsDir, name);
			const ageDays = (now - getMtimeMs(filePath)) / 86_400_000;
			if (ageDays > LOG_RETENTION_DAYS) rmSync(filePath, { force: true });
		}
	} catch {
		// best effort only
	}
}

function getMtimeMs(filePath: string): number {
	try {
		return statSync(filePath).mtimeMs;
	} catch {
		return 0;
	}
}
