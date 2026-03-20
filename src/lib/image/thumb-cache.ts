/**
 * Module-level LRU cache for thumbnail object URLs.
 *
 * Survives SvelteKit navigations (module scope, not component scope).
 * Evicts least-recently-used entries when the cache exceeds MAX_SIZE,
 * calling URL.revokeObjectURL() to free memory.
 *
 * Usage:
 *   const url = thumbCache.get(imageId);          // synchronous, null if miss
 *   thumbCache.set(imageId, objectURL);
 *   thumbCache.has(imageId);
 */

const MAX_SIZE = 2000;

/** LRU cache: insertion order = LRU order (Map preserves insertion order). */
const cache = new Map<string, string>();

export const thumbCache = {
	/**
	 * Returns the cached object URL for imageId, or null on miss.
	 * Promotes the entry to most-recently-used on access.
	 */
	get(imageId: string): string | null {
		const url = cache.get(imageId);
		if (url === undefined) return null;

		// Promote to MRU by re-inserting
		cache.delete(imageId);
		cache.set(imageId, url);
		return url;
	},

	/**
	 * Stores an object URL for imageId.
	 * Evicts the LRU entry if the cache is at capacity.
	 */
	set(imageId: string, url: string): void {
		if (cache.has(imageId)) {
			// Refresh position
			cache.delete(imageId);
		} else if (cache.size >= MAX_SIZE) {
			// Evict LRU (first key in Map)
			const lruKey = cache.keys().next().value;
			if (lruKey !== undefined) {
				const lruUrl = cache.get(lruKey);
				cache.delete(lruKey);
				if (lruUrl) URL.revokeObjectURL(lruUrl);
			}
		}
		cache.set(imageId, url);
	},

	has(imageId: string): boolean {
		return cache.has(imageId);
	},

	/** Current number of cached entries — useful for debugging. */
	get size(): number {
		return cache.size;
	},
};
