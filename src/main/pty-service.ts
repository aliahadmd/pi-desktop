/**
 * PtyService — node-pty terminals for the embedded terminal panel.
 *
 * Uses dedicated ipcMain channels ("pty:*") rather than the request router:
 * terminal data is high-frequency streaming, not request/response. Creation is
 * scoped to registered project roots like the file bridge.
 */
import { ipcMain, type WebContents } from "electron";
import type { IPty } from "node-pty";

export interface PtyCreateRequest {
	id: string;
	cwd: string;
	cols: number;
	rows: number;
}

const MAX_TERMINALS = 8;

export class PtyService {
	private readonly terms = new Map<string, IPty>();
	private readonly webContents: () => WebContents | null;
	private readonly resolveScoped: (cwd: string) => string;
	private readonly log: (level: "info" | "warn" | "error", message: string) => void;

	constructor(deps: {
		webContents: () => WebContents | null;
		resolveScoped: (cwd: string) => string;
		log: (level: "info" | "warn" | "error", message: string) => void;
	}) {
		this.webContents = deps.webContents;
		this.resolveScoped = deps.resolveScoped;
		this.log = deps.log;
	}

	register(): void {
		ipcMain.on("pty:create", (event, req: PtyCreateRequest) => {
			void this.create(String(req.id), String(req.cwd), Number(req.cols) || 80, Number(req.rows) || 24);
			event; // ack via data events
		});
		ipcMain.on("pty:write", (_event, req: { id: string; data: string }) => {
			this.terms.get(String(req.id))?.write(String(req.data));
		});
		ipcMain.on("pty:resize", (_event, req: { id: string; cols: number; rows: number }) => {
			try {
				this.terms.get(String(req.id))?.resize(Number(req.cols) || 80, Number(req.rows) || 24);
			} catch (error) {
				this.log("warn", `pty resize failed: ${String(error)}`);
			}
		});
		ipcMain.on("pty:kill", (_event, req: { id: string }) => {
			this.dispose(String(req.id));
		});
	}

	private async create(id: string, cwd: string, cols: number, rows: number): Promise<void> {
		if (this.terms.has(id)) return;
		const send = (data: string): void => {
			const wc = this.webContents();
			if (wc !== null && !wc.isDestroyed()) wc.send(`pty:data:${id}`, data);
		};
		try {
			// Cap concurrent terminals; refuse beyond the limit.
			if (this.terms.size >= MAX_TERMINALS) {
				send(`\r\n[terminal limit reached (${String(MAX_TERMINALS)})]\r\n`);
				return;
			}
			let scoped: string;
			try {
				scoped = this.resolveScoped(cwd);
			} catch {
				scoped = this.resolveScoped("/tmp");
			}
			const pty = await import("node-pty");
			const shell = process.env.SHELL || "/bin/zsh";
			const term = pty.spawn(shell, ["-l"], {
				name: "xterm-256color",
				cols,
				rows,
				cwd: scoped,
				env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
			});
			this.terms.set(id, term);
			term.onData((data) => send(data));
			term.onExit(({ exitCode }) => {
				send(`\r\n[exit ${String(exitCode)}]\r\n`);
				this.terms.delete(id);
			});
		} catch (error) {
			this.log("error", `pty create failed: ${String(error)}`);
			// Surface the failure in the terminal surface instead of silence.
			send(`\r\n[terminal failed to start: ${String(error).slice(0, 200)}]\r\n`);
		}
	}

	dispose(id: string): void {
		const term = this.terms.get(id);
		if (term === undefined) return;
		this.terms.delete(id);
		try {
			term.kill();
		} catch {
			// already dead
		}
	}

	disposeAll(): void {
		for (const id of [...this.terms.keys()]) this.dispose(id);
	}
}
