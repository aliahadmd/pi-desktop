/**
 * Theme/CSS polish bundle (audit 6 L-14 + C-2). Source-level pins — these are
 * stylesheet and wiring invariants, the same approach as theme-vars.test.ts
 * and window-wiring.test.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const SRC = join(import.meta.dirname, "../../src/renderer/src");
const INDEX_CSS = readFileSync(join(SRC, "index.css"), "utf8");
const MAIN_TSX = readFileSync(join(SRC, "main.tsx"), "utf8");
const TOPBAR = readFileSync(join(SRC, "components/shell/TopBar.tsx"), "utf8");
const PROJECT_ROW = readFileSync(join(SRC, "components/shell/ProjectRow.tsx"), "utf8");
const DOCK = readFileSync(join(SRC, "components/workspace/Dock.tsx"), "utf8");

describe("window transparency is real (audit 6 C-2)", () => {
	it("data-transparency=on writes --bg-alpha (it previously had no writer)", () => {
		const block = INDEX_CSS.match(/html\[data-transparency="on"\]\s*\{[^}]*\}/);
		expect(block).not.toBeNull();
		expect(block?.[0]).toContain("--bg-alpha");
	});

	it("the base background is scoped to body only — html/#root stay transparent", () => {
		const base = INDEX_CSS.match(/html,\s*\nbody,\s*\n#root\s*\{[^}]*\}/);
		expect(base).not.toBeNull();
		expect(base?.[0]).not.toContain("background");
		const body = INDEX_CSS.match(/(?:^|\n)body\s*\{[^}]*\}/);
		expect(body?.[0]).toContain("background: var(--pi-bg)");
	});
});

describe("theme polish (audit 6 L-14)", () => {
	it("skeleton shimmer follows the theme text token, not hardcoded white", () => {
		const skeleton = INDEX_CSS.match(/\.skeleton\s*\{[^}]*\}/);
		expect(skeleton).not.toBeNull();
		expect(skeleton?.[0]).toContain("var(--pi-text)");
		expect(skeleton?.[0]).not.toContain("rgba(255, 255, 255");
	});

	it("data-theme-dark is consumed: color-scheme follows the preset", () => {
		expect(INDEX_CSS).toContain('html[data-theme-dark="true"]');
		expect(INDEX_CSS).toContain("color-scheme: dark");
		expect(INDEX_CSS).toContain("color-scheme: light");
	});

	it("motion/react honors the OS reduced-motion setting", () => {
		expect(MAIN_TSX).toContain("MotionConfig");
		expect(MAIN_TSX).toContain('reducedMotion="user"');
	});

	it("the top-bar toggle compensates for UI scale instead of a fixed ml-[84px]", () => {
		expect(TOPBAR).not.toContain("ml-[84px]");
		expect(TOPBAR).toContain("uiScale");
	});

	it("hover-only controls are reachable via keyboard focus", () => {
		expect(PROJECT_ROW).toContain("group-focus-within:flex");
		expect(DOCK).toContain("group-focus-within:block");
	});

	it("no text-glyph icons remain in renderer components (lucide-only)", () => {
		const offenders: string[] = [];
		const walk = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
				const full = join(dir, e.name);
				return e.isDirectory() ? walk(full) : e.name.endsWith(".tsx") ? [full] : [];
			});
		for (const file of walk(SRC)) {
			const text = readFileSync(file, "utf8");
			for (const glyph of ["×", "⑂", "←", "▸", "✓", "⚙", "📦"]) {
				if (text.includes(glyph)) offenders.push(`${file}: ${glyph}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

// --- Sidebar pinnedAt (audit 6 L-14) — behavioral half -----------------------

vi.mock("electron", () => ({
	shell: { trashItem: vi.fn(async () => undefined) },
}));

import { IpcRouter } from "../../src/main/ipc/router";
import { StoreService } from "../../src/main/store/service";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

describe("project.list exposes the real pin timestamp (audit 6 L-14)", () => {
	it("pinned projects carry pinnedAt so pinned-sort order is deterministic", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-pinned-at-"));
		tmpDirs.push(dir);
		const store = new StoreService(dir);
		store.start();
		const router = new IpcRouter();
		store.registerHandlers(router);

		const created = (await router.dispatch({ type: "project.create", path: dir })) as {
			ok: true;
			data: { projectId: string };
		};
		expect(created.ok).toBe(true);
		await router.dispatch({ type: "project.pin", projectId: created.data.projectId, pinned: true });

		const list = await router.dispatch({ type: "project.list" });
		expect(list.ok).toBe(true);
		if (list.ok) {
			const projects = (list.data as { projects: Array<{ pinnedAt: number | null }> }).projects;
			const row = projects.find((p) => p.pinnedAt !== null);
			expect(row).toBeDefined();
			expect(typeof row?.pinnedAt).toBe("number");
			expect(row!.pinnedAt!).toBeGreaterThan(0);
		}
	});
});
