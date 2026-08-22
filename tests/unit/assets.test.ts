/**
 * Icon asset integrity (audit C-3). The old tray icon was an inline base64 PNG
 * whose zlib stream was corrupt, so macOS rendered an invisible menu-bar item.
 * These tests fail on exactly that class of breakage.
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");

function pngChunks(buf: Buffer): { ihdr: Buffer; idat: Buffer } {
	// eslint-disable-next-line -- Buffer generics differ between lib versions
	let i = 8;
	let ihdr: Buffer = Buffer.alloc(0);
	const idatParts: Uint8Array[] = [];
	while (i < buf.length) {
		const len = buf.readUInt32BE(i);
		const type = buf.subarray(i + 4, i + 8).toString("ascii");
		const data = buf.subarray(i + 8, i + 8 + len);
		if (type === "IHDR") ihdr = Buffer.from(data);
		if (type === "IDAT") idatParts.push(new Uint8Array(data));
		if (type === "IEND") break;
		i += 12 + len;
	}
	return { ihdr, idat: Buffer.concat(idatParts) };
}

describe("tray icon assets", () => {
	for (const [file, size] of [
		["resources/tray/tray-icon.png", 16],
		["resources/tray/tray-icon@2x.png", 32],
	] as const) {
		it(`${file} decodes and is ${String(size)}x${String(size)}`, () => {
			const buf = readFileSync(join(ROOT, file));
			const { ihdr, idat } = pngChunks(buf);
			expect(ihdr.readUInt32BE(0)).toBe(size);
			expect(ihdr.readUInt32BE(4)).toBe(size);
			// The corrupt original threw here — this is the regression check.
			expect(() => inflateSync(idat)).not.toThrow();
			expect(inflateSync(idat).length).toBeGreaterThan(0);
		});
	}

	it("the app icon source is a 1024x1024 PNG", () => {
		const { ihdr } = pngChunks(readFileSync(join(ROOT, "build/icon.png")));
		expect(ihdr.readUInt32BE(0)).toBe(1024);
		expect(ihdr.readUInt32BE(4)).toBe(1024);
	});

	it("createTray loads from disk, not an inline data URL", () => {
		const src = readFileSync(join(ROOT, "src/main/index.ts"), "utf8");
		expect(src).not.toContain("data:image/png;base64");
		expect(src).toContain("nativeImage.createFromPath");
	});

	it("electron-builder ships the icon and the tray images", () => {
		const yml = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
		expect(yml).toMatch(/^ {2}icon: build\/icon\.icns$/m);
		expect(yml).toContain("to: tray");
	});

	it("no third-party auto-update feed is configured", () => {
		const yml = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
		expect(yml).not.toMatch(/^publish:/m);
		const updater = readFileSync(join(ROOT, "src/main/updater.ts"), "utf8");
		expect(updater).toContain("PI_DESKTOP_ENABLE_UPDATER");
	});
});
