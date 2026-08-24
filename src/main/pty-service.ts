/**
 * PtyService — node-pty terminals for the embedded terminal panel.
 *
 * Uses dedicated ipcMain channels ("pty:*") rather than the request router:
 * terminal data is high-frequency streaming, not request/response. Creation is
 * scoped to registered project roots like the file bridge.
 */
import { ipcMain, type WebContents } from "electron";
import type { IPty } from "node-pty";
import { ensureSpawnHelperExecutable, isSpawnHelperFailure } from "./pty-native";

export interface PtyCreateRequest {
	id: string;
	cwd: string;
	cols: number;
	rows: number;
}

const MAX_TERMINALS = 8;

export class PtyService {
	private readonly terms = new Map<string, IPty>();
	/**
	 * Ids whose spawn is in flight. `create` is async, so without a synchronous
	 * reservation two rapid calls for the same id (React StrictMode mounts every
	 * effect twice in dev) both pass the `terms.has` check and spawn a real
	 * shell each — one of which is then untracked and never killed.
	 */
	private readonly starting = new Set<string>();
	/** Ids killed while their spawn was still in flight; reaped on arrival. */
	private readonly abandoned = new Set<string>();
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
			const id = String(req.id);
			if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
				this.log("warn", `pty:create rejected invalid id pattern`);
				return;
			}
			void this.create(id, String(req.cwd), Number(req.cols) || 80, Number(req.rows) || 24);
			void event; // ack arrives via data events
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
		// Synchronous reservation: everything below this point may await, and a
		// second create() for the same id must not race past the check.
		if (this.terms.has(id) || this.starting.has(id)) return;
		this.starting.add(id);
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
			// posix_spawnp fails if env contains undefined values — sanitize.
			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined) env[key] = value;
			}
			env.TERM = "xterm-256color";
			const spawnTerm = (): IPty =>
				pty.spawn(shell, ["-l"], {
					name: "xterm-256color",
					cols,
					rows,
					cwd: scoped,
					env,
				});

			let term: IPty;
			try {
				term = spawnTerm();
			} catch (error) {
				// node-pty 1.1.0 ships spawn-helper without its execute bit, so
				// the first spawn throws "posix_spawnp failed." Repair the bit
				// and retry once rather than making the user run a build script
				// (see src/main/pty-native.ts).
				if (!isSpawnHelperFailure(error)) throw error;
				const repair = ensureSpawnHelperExecutable();
				if (!repair.repaired) {
					this.log(
						"error",
						`pty spawn failed and spawn-helper could not be repaired (${repair.reason}${
							repair.error !== undefined ? `: ${repair.error}` : ""
						})`
					);
					throw error;
				}
				this.log("warn", `repaired node-pty spawn-helper permissions at ${repair.path ?? "?"}`);
				term = spawnTerm();
			}

			// The panel may have unmounted while we were awaiting the import or
			// repairing the helper; without this the shell leaks untracked.
			if (this.abandoned.has(id)) {
				this.abandoned.delete(id);
				try {
					term.kill();
				} catch {
					// already gone
				}
				return;
			}

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
		} finally {
			this.starting.delete(id);
			this.abandoned.delete(id);
		}
	}

	dispose(id: string): void {
		const term = this.terms.get(id);
		if (term === undefined) {
			// Killed before the spawn finished: mark it so create() reaps the
			// shell as soon as it exists.
			if (this.starting.has(id)) this.abandoned.add(id);
			return;
		}
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
