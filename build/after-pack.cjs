/**
 * electron-builder afterPack hook: restore node-pty's spawn-helper exec bit.
 *
 * node-pty 1.1.0 publishes the macOS prebuilds with `spawn-helper` at mode 644
 * (microsoft/node-pty#850). electron-builder copies node_modules verbatim into
 * the asar-unpacked directory, so a packaged build inherits the broken mode and
 * every terminal fails with "posix_spawnp failed" on the user's machine.
 *
 * The app also repairs this at runtime, but a packaged app's Resources live in
 * a read-only location for some install layouts, so fixing it at pack time is
 * the reliable half of the belt-and-braces.
 */
const { chmodSync, existsSync, statSync } = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
	const { appOutDir, packager, electronPlatformName } = context;
	if (electronPlatformName === "win32") return;

	const appName = packager.appInfo.productFilename;
	const resources =
		electronPlatformName === "darwin"
			? path.join(appOutDir, `${appName}.app`, "Contents", "Resources")
			: path.join(appOutDir, "resources");

	const base = path.join(resources, "app.asar.unpacked", "node_modules", "node-pty");
	const candidates = [
		path.join(base, "build", "Release", "spawn-helper"),
		path.join(base, "prebuilds", `${process.platform}-arm64`, "spawn-helper"),
		path.join(base, "prebuilds", `${process.platform}-x64`, "spawn-helper"),
	];

	let fixed = 0;
	for (const helper of candidates) {
		if (!existsSync(helper)) continue;
		// eslint-disable-next-line no-bitwise
		if ((statSync(helper).mode & 0o111) !== 0) continue;
		chmodSync(helper, 0o755);
		fixed += 1;
		console.log(`  • afterPack: chmod 755 ${path.relative(appOutDir, helper)}`);
	}
	if (fixed === 0) {
		console.log("  • afterPack: spawn-helper already executable (or not bundled)");
	}
};
