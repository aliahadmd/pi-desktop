/**
 * GitService (chapter 16): lightweight per-root git context for the strip
 * above the composer. Cheap commands, short timeout, never throws.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitContext {
	repo: boolean;
	branch: string | null;
	staged: number;
	unstaged: number;
	ahead: number;
	behind: number;
}

const EMPTY: GitContext = {
	repo: false,
	branch: null,
	staged: 0,
	unstaged: 0,
	ahead: 0,
	behind: 0,
};

async function git(root: string, args: string[], timeoutMs = 3_000): Promise<string> {
	const { stdout } = await exec("git", args, {
		cwd: root,
		timeout: timeoutMs,
		maxBuffer: 1024 * 256,
	});
	return stdout;
}

export async function context(root: string): Promise<GitContext> {
	try {
		const branchOut = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
		const branch = branchOut.trim() || null;
		let staged = 0;
		let unstaged = 0;
		try {
			const status = await git(root, ["status", "--porcelain=v2", "--branch"]);
			for (const line of status.split("\n")) {
				if (line.startsWith("1 ") || line.startsWith("2 ")) {
					const xy = line.slice(2, 4);
					const x = xy[0] ?? ".";
					const y = xy[1] ?? ".";
					if (x !== ".") staged += 1;
					if (y !== ".") unstaged += 1;
				} else if (line.startsWith("? ")) {
					unstaged += 1;
				}
			}
		} catch {
			// status is best-effort
		}
		let ahead = 0;
		let behind = 0;
		try {
			const ab = await git(root, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
			const [behindStr, aheadStr] = ab.trim().split("\t");
			ahead = Number(aheadStr ?? 0) || 0;
			behind = Number(behindStr ?? 0) || 0;
		} catch {
			// no upstream
		}
		return { repo: true, branch, staged, unstaged, ahead, behind };
	} catch {
		return EMPTY;
	}
}
