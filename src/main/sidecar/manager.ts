/**
 * SidecarManager — lifecycle for the Python sidecar (FastAPI/uvicorn).
 *
 * Launch order:
 *  1. PI_DESKTOP_SIDECAR_BIN env or bundled PyInstaller binary (chapter 8)
 *  2. Dev mode: `uv run uvicorn` inside sidecar/
 *
 * Health-polled; up to 3 restarts with backoff; loopback-only + per-boot token.
 * All sidecar features degrade gracefully when unavailable.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { describeError } from "../pi/backend";

export type SidecarStatus = "starting" | "healthy" | "degraded" | "stopped";

export interface SearchHit {
	session_id: string | null;
	entry_id: string;
	role: string;
	snippet: string;
	cwd: string | null;
	session_name: string | null;
}

export interface SidecarOptions {
	appSupportDir: string;
	agentDir: string;
	onStatus(status: SidecarStatus): void;
	log?(level: "info" | "warn" | "error", message: string): void;
}

const MAX_RESTARTS = 3;

/** electron import can be unavailable in unit tests. */
function isPackagedSafe(): boolean {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const electron = require("electron") as { app?: { isPackaged?: boolean } };
		return electron.app?.isPackaged === true;
	} catch {
		return false;
	}
}

function resourcesPathSafe(): string {
	if (typeof process.resourcesPath === "string") return process.resourcesPath;
	try {
		const electron = require("electron") as { app: { getAppPath(): string } };
		return electron.app.getAppPath();
	} catch {
		return process.cwd();
	}
}

export class SidecarManager {
	private readonly options: SidecarOptions;
	private proc: ChildProcess | null = null;
	private token = randomUUID();
	private port = 0;
	private status: SidecarStatus = "stopped";
	private restarts = 0;
	private healthTimer: NodeJS.Timeout | null = null;
	private stderrTail: string[] = [];
	private stoppedByUs = false;

	constructor(options: SidecarOptions) {
		this.options = options;
	}

	get currentStatus(): SidecarStatus {
		return this.status;
	}

	async start(): Promise<void> {
		if (this.status === "healthy" || this.proc !== null) return;
		this.stoppedByUs = false;
		this.token = randomUUID();
		this.port = await this.findFreePort();
		const launch = this.resolveLaunch();
		if (launch === null) {
			this.setStatus("degraded");
			this.log("warn", "sidecar binary not found; search/analytics disabled");
			return;
		}
		try {
			this.proc = spawn(launch.command, launch.args, {
				cwd: launch.cwd,
				env: {
					...process.env,
					PI_DESKTOP_DB: path.join(this.options.appSupportDir, "pidesktop.db"),
					PI_DESKTOP_AGENT_DIR: this.options.agentDir,
					PI_DESKTOP_TOKEN: this.token,
				},
				stdio: ["ignore", "ignore", "pipe"],
			});
		} catch (error) {
			this.proc = null;
			this.setStatus("degraded");
			this.log("error", `sidecar spawn failed: ${describeError(error)}`);
			return;
		}

		this.proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail.push(chunk.toString("utf8"));
			if (this.stderrTail.length > 30) this.stderrTail.shift();
		});
		this.proc.on("exit", (code) => {
			this.proc = null;
			if (this.stoppedByUs) return;
			this.setStatus("degraded");
			this.scheduleRestart(`exited (code=${String(code)}) stderr: ${this.tail()}`);
		});

		this.startHealthPolling();
	}

	async stop(): Promise<void> {
		this.stoppedByUs = true;
		if (this.healthTimer !== null) clearInterval(this.healthTimer);
		this.healthTimer = null;
		const child = this.proc;
		this.proc = null;
		this.setStatus("stopped");
		if (child === null || child.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}

	/** Authenticated GET. Returns null when sidecar is unavailable. */
	async get<T>(pathName: string, query?: Record<string, string>): Promise<T | null> {
		return this.request<T>("GET", pathName, undefined, query);
	}

	/** Authenticated POST. Returns null when sidecar is unavailable. */
	async post<T>(pathName: string): Promise<T | null> {
		return this.request<T>("POST", pathName);
	}

	async search(query: string, limit = 50): Promise<SearchHit[] | null> {
		return this.get<SearchHit[]>("/search", { q: query, limit: String(limit) });
	}

	private async request<T>(
		method: "GET" | "POST",
		pathName: string,
		body?: unknown,
		query?: Record<string, string>
	): Promise<T | null> {
		if (this.status !== "healthy" || this.port === 0) return null;
		try {
			const url = new URL(`http://127.0.0.1:${this.port}${pathName}`);
			for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
			const response = await fetch(url, {
				method,
				headers: { "X-Pi-Desktop-Token": this.token },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(5_000),
			});
			if (!response.ok) return null;
			return (await response.json()) as T;
		} catch {
			return null;
		}
	}

	private resolveLaunch(): { command: string; args: string[]; cwd: string } | null {
		const binOverride = process.env.PI_DESKTOP_SIDECAR_BIN;
		if (binOverride !== undefined && existsSync(binOverride)) {
			return {
				command: binOverride,
				args: ["--port", String(this.port), "--host", "127.0.0.1", "--log-level", "warning"],
				cwd: process.cwd(),
			};
		}
		// Packaged app: PyInstaller binary shipped via extraResources.
		if (isPackagedSafe()) {
			const bundled = path.join(resourcesPathSafe(), "sidecar", "pi-desktop-sidecar");
			if (existsSync(bundled)) {
				return {
					command: bundled,
					args: ["--port", String(this.port), "--host", "127.0.0.1", "--log-level", "warning"],
					cwd: resourcesPathSafe(),
				};
			}
		}
		const root = process.cwd();
		const uvicorn = path.join(root, "sidecar/.venv/bin/uvicorn");
		const appDir = path.join(root, "sidecar");
		if (existsSync(uvicorn)) {
			return {
				command: uvicorn,
				args: [
					"app.main:app",
					"--port",
					String(this.port),
					"--host",
					"127.0.0.1",
					"--log-level",
					"warning",
				],
				cwd: appDir,
			};
		}
		return null;
	}

	private startHealthPolling(): void {
		this.setStatus("starting");
		const poll = async (): Promise<void> => {
			try {
				const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
					signal: AbortSignal.timeout(2_000),
				});
				if (response.ok) {
					this.restarts = 0;
					this.setStatus("healthy");
					return;
				}
			} catch {
				// not up yet
			}
		};
		void poll();
		this.healthTimer = setInterval(() => void poll(), 2_000);
		this.healthTimer.unref?.();
	}

	private scheduleRestart(reason: string): void {
		if (this.restarts >= MAX_RESTARTS) {
			this.log("error", `sidecar gave up after ${MAX_RESTARTS} restarts; last: ${reason}`);
			this.setStatus("degraded");
			return;
		}
		this.restarts += 1;
		const delay = Math.min(30_000, 1_000 * 2 ** this.restarts);
		this.log("warn", `sidecar died (${reason}); restarting in ${delay}ms`);
		setTimeout(() => void this.start(), delay);
	}

	private setStatus(status: SidecarStatus): void {
		if (this.status === status) return;
		this.status = status;
		this.options.onStatus(status);
	}

	private log(level: "info" | "warn" | "error", message: string): void {
		this.options.log?.(level, message);
	}

	private tail(): string {
		return this.stderrTail.join("").slice(-300);
	}

	private async findFreePort(): Promise<number> {
		const net = await import("node:net");
		return new Promise((resolve, reject) => {
			const server = net.createServer();
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (address === null || typeof address === "string") {
					server.close();
					reject(new Error("failed to find free port"));
					return;
				}
				const port = address.port;
				server.close(() => resolve(port));
			});
			server.on("error", reject);
		});
	}
}
