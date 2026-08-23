import { describe, expect, it } from "vitest";
import { sortProjects, type SortableProject } from "../../src/renderer/src/lib/project-sort";

function row(name: string, opts: Partial<SortableProject> = {}): SortableProject {
	return {
		name,
		pinned: false,
		pinnedAt: 0,
		lastActivity: 100,
		...opts,
	};
}

describe("sortProjects", () => {
	it("returns an empty list unchanged", () => {
		expect(sortProjects([], "recent")).toEqual([]);
	});

	it("recent sorts by lastActivity descending", () => {
		const rows = [row("old", { lastActivity: 1 }), row("new", { lastActivity: 9 })];
		expect(sortProjects(rows, "recent").map((r) => r.name)).toEqual(["new", "old"]);
	});

	it("name sorts alphabetically", () => {
		const rows = [row("zeta"), row("alpha"), row("mango")];
		expect(sortProjects(rows, "name").map((r) => r.name)).toEqual([
			"alpha",
			"mango",
			"zeta",
		]);
	});

	it("pinned mode keeps only pin order (pin time desc)", () => {
		const rows = [
			row("a", { pinned: true, pinnedAt: 100 }),
			row("b", { pinned: true, pinnedAt: 200 }),
		];
		expect(sortProjects(rows, "pinned").map((r) => r.name)).toEqual(["b", "a"]);
	});

	it("pinned projects float first in every mode", () => {
		const rows = [
			row("zzz", { pinned: true, pinnedAt: 50 }),
			row("aaa", { lastActivity: 999 }),
		];
		for (const mode of ["recent", "name", "pinned"] as const) {
			expect(sortProjects(rows, mode).map((r) => r.name)).toEqual(["zzz", "aaa"]);
		}
	});

	it("multiple pins order by pin time desc even under name mode", () => {
		const rows = [
			row("beta", { pinned: true, pinnedAt: 100 }),
			row("alpha", { pinned: true, pinnedAt: 300 }),
		];
		expect(sortProjects(rows, "name").map((r) => r.name)).toEqual(["alpha", "beta"]);
	});
});
