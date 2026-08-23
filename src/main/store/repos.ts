/**
 * Typed repositories over the SQLite store. All statements are prepared once.
 * Every method is best-effort from the caller's perspective: callers wrap
 * them so a store failure never breaks the agent session.
 */
import type Database from "better-sqlite3";
import path from "node:path";

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionRow {
	id: string;
	file_path: string;
	project_id: string | null;
	name: string | null;
	cwd: string | null;
	created_at: number | null;
	updated_at: number | null;
	message_count: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	cost_usd: number;
	model_provider: string | null;
	model_id: string | null;
	first_message: string | null;
	indexed_at: number | null;
}

export interface SessionUpsert {
	id: string;
	file_path: string;
	name?: string | null;
	cwd?: string | null;
	createdAt?: number | null;
	updatedAt?: number | null;
	messageCount?: number;
	firstMessage?: string | null;
	modelProvider?: string | null;
	modelId?: string | null;
}

export class SessionsRepo {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	upsert(s: SessionUpsert): void {
		const row = {
			id: s.id,
			file_path: s.file_path,
			name: s.name ?? null,
			cwd: s.cwd ?? null,
			created_at: s.createdAt ?? null,
			updated_at: s.updatedAt ?? null,
			message_count: s.messageCount ?? 0,
			first_message: s.firstMessage ?? null,
			model_provider: s.modelProvider ?? null,
			model_id: s.modelId ?? null,
			now: Date.now(),
		};
		// A session file is the source of truth for its own identity: pi can
		// rewrite the header id (fork/switch/recovery), leaving a stale-id row
		// sitting on this path. Adopting the file's id keeps UNIQUE(file_path)
		// from rejecting every later reindex pass. If the incoming id is held
		// by a DIFFERENT path, that path is a duplicate of this file; drop it
		// in favour of the file we just read.
		const existing = this.db
			.prepare("SELECT id FROM sessions WHERE file_path = ?")
			.get(s.file_path) as { id: string } | undefined;
		if (existing !== undefined && existing.id !== s.id) {
			this.db
				.prepare("DELETE FROM sessions WHERE id = ? AND file_path <> ?")
				.run(s.id, s.file_path);
			this.db.prepare("UPDATE sessions SET id = ? WHERE file_path = ?").run(s.id, s.file_path);
		}
		this.db
			.prepare(
				`
				INSERT INTO sessions (id, file_path, name, cwd, created_at, updated_at,
					message_count, first_message, model_provider, model_id, indexed_at)
				VALUES (@id, @file_path, @name, @cwd, @created_at, @updated_at,
					@message_count, @first_message, @model_provider, @model_id, @now)
				ON CONFLICT(id) DO UPDATE SET
					file_path = excluded.file_path,
					name = COALESCE(excluded.name, sessions.name),
					cwd = COALESCE(excluded.cwd, sessions.cwd),
					updated_at = COALESCE(excluded.updated_at, sessions.updated_at),
					message_count = MAX(COALESCE(excluded.message_count, 0), sessions.message_count),
					first_message = COALESCE(sessions.first_message, excluded.first_message),
					model_provider = COALESCE(excluded.model_provider, sessions.model_provider),
					model_id = COALESCE(excluded.model_id, sessions.model_id),
					indexed_at = excluded.indexed_at
				`
			)
			.run(row);
	}

	get(id: string): SessionRow | undefined {
		return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
			| SessionRow
			| undefined;
	}

	list(limit = 500): SessionRow[] {
		return this.db
			.prepare("SELECT * FROM sessions ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?")
			.all(limit) as SessionRow[];
	}

	search(query: string, limit = 100): SessionRow[] {
		const like = `%${query}%`;
		return this.db
			.prepare(
				`SELECT * FROM sessions
				 WHERE name LIKE ? OR cwd LIKE ? OR file_path LIKE ? OR first_message LIKE ?
				 ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`
			)
			.all(like, like, like, like, limit) as SessionRow[];
	}

	removeByFilePath(filePath: string): void {
		this.db.prepare("DELETE FROM sessions WHERE file_path = ?").run(filePath);
	}

	removeMissing(filePaths: string[]): void {
		if (filePaths.length === 0) {
			this.db.prepare("DELETE FROM sessions").run();
			return;
		}
		const placeholders = filePaths.map(() => "?").join(",");
		this.db
			.prepare(
				`DELETE FROM sessions WHERE file_path NOT IN (${placeholders})`
			)
			.run(...filePaths);
	}
}

// ---------------------------------------------------------------------------
// Usage events + rollups
// ---------------------------------------------------------------------------

export interface UsageEventInsert {
	sessionId: string;
	ts?: number;
	kind: "assistant_message" | "compaction" | "tool_usage";
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	costUsd?: number;
	modelProvider?: string | null;
	modelId?: string | null;
}

export interface UsageSummaryRow {
	day: string;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	requests: number;
}

export class UsageRepo {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	insert(e: UsageEventInsert): void {
		this.db
			.prepare(
				`INSERT INTO usage_events (session_id, ts, kind, input_tokens, output_tokens,
					cache_read, cache_write, total_tokens, cost_usd, model_provider, model_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				e.sessionId,
				e.ts ?? Date.now(),
				e.kind,
				e.inputTokens ?? 0,
				e.outputTokens ?? 0,
				e.cacheRead ?? 0,
				e.cacheWrite ?? 0,
				e.totalTokens ?? 0,
				e.costUsd ?? 0,
				e.modelProvider ?? null,
				e.modelId ?? null
			);
	}

	addToSessionRollup(sessionId: string, e: UsageEventInsert): void {
		this.db
			.prepare(
				`UPDATE sessions SET
					input_tokens = input_tokens + ?,
					output_tokens = output_tokens + ?,
					cache_read_tokens = cache_read_tokens + ?,
					cache_write_tokens = cache_write_tokens + ?,
					cost_usd = cost_usd + ?
				 WHERE id = ?`
			)
			.run(
				e.inputTokens ?? 0,
				e.outputTokens ?? 0,
				e.cacheRead ?? 0,
				e.cacheWrite ?? 0,
				e.costUsd ?? 0,
				sessionId
			);
	}

	dailySummary(days: number): UsageSummaryRow[] {
		const since = Date.now() - days * 86_400_000;
		return this.db
			.prepare(
				`SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
					SUM(input_tokens) AS input_tokens,
					SUM(output_tokens) AS output_tokens,
					SUM(cost_usd) AS cost_usd,
					COUNT(*) AS requests
				 FROM usage_events WHERE ts >= ?
				 GROUP BY day ORDER BY day DESC`
			)
			.all(since) as UsageSummaryRow[];
	}

	totals(): { total_cost: number; total_tokens: number } {
		return this.db
			.prepare(
				`SELECT COALESCE(SUM(cost_usd), 0) AS total_cost,
				 COALESCE(SUM(total_tokens), 0) AS total_tokens FROM usage_events`
			)
			.get() as { total_cost: number; total_tokens: number };
	}
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectRow {
	id: string;
	path: string;
	name: string | null;
	added_at: number;
	last_opened_at: number | null;
	pinned_at: number | null;
}

export interface ProjectRowWithMeta extends ProjectRow {
	session_count: number;
}

export class ProjectsRepo {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	ensure(pathValue: string): string {
		const existing = this.db
			.prepare("SELECT id FROM projects WHERE path = ?")
			.get(pathValue) as { id: string } | undefined;
		if (existing !== undefined) return existing.id;
		const id = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		this.db
			.prepare("INSERT INTO projects (id, path, name, added_at) VALUES (?, ?, ?, ?)")
			.run(id, pathValue, path.basename(pathValue), Date.now());
		return id;
	}

	touch(projectId: string): void {
		this.db
			.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?")
			.run(Date.now(), projectId);
	}

	list(): ProjectRow[] {
		return this.db
			.prepare("SELECT * FROM projects ORDER BY last_opened_at DESC, added_at DESC")
			.all() as ProjectRow[];
	}

	attachProjectToSessions(cwd: string, projectId: string): void {
		this.db
			.prepare("UPDATE sessions SET project_id = ? WHERE cwd = ? AND project_id IS NULL")
			.run(projectId, cwd);
	}

	setPinned(projectId: string, pinned: boolean): void {
		this.db
			.prepare("UPDATE projects SET pinned_at = ? WHERE id = ?")
			.run(pinned ? Date.now() : null, projectId);
	}

	isPinned(projectId: string): boolean {
		const row = this.db
			.prepare("SELECT pinned_at FROM projects WHERE id = ?")
			.get(projectId) as { pinned_at: number | null } | undefined;
		return row?.pinned_at != null;
	}

	/** All projects with live session counts; caller applies sort order. */
	listWithCounts(): ProjectRowWithMeta[] {
		return this.db
			.prepare(
				`SELECT p.*,
					COALESCE((SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id), 0)
					AS session_count
				 FROM projects p`,
			)
			.all() as ProjectRowWithMeta[];
	}
}

// ---------------------------------------------------------------------------
// App settings (KV with JSON values)
// ---------------------------------------------------------------------------

export class SettingsRepo {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	get<T>(key: string, fallback: T): T {
		const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
			| { value: string }
			| undefined;
		if (row === undefined) return fallback;
		try {
			return JSON.parse(row.value) as T;
		} catch {
			return fallback;
		}
	}

	set(key: string, value: unknown): void {
		this.db
			.prepare(
				"INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
			)
			.run(key, JSON.stringify(value));
	}
}
