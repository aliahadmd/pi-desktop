/**
 * Registry-backed package catalog (src/main/pi/package-catalog.ts):
 *
 *  - The catalog source is the npm registry `/-/v1/search` endpoint with the
 *    `pi-package` keyword — the same data pi.dev/packages is built from.
 *  - No query → the FULL catalog, paginated (size=250) to exhaustion and
 *    sorted by monthly downloads, cached for 30 minutes.
 *  - A query narrows the registry search (one relevance-ranked page).
 *  - Fields map through: name/description/version/publisher/date plus
 *    monthly downloads and keywords (the marketplace kind chips derive
 *    from keywords).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearPackageCatalogCache,
	searchPiPackageCatalog,
	setPackageCatalogCacheFile,
} from "../../src/main/pi/package-catalog";

interface FetchCall {
	url: string;
}

const fetchCalls: FetchCall[] = [];

function makeObject(name: string, overrides?: {
	description?: string;
	version?: string;
	publisher?: string;
	date?: string;
	downloads?: number;
	keywords?: string[];
}) {
	return {
		downloads: { monthly: overrides?.downloads ?? 0 },
		package: {
			name,
			description: overrides?.description,
			version: overrides?.version,
			publisher: overrides?.publisher !== undefined ? { username: overrides.publisher } : undefined,
			date: overrides?.date,
			keywords: overrides?.keywords,
		},
	};
}

/** Queue a successful search response page. */
function queuePage(total: number, objects: Array<ReturnType<typeof makeObject>>): void {
	pages.push({ total, objects });
}

/** Queue a raw failure response (e.g. a 429 to exercise retry/backoff). */
function queueRaw(status: number, headers?: Record<string, string>): void {
	rawResponses.push(new Response("rate limited", { status, ...(headers !== undefined && { headers }) }));
}

const pages: Array<{ total: number; objects: Array<ReturnType<typeof makeObject>> }> = [];
const rawResponses: Response[] = [];

beforeEach(() => {
	fetchCalls.length = 0;
	pages.length = 0;
	rawResponses.length = 0;
	clearPackageCatalogCache();
	vi.stubGlobal("fetch", async (input: unknown) => {
		const url = String(input);
		fetchCalls.push({ url });
		const raw = rawResponses.shift();
		if (raw !== undefined) return raw;
		const page = pages.shift();
		if (page === undefined) {
			return new Response("not found", { status: 404 });
		}
		return new Response(JSON.stringify(page), { status: 200 });
	});
});

describe("searchPiPackageCatalog — full catalog (no query)", () => {
	it("paginates with size=250 until the reported total is exhausted", async () => {
		const firstPage = Array.from({ length: 250 }, (_, i) => makeObject(`pkg-${i}`));
		queuePage(300, firstPage);
		queuePage(300, Array.from({ length: 50 }, (_, i) => makeObject(`pkg-${250 + i}`)));

		const results = await searchPiPackageCatalog();

		expect(results).toHaveLength(300);
		expect(fetchCalls).toHaveLength(2);
		expect(fetchCalls[0]!.url).toContain("size=250&from=0");
		expect(fetchCalls[1]!.url).toContain("size=250&from=250");
		expect(fetchCalls[0]!.url).toContain(`text=${encodeURIComponent("keywords:pi-package")}`);
	});

	it("sorts the catalog by monthly downloads descending (pi.dev order)", async () => {
		queuePage(3, [
			makeObject("low", { downloads: 5 }),
			makeObject("high", { downloads: 9000 }),
			makeObject("mid", { downloads: 500 }),
		]);
		const results = await searchPiPackageCatalog();
		expect(results.map((r) => r.name)).toEqual(["high", "mid", "low"]);
	});

	it("maps downloads and keywords through for the marketplace UI", async () => {
		queuePage(1, [
			makeObject("pi-thing", {
				description: "a thing",
				version: "1.2.3",
				publisher: "someone",
				date: "2026-01-01",
				downloads: 628192,
				keywords: ["pi-package", "extension"],
			}),
		]);
		const [r] = await searchPiPackageCatalog();
		expect(r).toEqual({
			name: "pi-thing",
			description: "a thing",
			version: "1.2.3",
			publisher: "someone",
			date: "2026-01-01",
			downloads: 628192,
			keywords: ["pi-package", "extension"],
		});
	});

	it("serves the second call from cache (no re-fetch within the TTL)", async () => {
		queuePage(1, [makeObject("pkg")]);
		await searchPiPackageCatalog();
		await searchPiPackageCatalog();
		expect(fetchCalls).toHaveLength(1);
	});

	it("re-fetches after the cache is cleared", async () => {
		queuePage(1, [makeObject("pkg")]);
		await searchPiPackageCatalog();
		clearPackageCatalogCache();
		queuePage(1, [makeObject("pkg")]);
		await searchPiPackageCatalog();
		expect(fetchCalls).toHaveLength(2);
	});
});

describe("searchPiPackageCatalog — query search", () => {
	it("appends the query to the keyword search and skips pagination/cache", async () => {
		queuePage(1, [makeObject("lint-pkg")]);
		const results = await searchPiPackageCatalog("lint");
		expect(results.map((r) => r.name)).toEqual(["lint-pkg"]);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]!.url).toContain(`text=${encodeURIComponent("keywords:pi-package lint")}`);
	});

	it("treats a whitespace-only query as absent (full catalog path)", async () => {
		queuePage(1, [makeObject("pkg")]);
		await searchPiPackageCatalog("   ");
		expect(fetchCalls[0]!.url).toContain(`text=${encodeURIComponent("keywords:pi-package")}`);
	});
});

describe("searchPiPackageCatalog — failure", () => {
	it("throws an HTTP status error the router wraps as internal_error", async () => {
		// No page queued → stub returns 404 (non-retryable → immediate).
		await expect(searchPiPackageCatalog("x")).rejects.toThrow("npm registry search failed: HTTP 404");
	});
});

describe("searchPiPackageCatalog — rate limiting (429)", () => {
	it("retries a 429 with backoff and then succeeds", async () => {
		queueRaw(429, { "retry-after": "1" });
		queuePage(1, [makeObject("pkg")]);
		const results = await searchPiPackageCatalog("x");
		expect(results.map((r) => r.name)).toEqual(["pkg"]);
		expect(fetchCalls).toHaveLength(2);
	});

	it("gives up after the retry budget is exhausted", async () => {
		vi.useFakeTimers();
		try {
			for (let i = 0; i < 10; i++) queueRaw(429);
			const pending = searchPiPackageCatalog("x");
			const assertion = expect(pending).rejects.toThrow("npm registry search failed: HTTP 429");
			await vi.advanceTimersByTimeAsync(60_000);
			await assertion;
			// 1 initial + MAX_RETRIES (4) retries.
			expect(fetchCalls).toHaveLength(5);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("searchPiPackageCatalog — disk cache", () => {
	function tempCacheFile(): { dir: string; file: string } {
		const dir = mkdtempSync(join(tmpdir(), "pi-catalog-test-"));
		return { dir, file: join(dir, "catalog.json") };
	}

	it("serves a fresh disk cache without touching the network", async () => {
		const { dir, file } = tempCacheFile();
		try {
			writeFileSync(
				file,
				JSON.stringify({ at: Date.now(), results: [{ name: "cached-pkg", description: "", version: "1.0.0", publisher: "x", date: "", downloads: 7, keywords: [] }] }),
				"utf8"
			);
			setPackageCatalogCacheFile(file);
			const results = await searchPiPackageCatalog();
			expect(results.map((r) => r.name)).toEqual(["cached-pkg"]);
			expect(fetchCalls).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to a STALE disk cache when the crawl fails", async () => {
		const { dir, file } = tempCacheFile();
		try {
			const stale = Date.now() - 24 * 60 * 60 * 1000;
			writeFileSync(
				file,
				JSON.stringify({ at: stale, results: [{ name: "stale-pkg", description: "", version: "1.0.0", publisher: "x", date: "", downloads: 3, keywords: [] }] }),
				"utf8"
			);
			setPackageCatalogCacheFile(file);
			// No page queued → the crawl's first request gets a 404.
			const results = await searchPiPackageCatalog();
			expect(results.map((r) => r.name)).toEqual(["stale-pkg"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists a successful crawl to disk for the next run", async () => {
		const { dir, file } = tempCacheFile();
		try {
			setPackageCatalogCacheFile(file);
			queuePage(1, [makeObject("pkg")]);
			await searchPiPackageCatalog();
			// Simulate an app restart: fresh memory, same disk cache file.
			clearPackageCatalogCache();
			setPackageCatalogCacheFile(file);
			const results = await searchPiPackageCatalog();
			expect(results.map((r) => r.name)).toEqual(["pkg"]);
			expect(fetchCalls).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
