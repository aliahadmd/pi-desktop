/**
 * Bounded fs.read (audit 6 L-7): the file bridge used to read the WHOLE file
 * into memory and then slice to 1 MB — a multi-GB log stalled the main
 * process on click, and the slice counted UTF-16 code units, so a
 * multibyte-heavy file could still return several megabytes of text. Reads
 * are now capped at 1 MB + 1 byte at the syscall level.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBridge } from "../../src/main/fs-bridge";

const MAX_READ_BYTES = 1_000_000;

const tmpDirs: string[] = [];
let bridge: FileBridge;
let root: string;

function setup(): void {
	root = mkdtempSync(join(tmpdir(), "pi-fs-bounded-"));
	tmpDirs.push(root);
	bridge = new FileBridge();
	bridge.setRoots([root]);
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

describe("FileBridge.readFile bounding (audit 6 L-7)", () => {
	it("returns a small file verbatim, not truncated", async () => {
		setup();
		writeFileSync(join(root, "a.txt"), "hello pi");
		const result = await bridge.readFile(join(root, "a.txt"));
		expect(result).toEqual({ content: "hello pi", truncated: false });
	});

	it("caps an oversized ASCII file at 1 MB and marks it truncated", async () => {
		setup();
		writeFileSync(join(root, "big.log"), "x".repeat(MAX_READ_BYTES + 500_000));
		const result = await bridge.readFile(join(root, "big.log"));
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MAX_READ_BYTES);
		expect(result.content.length).toBe(MAX_READ_BYTES);
	});

	it("the cap is in BYTES: multibyte content cannot exceed 1 MB either", async () => {
		setup();
		// 500,001 × "é" (2 bytes) = 1,000,002 bytes on disk; the 1 MB read cap
		// lands exactly on a char boundary. The old char-slice returned
		// 1,000,000 CHARACTERS — 2 MB of text over IPC.
		writeFileSync(join(root, "euro.txt"), "é".repeat(500_001));
		const result = await bridge.readFile(join(root, "euro.txt"));
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MAX_READ_BYTES);
	});

	it("still rejects directories", async () => {
		setup();
		mkdirSync(join(root, "dir"));
		await expect(bridge.readFile(join(root, "dir"))).rejects.toThrow(/not a file/);
	});
});
