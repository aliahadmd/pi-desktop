/**
 * Main-side busy_timeout pragma (audit 6 M-13). The Python sidecar shares the
 * SQLite file and commits per batch while indexing; the explicit pragma keeps
 * main-process writes waiting a bounded time instead of relying on the
 * better-sqlite3 default (5000 ms).
 */
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/main/store/db";

describe("openDatabase pragmas", () => {
	it("sets an explicit busy_timeout for the shared sidecar file", () => {
		const db = openDatabase(":memory:");
		try {
			expect(db.pragma("busy_timeout", { simple: true })).toBe(3000);
		} finally {
			db.close();
		}
	});

	it("still enables WAL and foreign keys", () => {
		const db = openDatabase(":memory:");
		try {
			// WAL is a no-op label for :memory: databases; foreign_keys must hold.
			expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
		} finally {
			db.close();
		}
	});
});
