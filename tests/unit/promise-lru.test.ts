/**
 * PromiseLruCache (audit 6 L-12): virtualized transcript rows remount on
 * scroll, and each remount re-ran shiki over the same source. The cache makes
 * concurrent first mounts share one compute and remounts free — without
 * caching failures or growing unboundedly.
 */
import { describe, expect, it, vi } from "vitest";
import { PromiseLruCache } from "../../src/renderer/src/lib/promise-lru";

describe("PromiseLruCache (audit 6 L-12)", () => {
	it("dedupes concurrent computes for the same key", async () => {
		const cache = new PromiseLruCache<string>(10);
		const compute = vi.fn(() => Promise.resolve("v"));
		const [a, b] = await Promise.all([
			cache.getOrCompute("k", compute),
			cache.getOrCompute("k", compute),
		]);
		expect(a).toBe("v");
		expect(b).toBe("v");
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it("caches the resolved value (remounts are free)", async () => {
		const cache = new PromiseLruCache<string>(10);
		const compute = vi.fn(() => Promise.resolve("v"));
		await cache.getOrCompute("k", compute);
		expect(await cache.getOrCompute("k", compute)).toBe("v");
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it("evicts failures so a retry recomputes", async () => {
		const cache = new PromiseLruCache<string>(10);
		let calls = 0;
		const compute = (): Promise<string> => {
			calls += 1;
			return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("ok");
		};
		await expect(cache.getOrCompute("k", compute)).rejects.toThrow("boom");
		expect(await cache.getOrCompute("k", compute)).toBe("ok");
		expect(calls).toBe(2);
	});

	it("evicts the least-recently-used entry beyond capacity", async () => {
		const cache = new PromiseLruCache<string>(2);
		const compute = vi.fn((k: string) => Promise.resolve(k));
		await cache.getOrCompute("a", () => compute("a"));
		await cache.getOrCompute("b", () => compute("b"));
		// Touch "a" so "b" becomes the oldest.
		await cache.getOrCompute("a", () => compute("a"));
		await cache.getOrCompute("c", () => compute("c"));
		expect(cache.size).toBe(2);
		// "b" was evicted → recompute; "a" survived untouched.
		await cache.getOrCompute("b", () => compute("b"));
		expect(compute.mock.calls.filter(([k]) => k === "b")).toHaveLength(2);
		expect(compute.mock.calls.filter(([k]) => k === "a")).toHaveLength(1);
	});
});
