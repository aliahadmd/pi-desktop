/**
 * SQLite access layer (chapter 4). One database file under userData, WAL mode.
 * Table ownership: this module (main process) owns all tables in v1; the
 * Python sidecar (chapter 5) will own FTS/analytics tables in the same file.
 */
import Database from "better-sqlite3";
import path from "node:path";

export interface DbHandle {
	db: Database.Database;
}

const MIGRATIONS: string[] = [
	// 001_init
	`
	CREATE TABLE IF NOT EXISTS projects (
		id TEXT PRIMARY KEY,
		path TEXT UNIQUE NOT NULL,
		name TEXT,
		added_at INTEGER NOT NULL,
		last_opened_at INTEGER
	);

	CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		file_path TEXT NOT NULL UNIQUE,
		project_id TEXT REFERENCES projects(id),
		name TEXT,
		cwd TEXT,
		created_at INTEGER,
		updated_at INTEGER,
		message_count INTEGER DEFAULT 0,
		input_tokens INTEGER DEFAULT 0,
		output_tokens INTEGER DEFAULT 0,
		cache_read_tokens INTEGER DEFAULT 0,
		cache_write_tokens INTEGER DEFAULT 0,
		cost_usd REAL DEFAULT 0,
		model_provider TEXT,
		model_id TEXT,
		first_message TEXT,
		indexed_at INTEGER
	);
	CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
	CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

	CREATE TABLE IF NOT EXISTS usage_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL,
		ts INTEGER NOT NULL,
		kind TEXT NOT NULL,
		input_tokens INTEGER DEFAULT 0,
		output_tokens INTEGER DEFAULT 0,
		cache_read INTEGER DEFAULT 0,
		cache_write INTEGER DEFAULT 0,
		total_tokens INTEGER DEFAULT 0,
		cost_usd REAL DEFAULT 0,
		model_provider TEXT,
		model_id TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id);
	CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);

	CREATE TABLE IF NOT EXISTS app_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
`,

	// 002_projects_pinned (phase 6): pinning support for the sidebar.
	`
	ALTER TABLE projects ADD COLUMN pinned_at INTEGER;
`,
];

export function openDatabase(dbPath: string): Database.Database {
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.pragma("synchronous = NORMAL");
	migrate(db);
	return db;
}

export function migrate(db: Database.Database): void {
	const current = db.pragma("user_version", { simple: true }) as number;
	for (let v = current; v < MIGRATIONS.length; v++) {
		const run = db.transaction(() => {
			db.exec(MIGRATIONS[v] ?? "");
			db.pragma(`user_version = ${v + 1}`);
		});
		run();
	}
}

/** Project data dir helper (kept next to db for cohesion). */
export function defaultDbPath(appSupportDir: string): string {
	return path.join(appSupportDir, "pidesktop.db");
}
