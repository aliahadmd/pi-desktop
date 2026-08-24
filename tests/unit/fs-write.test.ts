/**
 * Security + behavior tests for FileBridge.writeFile (workspace editor).
 *
 * The editor gave the renderer its first write path into the filesystem, so
 * these focus on containment: a write must be confined to a registered project
 * root by the same realpath rules that guard reads, including when a symlink
 * inside the project points out of it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileBridge } from "../../src/main/fs-bridge";

let root: string;
let outside: string;
let bridge: FileBridge;

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "pidesktop-fsw-"));
	outside = mkdtempSync(path.join(os.tmpdir(), "pidesktop-out-"));
	mkdirSync(path.join(root, "src"), { recursive: true });
	writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
	writeFileSync(path.join(outside, "secret.txt"), "original secret\n");
	bridge = new FileBridge();
	bridge.setRoots([root]);
});

describe("FileBridge.writeFile containment", () => {
	it("writes a file inside the root", async () => {
		const target = path.join(root, "src", "index.ts");
		const result = await bridge.writeFile(target, "export const x = 1;\n");
		expect(result.bytes).toBe(20);
		expect(readFileSync(target, "utf8")).toBe("export const x = 1;\n");
	});

	it("rejects an absolute path outside every root", async () => {
		const target = path.join(outside, "secret.txt");
		await expect(bridge.writeFile(target, "pwned")).rejects.toThrow(/outside|not accessible/);
		expect(readFileSync(target, "utf8")).toBe("original secret\n");
	});

	it("rejects traversal out of the root via .. segments", async () => {
		const target = path.join(root, "..", path.basename(outside), "secret.txt");
		await expect(bridge.writeFile(target, "pwned")).rejects.toThrow(/outside|not accessible/);
		expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("original secret\n");
	});

	it("refuses to follow a symlink that escapes the root", async () => {
		// The dangerous case: the virtual path looks contained, but realpath
		// lands outside. Reads already reject this; writes must too, or the
		// editor becomes a way to overwrite any file on disk.
		const link = path.join(root, "escape.txt");
		symlinkSync(path.join(outside, "secret.txt"), link);
		await expect(bridge.writeFile(link, "pwned")).rejects.toThrow(/outside/);
		expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("original secret\n");
	});

	it("allows a root that is itself a symlink (macOS /tmp)", async () => {
		// realpath(/tmp) is /private/tmp on macOS: canonicalizing only the
		// target would wrongly reject every write under a symlinked root.
		const realRoot = realpathSync(root);
		if (realRoot === root) {
			// Construct the case explicitly when tmpdir is not symlinked.
			const linkRoot = path.join(outside, "linked-root");
			symlinkSync(root, linkRoot);
			bridge.setRoots([linkRoot]);
		}
		const target = path.join(root, "src", "index.ts");
		await expect(bridge.writeFile(target, "ok\n")).resolves.toEqual({ bytes: 3 });
	});

	it("rejects creating a new file that does not exist", async () => {
		// writeFile only saves what the explorer opened; it is not a general
		// file-creation primitive.
		const target = path.join(root, "src", "brand-new.ts");
		await expect(bridge.writeFile(target, "hi")).rejects.toThrow(/not accessible/);
	});

	it("rejects writing to a directory", async () => {
		await expect(bridge.writeFile(path.join(root, "src"), "hi")).rejects.toThrow(/not a file/);
	});

	it("rejects content over the size ceiling", async () => {
		const target = path.join(root, "src", "index.ts");
		const huge = "x".repeat(1_000_001);
		await expect(bridge.writeFile(target, huge)).rejects.toThrow(/too large/);
		expect(readFileSync(target, "utf8")).toBe("export {};\n");
	});
});

describe("FileBridge.writeFile behavior", () => {
	it("counts bytes, not characters, for multi-byte content", async () => {
		const target = path.join(root, "src", "index.ts");
		const result = await bridge.writeFile(target, "café 🎉");
		expect(result.bytes).toBe(Buffer.byteLength("café 🎉", "utf8"));
		expect(readFileSync(target, "utf8")).toBe("café 🎉");
	});

	it("preserves the original file mode", async () => {
		const target = path.join(root, "src", "exec.sh");
		writeFileSync(target, "#!/bin/sh\n");
		chmodSync(target, 0o755);
		await bridge.writeFile(target, "#!/bin/sh\necho hi\n");
		expect(statSync(target).mode & 0o777).toBe(0o755);
	});

	it("leaves no temp files behind on success", async () => {
		await bridge.writeFile(path.join(root, "src", "index.ts"), "clean\n");
		const leftovers = readdirSync(path.join(root, "src")).filter((n) => n.includes("pidesktop-"));
		expect(leftovers).toEqual([]);
	});

	it("round-trips through readFile", async () => {
		const target = path.join(root, "src", "index.ts");
		await bridge.writeFile(target, "const roundTrip = true;\n");
		const read = await bridge.readFile(target);
		expect(read.content).toBe("const roundTrip = true;\n");
		expect(read.truncated).toBe(false);
	});
});
