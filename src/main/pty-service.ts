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
/** Sanity bounds for renderer-supplied terminal dimensions (audit 6 L-2). */
const MAX_COLS = 500;
const MAX_ROWS = 200;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * In-flight spawn reservation. One record per create() call: flagging the
 * RECORD (not the id) is what keeps a kill from leaking across the StrictMode
 * replace window — a replacement create owns a fresh record, and the old
 * create's cleanup must never touch it (audit 6 L-8).
 */
interface PtyReservation {
	abandoned: boolean;
}

/** Clamp a renderer-supplied grid dimension into a sane range. */
function clampDimension(value: unknown, fallback: number, max: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.min(Math.max(n, 1), max);
}

/**
 * Shape guard + normalization for pty:create (audit 6 L-2). The pty channels
 * bypass the typebox-validated request router, so payloads are untrusted:
 * `ipcRenderer.send("pty:create", null)` used to throw uncaught in main, and
 * cols/rows went straight into node-pty unchecked.
 */
function parseCreateRequest(req: unknown): PtyCreateRequest | null {
	if (typeof req !== "object" || req === null) return null;
	const r = req as { id?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown };
	if (typeof r.id !== "string" || !ID_PATTERN.test(r.id)) return null;
	if (typeof r.cwd !== "string" || r.cwd.length === 0) return null;
	return {
		id: r.id,
		cwd: r.cwd,
		cols: clampDimension(r.cols, 80, MAX_COLS),
		rows: clampDimension(r.rows, 24, MAX_ROWS),
	};
}

export class PtyService {
	private readonly terms = new Map<string, IPty>();
	/**
	 * Ids whose spawn is in flight, keyed to a per-create reservation record.
	 * `create` is async, so without a synchronous reservation two rapid calls
	 * for the same id (React StrictMode mounts every effect twice in dev) both
	 * pass the `terms.has` check and spawn a real shell each — one of which is
	 * then untracked and never killed.
	 */
	private readonly starting = new Map<string, PtyReservation>();
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
		ipcMain.on("pty:create", (event, req: unknown) => {
			const parsed = parseCreateRequest(req);
			if (parsed === null) {
				this.log("warn", "pty:create rejected malformed payload");
				return;
			}
			void this.create(parsed.id, parsed.cwd, parsed.cols, parsed.rows);
			void event; // ack arrives via data events
		});
		ipcMain.on("pty:write", (_event, req: unknown) => {
			const r = req as { id?: unknown; data?: unknown } | null;
			if (r === null || typeof r !== "object") return;
			if (typeof r.id !== "string" || typeof r.data !== "string") return;
			this.terms.get(r.id)?.write(r.data);
		});
		ipcMain.on("pty:resize", (_event, req: unknown) => {
			const r = req as { id?: unknown; cols?: unknown; rows?: unknown } | null;
			if (r === null || typeof r !== "object" || typeof r.id !== "string") return;
			try {
				this.terms
					.get(r.id)
					?.resize(clampDimension(r.cols, 80, MAX_COLS), clampDimension(r.rows, 24, MAX_ROWS));
			} catch (error) {
				this.log("warn", `pty resize failed: ${String(error)}`);
			}
		});
		ipcMain.on("pty:kill", (_event, req: unknown) => {
			const r = req as { id?: unknown } | null;
			if (r === null || typeof r !== "object" || typeof r.id !== "string") return;
			this.dispose(r.id);
		});
	}

	private send(id: string, data: string): void {
		const wc = this.webContents();
		if (wc !== null && !wc.isDestroyed()) wc.send(`pty:data:${id}`, data);
	}

	private async create(id: string, cwd: string, cols: number, rows: number): Promise<void> {
		// Synchronous reservation: everything below the starting.set may await,
		// and a second create() for the same id must not race past the check. A
		// create() that lands while one is in flight REPLACES it (StrictMode
		// remount does exactly this: mount → cleanup-kill → mount again with
		// the same id). Flagging the in-flight reservation abandoned makes THAT
		// spawn exit silently when its shell arrives, and lets THIS call own
		// the id — dropping this call instead left the renderer's xterm
		// orphaned with no live process behind it ("cannot type", no output).
		if (this.terms.has(id)) return;
		const previous = this.starting.get(id);
		if (previous !== undefined) {
			previous.abandoned = true;
			this.starting.delete(id);
		}
		// Cap counts live AND in-flight terminals (audit 6 L-8): the spawn
		// awaits a dynamic import, so a cold-start burst otherwise sails past a
		// terms.size-only check before any terminal lands.
		if (this.terms.size + this.starting.size >= MAX_TERMINALS) {
			this.send(id, `\r\n[terminal limit reached (${String(MAX_TERMINALS)})]\r\n`);
			return;
		}
		const reservation: PtyReservation = { abandoned: false };
		this.starting.set(id, reservation);
		try {
			// No fallback cwd (audit 6 L-2): the old code retried with "/tmp",
			// which is never a registered root, so it rethrew anyway — the outer
			// catch surfaces the failure in the terminal either way.
			const scoped = this.resolveScoped(cwd);
			const pty = await import("node-pty");
			const shell = process.env.SHELL || "/bin/zsh";
			// posix_spawnp fails if env contains undefined values — sanitize.
			// npm_config_* variables are also dropped here: `npm run dev` exports
			// npm_config_prefix (from the node install's etc/npmrc), which leaks
			// into every login shell we spawn and makes nvm print its
			// "not compatible with npm_config_prefix" warning on startup.
			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (value === undefined) continue;
				if (key.startsWith("npm_config_")) continue;
				env[key] = value;
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

			// The panel may have unmounted (or been replaced) while we were
			// awaiting the import or repairing the helper; without this the
			// shell leaks untracked.
			if (reservation.abandoned) {
				try {
					term.kill();
				} catch {
					// already gone
				}
				return;
			}

			this.terms.set(id, term);
			term.onData((data) => this.send(id, data));
			term.onExit(({ exitCode }) => {
				this.send(id, `\r\n[exit ${String(exitCode)}]\r\n`);
				this.terms.delete(id);
			});
		} catch (error) {
			this.log("error", `pty create failed: ${String(error)}`);
			// Surface the failure in the terminal surface instead of silence.
			this.send(id, `\r\n[terminal failed to start: ${String(error).slice(0, 200)}]\r\n`);
		} finally {
			// Release only OUR reservation. A replacement create owns the id now;
			// deleting its marker would lose a kill that arrives while it is
			// still spawning (audit 6 L-8).
			if (this.starting.get(id) === reservation) this.starting.delete(id);
		}
	}

	dispose(id: string): void {
		const term = this.terms.get(id);
		if (term === undefined) {
			// Killed before the spawn finished: flag the reservation so create()
			// reaps the shell as soon as it exists.
			const reservation = this.starting.get(id);
			if (reservation !== undefined) reservation.abandoned = true;
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
		// Flag in-flight spawns too: a shell that arrives after the window is
		// gone (or during quit) must be reaped, not orphaned.
		for (const reservation of this.starting.values()) reservation.abandoned = true;
	}
}
