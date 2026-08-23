/**
 * Commands catalog wiring (audit C-1, plan 010).
 *
 * The Commands browser has a detail view keyed on `command.path` that never
 * rendered, because no backend populated the field. These tests pin the pieces
 * that make it reachable: the hint parser, the widened contract, and the RPC
 * mapper's markdown-only path filter.
 */
import { describe, expect, it } from "vitest";
import { mapRpcCommand, type RpcSlashCommand } from "../../src/main/pi/rpc-backend";
import { parseArgumentHintFromHint } from "../../src/renderer/src/lib/command-hints";
import type { PiCommandInfo } from "../../src/shared/pi";

describe("parseArgumentHintFromHint", () => {
	it("returns no placeholders for an empty hint", () => {
		expect(parseArgumentHintFromHint("")).toEqual([]);
		expect(parseArgumentHintFromHint("   ")).toEqual([]);
	});

	it("reads a single bare placeholder", () => {
		expect(parseArgumentHintFromHint("file")).toEqual(["file"]);
	});

	it("splits multiple placeholders", () => {
		expect(parseArgumentHintFromHint("file pattern")).toEqual(["file", "pattern"]);
	});

	it("strips angle and square brackets", () => {
		expect(parseArgumentHintFromHint("<file> [flags]")).toEqual(["file", "flags"]);
	});

	it("keeps a bracketed group with inner spaces as ONE placeholder", () => {
		// Real hint from the installed `/council` prompt template. Splitting on
		// whitespace here produced nine bogus inputs ("--advisors", "name,name",
		// "2|3", "..."), demanding values the command never asked for.
		const hint =
			"<question> [--advisors name,name] [--max-passes 2|3] [--scope ...] [--non-goals ...]";
		expect(parseArgumentHintFromHint(hint)).toEqual([
			"question",
			"--advisors name,name",
			"--max-passes 2|3",
			"--scope ...",
			"--non-goals ...",
		]);
	});

	it("collapses irregular whitespace", () => {
		expect(parseArgumentHintFromHint("  <a>   <b>  ")).toEqual(["a", "b"]);
	});
});

describe("PiCommandInfo contract", () => {
	it("carries optional path and argumentHint", () => {
		// Compile-time assertion: the fields the Dock branches on must exist on
		// the contract, or the detail view silently goes dead again.
		const withDetail: PiCommandInfo = {
			name: "review",
			source: "prompt",
			path: "/a/review.md",
			argumentHint: "<file>",
		};
		const minimal: PiCommandInfo = { name: "bare", source: "extension" };
		expect(withDetail.path).toBe("/a/review.md");
		expect(minimal.path).toBeUndefined();
	});
});

describe("mapRpcCommand", () => {
	function cmd(overrides: Partial<RpcSlashCommand> = {}): RpcSlashCommand {
		return { name: "c", source: "prompt", ...overrides };
	}

	it("passes through markdown source paths", () => {
		const mapped = mapRpcCommand(cmd({ sourceInfo: { path: "/skills/x.md" } }));
		expect(mapped.path).toBe("/skills/x.md");
	});

	it("drops non-markdown paths that resources.read_text would reject", () => {
		// Extension handlers are .ts/.js; promising a detail view here would
		// bounce off the main process's md-only allowlist.
		expect(mapRpcCommand(cmd({ sourceInfo: { path: "/ext/handler.ts" } })).path).toBeUndefined();
		expect(mapRpcCommand(cmd({ sourceInfo: { path: "/ext/handler.js" } })).path).toBeUndefined();
	});

	it("omits path when sourceInfo is absent or empty", () => {
		expect(mapRpcCommand(cmd()).path).toBeUndefined();
		expect(mapRpcCommand(cmd({ sourceInfo: {} })).path).toBeUndefined();
	});

	it("preserves name, source and description", () => {
		const mapped = mapRpcCommand(
			cmd({ name: "deploy", source: "extension", description: "ship it" })
		);
		expect(mapped).toMatchObject({ name: "deploy", source: "extension", description: "ship it" });
	});

	it("omits description rather than emitting undefined", () => {
		// exactOptionalPropertyTypes: an explicit undefined is not the same as
		// an absent key when this crosses the IPC boundary.
		expect(Object.keys(mapRpcCommand(cmd()))).not.toContain("description");
	});
});
