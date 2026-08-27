/**
 * Tiny LRU promise cache (audit 6 L-12). Virtualized transcript rows remount
 * every time they scroll back into view, and each remount re-ran shiki over
 * the same source; caching the highlight PROMISE by content key makes remounts
 * (and concurrent first mounts) free.
 */

export class PromiseLruCache<V> {
	private readonly map = new Map<string, Promise<V>>();

	constructor(private readonly maxEntries: number) {}

	/** Returns the cached in-flight/resolved promise, or computes and caches it. */
	getOrCompute(key: string, compute: () => Promise<V>): Promise<V> {
		const hit = this.map.get(key);
		if (hit !== undefined) {
			// Refresh recency: delete + set moves the entry to the tail.
			this.map.delete(key);
			this.map.set(key, hit);
			return hit;
		}
		const promise = compute();
		this.map.set(key, promise);
		// Failures are not worth caching — a retry should recompute.
		promise.catch(() => {
			if (this.map.get(key) === promise) this.map.delete(key);
		});
		while (this.map.size > this.maxEntries) {
			const oldest = this.map.keys().next().value;
			if (oldest === undefined) break;
			this.map.delete(oldest);
		}
		return promise;
	}

	get size(): number {
		return this.map.size;
	}
}
