/**
 * Tests for the SQLite store (chapter 4): migrations, session upsert/search,
 * usage rollups, settings KV. Runs against an in-memory database.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/main/store/db";
import {
	ProjectsRepo,
	SessionsRepo,
	SettingsRepo,
	UsageRepo,
} from "../../src/main/store/repos";

let sessions: SessionsRepo;
let usage: UsageRepo;
let projects: ProjectsRepo;
let settings: SettingsRepo;

beforeEach(() => {
	const db = openDatabase(":memory:");
	sessions = new SessionsRepo(db);
	usage = new UsageRepo(db);
	projects = new ProjectsRepo(db);
	settings = new SettingsRepo(db);
});

describe("sessions repo", () => {
	it("upserts and lists sessions newest-first", () => {
		sessions.upsert({
			id: "s1",
			file_path: "/a.jsonl",
			cwd: "/proj/a",
			name: "first",
			updatedAt: 1000,
			messageCount: 3,
		});
		sessions.upsert({
			id: "s2",
			file_path: "/b.jsonl",
			cwd: "/proj/b",
			updatedAt: 2000,
		});
		const rows = sessions.list();
		expect(rows.map((r) => r.id)).toEqual(["s2", "s1"]);
	});

	it("preserves first_message once seen (COALESCE on update)", () => {
		sessions.upsert({ id: "s1", file_path: "/a.jsonl", firstMessage: "original" });
		sessions.upsert({ id: "s1", file_path: "/a.jsonl", firstMessage: "different" });
		expect(sessions.get("s1")?.first_message).toBe("original");
	});

	it("monotonically keeps message_count via MAX", () => {
		sessions.upsert({ id: "s1", file_path: "/a.jsonl", messageCount: 10 });
		sessions.upsert({ id: "s1", file_path: "/a.jsonl", messageCount: 4 });
		expect(sessions.get("s1")?.message_count).toBe(10);
	});

	it("searches by name/cwd/first message substring", () => {
		sessions.upsert({ id: "s1", file_path: "/x.jsonl", cwd: "/home/me/webapp" });
		sessions.upsert({ id: "s2", file_path: "/y.jsonl", cwd: "/home/me/cli-tool" });
		expect(sessions.search("webapp").map((r) => r.id)).toEqual(["s1"]);
		expect(sessions.search("cli").map((r) => r.id)).toEqual(["s2"]);
	});

	it("removes rows missing from the index listing", () => {
		sessions.upsert({ id: "s1", file_path: "/a.jsonl" });
		sessions.upsert({ id: "s2", file_path: "/b.jsonl" });
		sessions.removeMissing(["/a.jsonl"]);
		expect(sessions.get("s1")).toBeDefined();
		expect(sessions.get("s2")).toBeUndefined();
	});

	it("adopts the new header id when a session file rewrites it", () => {
		// Production sequence (audit follow-up): pi rewrote the header of
		// /p.jsonl, so reindex now reports id s2 for a row stored as s1.
		sessions.upsert({ id: "s1", file_path: "/p.jsonl", firstMessage: "original" });
		expect(() => sessions.upsert({ id: "s2", file_path: "/p.jsonl" })).not.toThrow();
		// The file wins: one row, new id, history fields preserved.
		expect(sessions.get("s1")).toBeUndefined();
		const row = sessions.get("s2");
		expect(row?.file_path).toBe("/p.jsonl");
		expect(row?.first_message).toBe("original");
	});

	it("prefers the freshly read file when the incoming id collides with another path", () => {
		sessions.upsert({ id: "s2", file_path: "/old-location.jsonl" });
		// A duplicate copy of the same session now lives at /p.jsonl and its
		// header carries id s2; the stale path must yield.
		sessions.upsert({ id: "s2", file_path: "/p.jsonl" });
		expect(sessions.get("s2")?.file_path).toBe("/p.jsonl");
		expect(sessions.list().filter((r) => r.id === "s2")).toHaveLength(1);
	});

	it("is a no-op when id and path already agree", () => {
		sessions.upsert({ id: "s1", file_path: "/a.jsonl", firstMessage: "keep" });
		sessions.upsert({ id: "s1", file_path: "/a.jsonl", messageCount: 3 });
		const row = sessions.get("s1");
		expect(row?.first_message).toBe("keep");
		expect(row?.message_count).toBe(3);
	});
});

describe("usage repo", () => {
	it("inserts events and rolls up into session totals", () => {
		sessions.upsert({ id: "s1", file_path: "/a.jsonl" });
		const event = {
			sessionId: "s1",
			kind: "assistant_message" as const,
			inputTokens: 100,
			outputTokens: 50,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 150,
			costUsd: 0.25,
			modelProvider: "anthropic",
			modelId: "claude-test",
		};
		usage.insert(event);
		usage.addToSessionRollup("s1", event);
		usage.insert(event);
		usage.addToSessionRollup("s1", event);

		const row = sessions.get("s1");
		expect(row?.input_tokens).toBe(200); // two inserts rolled up
		expect(row?.cost_usd).toBeCloseTo(0.5);
		expect(row?.cache_read_tokens).toBe(20);

		const daily = usage.dailySummary(30);
		expect(daily).toHaveLength(1);
		expect(daily[0]?.requests).toBe(2);

		const totals = usage.totals();
		expect(totals.total_tokens).toBe(300);
	});
});

describe("projects + settings", () => {
	it("ensures projects idempotently and attaches sessions", () => {
		const id1 = projects.ensure("/work/app");
		const id2 = projects.ensure("/work/app");
		expect(id1).toBe(id2);
		sessions.upsert({ id: "s1", file_path: "/a.jsonl", cwd: "/work/app" });
		projects.attachProjectToSessions("/work/app", id1);
		expect(sessions.get("s1")?.project_id).toBe(id1);
	});

	it("round-trips JSON settings values", () => {
		settings.set("windowState", { width: 800, height: 600 });
		expect(settings.get("windowState", { width: 0, height: 0 })).toEqual({
			width: 800,
			height: 600,
		});
		expect(settings.get("missing", "fallback")).toBe("fallback");
	});
});
