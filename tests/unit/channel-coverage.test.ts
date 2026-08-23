/**
 * Channel coverage (audit L-4 / C-2 follow-up): every IPC channel defined in
 * the contract must have at least one renderer caller, or sit on an explicit
 * allowlist with a documented reason. This is the lint that keeps "implemented
 * but unreachable" channels — audit finding C-2's 13 dead surfaces — from
 * quietly accumulating again.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { piRequestSchemas } from "../../src/shared/pi";

/** Collect every renderer source file as text. */
function rendererFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...rendererFiles(full));
		else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
			out.push(readFileSync(full, "utf8"));
		}
	}
	return out;
}

/**
 * Channels deliberately without a direct renderer caller. Each entry needs a
 * reason; deleting a channel here without wiring UI will fail this test.
 */
const ALLOWLIST: Record<string, string> = {
	// The composer routes both through session.prompt + streamingBehavior;
	// these are dead surface kept until a deliberate deletion (audit C-2 note).
	"session.steer": "composer routes steering through session.prompt(streamingBehavior)",
	"session.follow_up": "composer routes follow-ups through session.prompt(streamingBehavior)",
	// Superseded by real selection: the composer's ModelPicker calls
	// session.set_model with an explicit choice, so blind cycling has no UI.
	"session.cycle_model": "superseded by session.set_model via the composer model picker",
	// Append-order entry cursor; the Tree panel uses session.tree instead.
	"session.entries": "internal append-order cursor; tree UI uses session.tree",
	// Superseded by the SQLite-backed db.sessions.* index.
	"session.list": "superseded by db.sessions.search/list",
	// Projects grouping is derived from session rows in the Sidebar; a dedicated
	// projects view is deferred until there is a design for it.
	"db.projects.list": "projects grouping derived from session rows; dedicated view deferred",
	// Context-percentage meter (audit direction #3) is designed but not placed.
	"session.stats": "context meter deferred pending UX placement",
	// The file explorer is scoped to the session cwd; multi-root browsing is
	// deferred until there is a design for it.
	"workspace.roots": "explorer scoped to session cwd; multi-root view deferred",
	// Sidecar health reaches the UI as pushed sidecar_status events; this
	// explicit poll channel stays for eager checks.
	"sidecar.status": "status arrives via pushed sidecar_status events",
};

describe("IPC channel coverage", () => {
	const root = join(import.meta.dirname, "../../src/renderer/src");
	const files = rendererFiles(root);

	it("reads renderer sources", () => {
		if (files.length === 0) throw new Error("no renderer sources found");
	});

	it("every contract channel has a renderer caller or a documented exemption", () => {
		const uncovered: string[] = [];
		for (const channel of Object.keys(piRequestSchemas)) {
			const called = files.some((content) => content.includes(`"${channel}"`));
			if (!called && ALLOWLIST[channel] === undefined) uncovered.push(channel);
		}
		if (uncovered.length > 0) {
			throw new Error(
				`channels with no renderer caller and no allowlist entry: ${uncovered.join(", ")}` +
					"\nEither wire them into the UI or add a reasoned entry to ALLOWLIST."
			);
		}
	});

	it("allowlist entries still exist in the contract", () => {
		for (const channel of Object.keys(ALLOWLIST)) {
			if (!(channel in piRequestSchemas)) {
				throw new Error(`allowlisted channel "${channel}" no longer exists — remove its entry`);
			}
		}
	});
});
