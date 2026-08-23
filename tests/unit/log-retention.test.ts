/**
 * Log retention (audit M-6, plan 012 fix 3).
 *
 * Rotation renames `pidesktop-YYYYMMDD.log` to `….log.<ts>.rotated`, but the
 * pruner only matched `.endsWith(".log")` — so every rotated chunk was immortal
 * while the daily files it came from were collected on schedule.
 */
import { mkdtempSync, readdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneOldLogs } from "../../src/main/services/paths";

const DAY_MS = 86_400_000;

function seed(dir: string, name: string, ageDays: number): string {
	const file = join(dir, name);
	writeFileSync(file, "log line\n");
	const when = (Date.now() - ageDays * DAY_MS) / 1000;
	utimesSync(file, when, when);
	return file;
}

describe("pruneOldLogs", () => {
	it("deletes rotated chunks past retention, not just .log files", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-logs-"));
		seed(dir, "pidesktop-20200101.log", 30);
		seed(dir, "pidesktop-20200101.log.1577836800000.rotated", 30);

		pruneOldLogs(dir);

		expect(readdirSync(dir)).toEqual([]);
	});

	it("keeps recent files of both shapes", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-logs-"));
		seed(dir, "pidesktop-today.log", 1);
		seed(dir, "pidesktop-today.log.123.rotated", 2);

		pruneOldLogs(dir);

		expect(readdirSync(dir).sort()).toEqual([
			"pidesktop-today.log",
			"pidesktop-today.log.123.rotated",
		]);
	});

	it("never touches files that are not ours, however old", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-logs-"));
		seed(dir, "unrelated.txt", 400);
		seed(dir, "someone-else.log", 400);
		seed(dir, "pidesktop-20200101.log", 400);

		pruneOldLogs(dir);

		// Only the pidesktop-prefixed file is in scope.
		expect(readdirSync(dir).sort()).toEqual(["someone-else.log", "unrelated.txt"]);
	});

	it("does not throw on a missing directory", () => {
		expect(() => pruneOldLogs(join(tmpdir(), "pi-logs-does-not-exist"))).not.toThrow();
	});
});
