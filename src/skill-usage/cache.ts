/**
 * src/skill-usage/cache.ts
 *
 * Re-exports generic cache from ../shared/cache.ts for backward compatibility.
 * The generic JsonCache<T> is now in src/shared/cache.ts.
 */

export { computeFingerprint, openCache } from "../shared/cache";
export type { JsonCache, CacheEntry } from "../shared/cache";
