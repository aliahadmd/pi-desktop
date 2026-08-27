/**
 * Usage capture atomicity (audit 6 L-10): the usage_events insert and the
 * sessions rollup update must commit together or not at all. A failed rollup
 * after a committed insert permanently desynchronizes the two surfaces.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/main/store/db";
import { SessionsRepo, UsageRepo, type UsageEventInsert } from "../../src/main/store/repos";

let db: Database.Database;
let sessions: SessionsRepo;
let usage: UsageRepo;

const event: UsageEventInsert = {
	sessionId: "s1",
	kind: "assistant_message",
	inputTokens: 100,
	outputTokens: 50,
	cacheRead: 10,
	cacheWrite: 5,
	totalTokens: 150,
	costUsd: 0.25,
	modelProvider: "anthropic",
	modelId: "claude-test",
};

beforeEach(() => {
	db = openDatabase(":memory:");
	sessions = new SessionsRepo(db);
	usage = new UsageRepo(db);
});

describe("UsageRepo.insertWithRollup", () => {
	it("writes the event and the session rollup together", () => {
		sessions.upsert({ id: "s1", file_path: "/a.jsonl" });
		usage.insertWithRollup(event);
		usage.insertWithRollup(event);

		const row = sessions.get("s1");
		expect(row?.input_tokens).toBe(200);
		expect(row?.output_tokens).toBe(100);
		expect(row?.cache_read_tokens).toBe(20);
		expect(row?.cache_write_tokens).toBe(10);
		expect(row?.cost_usd).toBeCloseTo(0.5);
		expect(usage.totals().total_tokens).toBe(300);
	});

	it("rolls back the insert when the rollup fails", () => {
		// Break the rollup half: the UPDATE targets the sessions table.
		db.exec("DROP TABLE sessions");
		expect(() => usage.insertWithRollup(event)).toThrow();
		// The event insert must not survive the failed pair.
		const n = db
			.prepare("SELECT COUNT(*) AS n FROM usage_events")
			.get() as { n: number };
		expect(n.n).toBe(0);
	});

	it("rolls back the rollup when the insert fails", () => {
		sessions.upsert({ id: "s1", file_path: "/a.jsonl" });
		// Break the insert half: usage_events is gone.
		db.exec("DROP TABLE usage_events");
		expect(() => usage.insertWithRollup(event)).toThrow();
		// The rollup must not have applied without its event.
		expect(sessions.get("s1")?.input_tokens).toBe(0);
	});
});
