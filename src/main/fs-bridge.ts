/**
 * Safe filesystem bridge for the workspace explorer.
 *
 * All paths must resolve inside a registered project root; traversal outside
 * is rejected. Known-heavy directories are filtered from listings. Reads were
 * the only operation until the workspace editor added `writeFile`, which is
 * held to the same containment rule.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const DENY_LIST = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	"__pycache__",
	".venv",
	"venv",
]);

const MAX_READ_BYTES = 1_000_000;
const MAX_WRITE_BYTES = 1_000_000;
const MAX_LIST_ENTRIES = 2_000;

export interface FsEntry {
	name: string;
	type: "dir" | "file";
	size: number;
}

export class FileBridge {
	private readonly roots = new Set<string>();

	setRoots(roots: string[]): void {
		this.roots.clear();
		for (const root of roots) this.roots.add(path.resolve(root));
	}

	getRoots(): string[] {
		return [...this.roots];
	}

	/** Throws when path escapes all roots (virtual-path pre-check). */
	resolveScoped(target: string): string {
		this.assertInside(this.rootsVirtual(), path.resolve(target));
		return path.resolve(target);
	}

	private rootsVirtual(): Set<string> {
		return this.roots;
	}

	private assertInside(roots: Iterable<string>, resolved: string): void {
		for (const root of roots) {
			const rel = path.relative(root, resolved);
			if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
				return;
			}
		}
		throw new Error(`path outside registered project roots: ${resolved}`);
	}

	/**
	 * Canonicalize (resolving symlinks) then verify containment. Use for every
	 * actual filesystem access so symlinked escapes are rejected.
	 */
	async assertRealScoped(target: string): Promise<string> {
		let real = target;
		try {
			real = await fs.realpath(path.resolve(target));
		} catch {
			// Missing target: still reject if the virtual path is outside a root.
			this.resolveScoped(target);
			throw new Error(`path not accessible: ${target}`);
		}
		// Roots themselves may be symlinked (e.g. /tmp → /private/tmp on macOS).
		const realRoots: string[] = [];
		for (const root of this.roots) {
			try {
				realRoots.push(await fs.realpath(root));
			} catch {
				realRoots.push(path.resolve(root));
			}
		}
		this.assertInside(realRoots, real);
		return real;
	}

	async list(dirPath: string): Promise<FsEntry[]> {
		const scoped = await this.assertRealScoped(dirPath);
		const dirents = await fs.readdir(scoped, { withFileTypes: true });
		const entries: FsEntry[] = [];
		for (const dirent of dirents) {
			if (DENY_LIST.has(dirent.name)) continue;
			if (dirent.name.startsWith(".") && dirent.name !== ".pi") continue;
			let size = 0;
			if (dirent.isFile()) {
				try {
					size = (await fs.stat(path.join(scoped, dirent.name))).size;
				} catch {
					size = 0;
				}
			}
			entries.push({
				name: dirent.name,
				type: dirent.isDirectory() ? "dir" : "file",
				size,
			});
		}
		entries.sort((a, b) => {
			if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		return entries.slice(0, MAX_LIST_ENTRIES);
	}

	async readFile(filePath: string): Promise<{ content: string; truncated: boolean }> {
		const scoped = await this.assertRealScoped(filePath);
		const stat = await fs.stat(scoped);
		if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);
		const content = await fs.readFile(scoped, { encoding: "utf8", flag: "r" });
		return {
			content: content.slice(0, MAX_READ_BYTES),
			truncated: stat.size > MAX_READ_BYTES,
		};
	}

	/**
	 * Overwrite an existing file inside a registered root.
	 *
	 * Containment uses the same realpath canonicalization as reads, so a
	 * symlink pointing outside the project is rejected rather than followed.
	 * Deliberately refuses to create new files: the editor only saves what the
	 * explorer opened, which keeps this from becoming a general write primitive
	 * (`assertRealScoped` throws on a missing target anyway).
	 *
	 * The write is atomic — content goes to a temp file in the same directory
	 * and is renamed over the original. A crash or full disk mid-write leaves
	 * the original file intact instead of truncated.
	 */
	async writeFile(filePath: string, content: string): Promise<{ bytes: number }> {
		const scoped = await this.assertRealScoped(filePath);
		const stat = await fs.stat(scoped);
		if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);

		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > MAX_WRITE_BYTES) {
			throw new Error(
				`file too large to save: ${bytes} bytes exceeds the ${MAX_WRITE_BYTES} byte limit`
			);
		}

		// Same directory keeps the rename on one filesystem (cross-device
		// rename fails with EXDEV) and inherits the directory's permissions.
		const tmp = path.join(
			path.dirname(scoped),
			`.${path.basename(scoped)}.pidesktop-${randomUUID().slice(0, 8)}.tmp`
		);
		try {
			await fs.writeFile(tmp, content, { encoding: "utf8", mode: stat.mode });
			await fs.rename(tmp, scoped);
		} catch (err) {
			await fs.rm(tmp, { force: true }).catch(() => undefined);
			throw err;
		}
		return { bytes };
	}
}
