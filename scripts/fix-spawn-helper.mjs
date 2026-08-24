#!/usr/bin/env node
/**
 * Restore the execute bit on node-pty's spawn-helper.
 *
 * node-pty 1.1.0 publishes the macOS prebuilds with `spawn-helper` at mode 644
 * (microsoft/node-pty#850, fixed upstream only in the 1.2.0 betas). Without the
 * bit, node-pty cannot exec the helper and every terminal fails with the
 * opaque "posix_spawnp failed."
 *
 * Run after any `npm install` that touches node-pty:  npm run fix:pty
 *
 * The app repairs this itself at boot and again on spawn failure, so this
 * script is for keeping a dev checkout tidy and for CI, not a hard dependency.
 */
import { chmodSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = path.join(root, "node_modules", "node-pty");

if (process.platform === "win32") {
	console.log("fix:pty — windows has no spawn-helper, nothing to do");
	process.exit(0);
}

const candidates = [
	path.join(base, "build", "Release", "spawn-helper"),
	path.join(base, "build", "Debug", "spawn-helper"),
	path.join(base, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
	path.join(base, "prebuilds", `${process.platform}-arm64`, "spawn-helper"),
	path.join(base, "prebuilds", `${process.platform}-x64`, "spawn-helper"),
];

let found = 0;
let fixed = 0;
for (const helper of [...new Set(candidates)]) {
	if (!existsSync(helper)) continue;
	found += 1;
	const mode = statSync(helper).mode;
	if ((mode & 0o111) !== 0) continue;
	chmodSync(helper, 0o755);
	fixed += 1;
	console.log(`fix:pty — chmod 755 ${path.relative(root, helper)}`);
}

if (found === 0) {
	console.log("fix:pty — no spawn-helper found (is node-pty installed?)");
} else if (fixed === 0) {
	console.log(`fix:pty — ${found} spawn-helper binary(ies) already executable`);
}
