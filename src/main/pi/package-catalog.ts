/**
 * Pi package catalog — backed by the npm registry search endpoint, the same
 * data source pi.dev/packages is built from: every package published with the
 * `pi-package` keyword, with monthly download counts.
 *
 * The npm CLI caps `npm search` at ~20 results by default, which is why the
 * marketplace used to show only a sliver of the catalog. The registry's
 * `/-/v1/search` endpoint paginates (size ≤ 250, from+size ≤ 10_000), so the
 * full catalog is reachable.
 *
 * Rate limiting: the full crawl is ~34 requests and the registry answers 429
 * under burst load, so pages fetch with bounded concurrency, 429/5xx responses
 * retry with backoff (honoring Retry-After), and a successful crawl is cached
 * in memory (30 min) and on disk (12 h, path set via
 * setPackageCatalogCacheFile). A failed crawl falls back to a stale disk
 * cache rather than showing nothing.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { NpmSearchResult } from "../../shared/pi";

const REGISTRY_SEARCH = "https://registry.npmjs.org/-/v1/search";
const PAGE_SIZE = 250;
/** The registry rejects from+size beyond a 10k window. */
const MAX_RESULTS = 10_000;
const MEMORY_TTL_MS = 30 * 60 * 1000;
const DISK_TTL_MS = 12 * 60 * 60 * 1000;
const PAGE_CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 4;
const MAX_BACKOFF_MS = 15_000;

interface RegistrySearchResponse {
	total: number;
	objects: Array<{
		downloads?: { monthly?: number };
		package: {
			name: string;
			description?: string;
			version?: string;
			publisher?: { username?: string } | null;
			date?: string;
			keywords?: string[];
		};
	}>;
}

interface CatalogSnapshot {
	at: number;
	results: NpmSearchResult[];
}

let memoryCache: CatalogSnapshot | null = null;
let cacheFile: string | null = null;

/** Point the disk cache at a file (main wires this to userData on start). */
export function setPackageCatalogCacheFile(filePath: string): void {
	cacheFile = filePath;
}

function readDiskCache(): CatalogSnapshot | null {
	if (cacheFile === null || !existsSync(cacheFile)) return null;
	try {
		const parsed = JSON.parse(readFileSync(cacheFile, "utf8")) as CatalogSnapshot;
		if (typeof parsed.at !== "number" || !Array.isArray(parsed.results)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function writeDiskCache(snapshot: CatalogSnapshot): void {
	if (cacheFile === null) return;
	try {
		const tmp = `${cacheFile}.tmp`;
		writeFileSync(tmp, JSON.stringify(snapshot), "utf8");
		renameSync(tmp, cacheFile);
	} catch {
		// A cache write failure must never break the listing.
	}
}

function backoffMs(res: Response, attempt: number): number {
	const retryAfter = Number(res.headers.get("retry-after"));
	if (Number.isFinite(retryAfter) && retryAfter > 0) {
		return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
	}
	return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

async function fetchPage(text: string, from: number): Promise<RegistrySearchResponse> {
	const url = `${REGISTRY_SEARCH}?text=${encodeURIComponent(text)}&size=${PAGE_SIZE}&from=${from}`;
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: { accept: "application/json" },
		});
		if (res.ok) return (await res.json()) as RegistrySearchResponse;
		const retryable = res.status === 429 || res.status >= 500;
		if (!retryable || attempt >= MAX_RETRIES) {
			throw new Error(`npm registry search failed: HTTP ${res.status}`);
		}
		await new Promise((resolve) => setTimeout(resolve, backoffMs(res, attempt)));
	}
}

function mapObject(obj: RegistrySearchResponse["objects"][number]): NpmSearchResult {
	const pkg = obj.package;
	return {
		name: pkg.name,
		description: pkg.description ?? "",
		version: pkg.version ?? "0.0.0",
		publisher: pkg.publisher?.username ?? "unknown",
		date: pkg.date ?? "",
		downloads: obj.downloads?.monthly ?? 0,
		keywords: pkg.keywords ?? [],
	};
}

async function crawlCatalog(text: string): Promise<NpmSearchResult[]> {
	const first = await fetchPage(text, 0);
	const total = Math.min(first.total, MAX_RESULTS);
	const objects = [...first.objects];
	const offsets: number[] = [];
	for (let from = PAGE_SIZE; from < total; from += PAGE_SIZE) offsets.push(from);
	for (let i = 0; i < offsets.length; i += PAGE_CONCURRENCY) {
		const pages = await Promise.all(offsets.slice(i, i + PAGE_CONCURRENCY).map((from) => fetchPage(text, from)));
		for (const page of pages) objects.push(...page.objects);
	}
	return objects.map(mapObject).sort((a, b) => b.downloads - a.downloads);
}

/**
 * Search the pi package catalog. With a query, returns one relevance-ranked
 * page (250) for `keywords:pi-package <query>`. Without a query, returns the
 * FULL catalog sorted by monthly downloads (pi.dev's listing order) — from
 * memory, disk, or a fresh crawl, in that order; a failed crawl falls back
 * to a stale disk cache before surfacing the error.
 */
export async function searchPiPackageCatalog(query?: string): Promise<NpmSearchResult[]> {
	const trimmed = query?.trim() ?? "";
	const text = trimmed.length > 0 ? `keywords:pi-package ${trimmed}` : "keywords:pi-package";

	if (trimmed.length > 0) {
		const page = await fetchPage(text, 0);
		return page.objects.map(mapObject);
	}

	if (memoryCache !== null && Date.now() - memoryCache.at < MEMORY_TTL_MS) {
		return memoryCache.results;
	}
	const disk = readDiskCache();
	if (disk !== null && Date.now() - disk.at < DISK_TTL_MS) {
		memoryCache = disk;
		return disk.results;
	}

	try {
		const results = await crawlCatalog(text);
		const snapshot: CatalogSnapshot = { at: Date.now(), results };
		memoryCache = snapshot;
		writeDiskCache(snapshot);
		return results;
	} catch (error) {
		// Rate-limited or offline with a stale cache: serve it rather than nothing.
		if (disk !== null) {
			memoryCache = disk;
			return disk.results;
		}
		throw error;
	}
}

/** Test hook: drop the cached catalog so the next call re-fetches. */
export function clearPackageCatalogCache(): void {
	memoryCache = null;
	cacheFile = null;
}
