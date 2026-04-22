import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SessionSummary } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 15 minutes in milliseconds. */
export const CHUNK_DURATION_MS = 900_000;

const CACHE_TTL_MS = 14_400_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheWindow {
  windowStart: number;
  windowEnd: number;
}

export interface CachedChunk extends CacheWindow {
  bucket: number;
  writtenAt: number;
  sessions: SessionSummary[];
}

export interface InvalidationEntry {
  bucket: number;
  reason: string;
  timestamp: number;
}

export interface LookupResult {
  hits: CachedChunk[];
  misses: { bucket: number; windowStart: number; windowEnd: number }[];
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Compute the bucket index for a given timestamp.
 * Uses Math.floor so negative timestamps floor correctly.
 */
export function bucketForTimestamp(ms: number): number {
  return Math.floor(ms / CHUNK_DURATION_MS);
}

/**
 * Resolve the cache directory.
 * Priority: override > XDG_CACHE_HOME/oas/chunks > ~/.cache/oas/chunks
 */
export function getCacheDir(override?: string): string {
  if (override) return override;
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg ? xdg : join(homedir(), ".cache");
  return join(base, "oas", "chunks");
}

// ---------------------------------------------------------------------------
// ChunkCache class
// ---------------------------------------------------------------------------

export class ChunkCache {
  private readonly cacheDir: string;

  constructor(cacheDirOverride?: string) {
    this.cacheDir = resolve(getCacheDir(cacheDirOverride));
  }

  // -- Read -----------------------------------------------------------------

  /**
   * Read a cached bucket. Returns null if:
   * - File doesn't exist
   * - TTL expired (>4h from writtenAt)
   * - Bucket is the active (current) bucket
   * - Bucket has been invalidated
   */
  readBucket(bucket: number): CachedChunk | null {
    const activeBucket = bucketForTimestamp(Date.now());
    if (bucket === activeBucket) return null;

    // Check invalidation
    if (this.isInvalidated(bucket)) return null;

    const filePath = this.bucketPath(bucket);
    if (!existsSync(filePath)) return null;

    try {
      const raw = readFileSync(filePath, "utf-8");
      const chunk: CachedChunk = JSON.parse(raw);

      // TTL check
      if (Date.now() - chunk.writtenAt > CACHE_TTL_MS) {
        // Expired — delete the file
        try { unlinkSync(filePath); } catch { /* ignore */ }
        return null;
      }

      return chunk;
    } catch {
      return null;
    }
  }

  // -- Write ----------------------------------------------------------------

  /**
   * Write a chunk to disk as JSON.
   * Creates the cache directory if it doesn't exist.
   */
  write(chunk: CachedChunk): void {
    mkdirSync(this.cacheDir, { recursive: true });
    const filePath = this.bucketPath(chunk.bucket);
    writeFileSync(filePath, JSON.stringify(chunk), "utf-8");
  }

  // -- Invalidation ---------------------------------------------------------

  /**
   * Invalidate a bucket — deletes the chunk file and records the invalidation.
   * Prunes invalidation entries older than 4h.
   */
  invalidate(bucket: number, reason: string): void {
    const filePath = this.bucketPath(bucket);
    try { unlinkSync(filePath); } catch {}

    const entries = this.readInvalidationFile();
    const bucketTime = bucket * CHUNK_DURATION_MS;
    entries.push({ bucket, reason, timestamp: bucketTime });

    const pruned = entries.filter(
      (e) => Date.now() - e.timestamp <= CACHE_TTL_MS
    );

    this.writeInvalidationFile(pruned);
  }

  /**
   * Get all active invalidation entries (prunes expired ones).
   */
  getInvalidations(): InvalidationEntry[] {
    const entries = this.readInvalidationFile();
    const pruned = entries.filter(
      (e) => Date.now() - e.timestamp <= CACHE_TTL_MS
    );
    // Write back pruned list if it changed
    if (pruned.length !== entries.length) {
      this.writeInvalidationFile(pruned);
    }
    return pruned;
  }

  // -- Lookup ---------------------------------------------------------------

  /**
   * Look up buckets in a time range. Returns hits (valid CachedChunks)
   * and misses (buckets not cached, expired, or active).
   */
  lookup(sinceMs: number, untilMs: number): LookupResult {
    const startBucket = bucketForTimestamp(sinceMs);
    // endBucket: the last bucket whose window starts before untilMs
    // untilMs is exclusive, so we need bucket containing (untilMs - 1)
    const endBucket = bucketForTimestamp(untilMs - 1);

    const hits: CachedChunk[] = [];
    const misses: { bucket: number; windowStart: number; windowEnd: number }[] = [];

    for (let b = startBucket; b <= endBucket; b++) {
      const chunk = this.readBucket(b);
      if (chunk) {
        hits.push(chunk);
      } else {
        misses.push({
          bucket: b,
          windowStart: b * CHUNK_DURATION_MS,
          windowEnd: (b + 1) * CHUNK_DURATION_MS,
        });
      }
    }

    return { hits, misses };
  }

  // -- Merge ----------------------------------------------------------------

  /**
   * Merge multiple chunks into a single deduplicated session list.
   * Deduplicates by (agent, alias, id), keeping the newer updated_at.
   * Sorts DESC by updated_at.
   */
  mergeChunks(chunks: CachedChunk[]): SessionSummary[] {
    if (chunks.length === 0) return [];

    const byKey = new Map<string, SessionSummary>();

    for (const chunk of chunks) {
      for (const s of chunk.sessions) {
        const key = `${s.agent}:${s.alias}:${s.id}`;
        const existing = byKey.get(key);
        if (!existing) {
          byKey.set(key, s);
        } else {
          // Keep the one with newer updated_at
          if (s.updated_at > existing.updated_at) {
            byKey.set(key, s);
          }
        }
      }
    }

    const merged = Array.from(byKey.values());
    merged.sort((a, b) => {
      if (a.updated_at !== b.updated_at) {
        return a.updated_at < b.updated_at ? 1 : -1; // DESC
      }
      return a.id.localeCompare(b.id);
    });
    return merged;
  }

  // -- Private helpers ------------------------------------------------------

  private bucketPath(bucket: number): string {
    return join(this.cacheDir, `${bucket}.json`);
  }

  private invalidationPath(): string {
    return join(this.cacheDir, "invalidations.json");
  }

  private isInvalidated(bucket: number): boolean {
    const entries = this.readInvalidationFile();
    // Also prune stale entries while checking
    return entries.some((e) => e.bucket === bucket && Date.now() - e.timestamp <= CACHE_TTL_MS);
  }

  private readInvalidationFile(): InvalidationEntry[] {
    const filePath = this.invalidationPath();
    if (!existsSync(filePath)) return [];
    try {
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as InvalidationEntry[];
    } catch {
      return [];
    }
  }

  private writeInvalidationFile(entries: InvalidationEntry[]): void {
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(this.invalidationPath(), JSON.stringify(entries), "utf-8");
  }
}
