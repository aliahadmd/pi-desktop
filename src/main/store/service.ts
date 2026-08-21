/**
 * StoreService — SQLite persistence for chapter 4:
 *  - registers sessions on open/close
 *  - captures usage events live from the PiService event stream
 *  - indexes pi's session files for fast browsing (reconciliation indexer)
 *  - exposes db.* / app.settings IPC channels
 *
 * All store operations are failure-isolated: persistence problems must never
 * break a running agent session.
 */
import { shell } from "electron";
import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { IpcRouter } from "../ipc/router";
import type { PiService } from "../pi/service";
import { describeError } from "../pi/backend";
import { toJson, type PiEvent } from "../../shared/pi";
import { openDatabase, defaultDbPath, type DbHandle } from "./db";
import {
	ProjectsRepo,
	SessionsRepo,
	SettingsRepo,
	UsageRepo,
	type SessionRow,
} from "./repos";

const INDEX_INTERVAL_MS = 5 * 60_000;

export class StoreService {
	private db: DbHandle | null = null;
	private sessions: SessionsRepo | null = null;
	private usage: UsageRepo | null = null;
	private projects: ProjectsRepo | null = null;
	private settings: SettingsRepo | null = null;
	private readonly appToPiSession = new Map<string, string>();
	private indexTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly appSupportDir: string,
		private readonly log?: (level: "info" | "warn" | "error", message: string) => void
	) {}

	start(): void {
		try {
			const db = openDatabase(defaultDbPath(this.appSupportDir));
			this.db = { db };
			this.sessions = new SessionsRepo(db);
			this.usage = new UsageRepo(db);
			this.projects = new ProjectsRepo(db);
			this.settings = new SettingsRepo(db);
			this.log?.("info", `store opened at ${defaultDbPath(this.appSupportDir)}`);
		} catch (error) {
			this.log?.("error", `store failed to open: ${describeError(error)}`);
		}
	}

	stop(): void {
		if (this.indexTimer !== null) clearInterval(this.indexTimer);
		this.db?.db.close();
		this.db = null;
	}

	attachPiService(piService: PiService): void {
		void piService.setHooks({
			onSessionOpened: (info) => this.handleSessionOpened(info),
			onSessionClosed: (appSessionId) => {
				this.appToPiSession.delete(appSessionId);
			},
			onSessionEvent: (appSessionId, event) => this.handleSessionEvent(appSessionId, event),
		});
	}

	registerHandlers(router: IpcRouter): void {
		router.handle("db.sessions.list", (req) => {
			const rows = this.sessions?.list(req.limit ?? 500) ?? [];
			return { sessions: rows.map(toIndexed) };
		});
		router.handle("db.sessions.search", (req) => {
			const rows =
				req.query.trim().length === 0
					? (this.sessions?.list(req.limit ?? 100) ?? [])
					: (this.sessions?.search(req.query, req.limit ?? 100) ?? []);
			return { sessions: rows.map(toIndexed) };
		});
		router.handle("session.delete_file", async (req) => {
			if (existsSync(req.sessionPath)) {
				await shell.trashItem(req.sessionPath);
			}
			this.guard(() => this.sessions?.removeByFilePath(req.sessionPath));
			return null;
		});
		router.handle("db.usage.daily", (req) => {
			const rows = this.usage?.dailySummary(req.days ?? 30) ?? [];
			return rows.map((r) => ({
				day: r.day,
				inputTokens: r.input_tokens,
				outputTokens: r.output_tokens,
				costUsd: r.cost_usd,
				requests: r.requests,
			}));
		});
		router.handle("db.usage.totals", () => {
			const t = this.usage?.totals() ?? { total_cost: 0, total_tokens: 0 };
			return { totalCost: t.total_cost, totalTokens: t.total_tokens };
		});
		router.handle("db.projects.list", () => {
			const rows = this.projects?.list() ?? [];
			return { projects: rows.map((p) => ({ id: p.id, path: p.path, name: p.name })) };
		});
		router.handle("db.indexer.refresh", async () => {
			return { indexed: await this.reindex() };
		});
		router.handle("app.settings.get", (req) => {
			const value: unknown = this.settings?.get<unknown>(req.key, null) ?? null;
			return toJson(value);
		});
		router.handle("app.settings.set", (req) => {
			this.guard(() => {
				const parsed: unknown = JSON.parse(req.value);
				this.settings?.set(req.key, parsed);
			});
			return null;
		});
	}

	// ---------------------------------------------------------------------------
	// Window state convenience (used by main/index.ts)
	// ---------------------------------------------------------------------------

	getSettingRaw(key: string): unknown {
		return this.settings?.get<unknown>(key, null) ?? null;
	}

	setSettingRaw(key: string, value: unknown): void {
		this.guard(() => this.settings?.set(key, value));
	}

	getWindowState<T>(fallback: T): T {
		return this.settings?.get("windowState", fallback) ?? fallback;
	}

	setWindowState(state: unknown): void {
		this.guard(() => this.settings?.set("windowState", state));
	}

	/** Kick off initial index + periodic reconciliation. */
	startIndexer(): void {
		void this.reindex();
		this.indexTimer = setInterval(() => void this.reindex(), INDEX_INTERVAL_MS);
		this.indexTimer.unref?.();
	}

	async reindex(): Promise<number> {
		if (this.sessions === null || this.projects === null) return 0;
		try {
			const infos = await SessionManager.listAll();
			for (const info of infos) {
				this.guard(() => {
					let projectId: string | null = null;
					if (info.cwd !== "") projectId = this.projects?.ensure(info.cwd) ?? null;
					this.sessions?.upsert({
						id: info.id,
						file_path: info.path,
						name: info.name ?? null,
						cwd: info.cwd === "" ? null : info.cwd,
						createdAt: info.created.getTime(),
						updatedAt: info.modified.getTime(),
						messageCount: info.messageCount,
						firstMessage: info.firstMessage.slice(0, 300),
					});
					if (projectId !== null && info.cwd !== "") {
						this.projects?.attachProjectToSessions(info.cwd, projectId);
					}
				});
			}
			this.guard(() =>
				this.sessions?.removeMissing(infos.map((i) => i.path))
			);
			return infos.length;
		} catch (error) {
			this.log?.("warn", `reindex failed: ${describeError(error)}`);
			return 0;
		}
	}

	// ---------------------------------------------------------------------------
	// Event capture
	// ---------------------------------------------------------------------------

	private handleSessionOpened(info: {
		appSessionId: string;
		piSessionId: string | undefined;
		sessionFile: string | undefined;
		cwd: string;
		backend: "sdk" | "rpc";
	}): void {
		// Ephemeral sessions (no file) are excluded from usage capture entirely
		// so usage_events never reference a sessions row that does not exist.
		if (info.piSessionId === undefined || info.sessionFile === undefined) return;
		this.appToPiSession.set(info.appSessionId, info.piSessionId);
		this.guard(() => {
			const projectId = this.projects?.ensure(info.cwd) ?? null;
			if (projectId !== null) this.projects?.touch(projectId);
			this.sessions?.upsert({
				id: info.piSessionId as string,
				file_path: info.sessionFile as string,
				cwd: info.cwd,
			});
		});
	}

	private handleSessionEvent(appSessionId: string, event: PiEvent): void {
		const piSessionId = this.appToPiSession.get(appSessionId);
		if (piSessionId === undefined) return;

		if (event.type === "message_end") {
			const message = event.message as
				| { role?: string; usage?: Record<string, unknown>; model?: string; provider?: string }
				| undefined;
			if (message?.role !== "assistant" || message.usage === undefined) return;
			this.captureUsage(piSessionId, "assistant_message", message.usage, {
				modelProvider: typeof message.provider === "string" ? message.provider : null,
				modelId: typeof message.model === "string" ? message.model : null,
			});
			return;
		}

		if (event.type === "compaction_end" && event.result !== undefined) {
			const usage = event.result as { usage?: Record<string, unknown> };
			if (usage.usage !== undefined) {
				this.captureUsage(piSessionId, "compaction", usage.usage, null);
			}
		}
	}

	private captureUsage(
		piSessionId: string,
		kind: "assistant_message" | "compaction",
		usage: Record<string, unknown>,
		model: { modelProvider: string | null; modelId: string | null } | null
	): void {
		this.guard(() => {
			const num = (key: string): number =>
				typeof usage[key] === "number" ? (usage[key] as number) : 0;
			const cost =
				typeof usage["cost"] === "object" && usage["cost"] !== null
					? (usage["cost"] as { total?: unknown })
					: undefined;
			const insert = {
				sessionId: piSessionId,
				kind,
				inputTokens: num("input"),
				outputTokens: num("output"),
				cacheRead: num("cacheRead"),
				cacheWrite: num("cacheWrite"),
				totalTokens: num("totalTokens"),
				costUsd: typeof cost?.total === "number" ? cost.total : 0,
				modelProvider: model?.modelProvider ?? null,
				modelId: model?.modelId ?? null,
			};
			this.usage?.insert(insert);
			this.usage?.addToSessionRollup(piSessionId, insert);
		});
	}

	private guard(fn: () => void): void {
		try {
			fn();
		} catch (error) {
			this.log?.("warn", `store operation failed: ${describeError(error)}`);
		}
	}
}

function toIndexed(row: SessionRow): {
	id: string;
	filePath: string;
	name: string | null;
	cwd: string | null;
	updatedAt: number | null;
	messageCount: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	modelProvider: string | null;
	modelId: string | null;
	firstMessage: string | null;
} {
	return {
		id: row.id,
		filePath: row.file_path,
		name: row.name,
		cwd: row.cwd,
		updatedAt: row.updated_at,
		messageCount: row.message_count,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		costUsd: row.cost_usd,
		modelProvider: row.model_provider,
		modelId: row.model_id,
		firstMessage: row.first_message,
	};
}
