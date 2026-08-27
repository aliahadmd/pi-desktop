/**
 * Dead/stale contract surface (audit 6 L-3):
 *
 *  - IpcEvent.log was defined but never produced or consumed — deleted.
 *  - ping had no caller anywhere — it is now the boot handshake in main.tsx
 *    (verifies the invoke path and logs main/electron versions).
 *
 * packages.search behavior moved on twice: first the discarded query was
 * wired into an `npm search` shell-out (audit 6 L-3), then the shell-out was
 * replaced by the registry-backed catalog (src/main/pi/package-catalog.ts) —
 * npm CLI search caps results, so the marketplace only saw a sliver of the
 * catalog. Behavioral coverage now lives in packages-catalog.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PROTOCOL_TS = readFileSync(join(import.meta.dirname, "../../src/shared/protocol.ts"), "utf8");
const MAIN_TSX = readFileSync(
	join(import.meta.dirname, "../../src/renderer/src/main.tsx"),
	"utf8",
);

describe("IpcEvent.log removal (audit 6 L-3)", () => {
	it("the dead main→renderer log event is gone from the contract", () => {
		// log_write (renderer→main request) stays; the dead EVENT was "log".
		expect(PROTOCOL_TS).not.toContain('Type.Literal("log")');
		expect(PROTOCOL_TS).not.toContain("RendererLogEvent");
	});
});

describe("ping is wired (audit 6 L-3)", () => {
	it("the renderer pings main at boot as an invoke-path handshake", () => {
		expect(MAIN_TSX).toContain('{ type: "ping" }');
	});
});
