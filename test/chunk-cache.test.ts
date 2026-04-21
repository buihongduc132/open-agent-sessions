/**
 * RED tests for ChunkCache — TDD: src/core/chunk-cache.ts does not exist yet.
 * These tests MUST fail at import resolution before implementation begins.
 */
import { describe, expect, test, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SessionSummary } from "../src/core/types";
import {
  CHUNK_DURATION_MS,
  bucketForTimestamp,
  getCacheDir,
  type CachedChunk,
  type InvalidationEntry,
  ChunkCache,
} from "../src/core/chunk-cache";

const TMP_ROOT = join(import.meta.dir, "__chunk_cache_tmp__");

function makeSession(
  overrides: Partial<SessionSummary> & { id: string },
): SessionSummary {
  return {
    agent: "opencode",
    alias: "default",
    title: "Test session",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 5,
    storage: "db",
    ...overrides,
  };
}

function makeChunk(
  bucket: number,
  sessions: SessionSummary[],
  writtenAt: number,
): CachedChunk {
  return {
    bucket,
    windowStart: bucket * CHUNK_DURATION_MS,
    windowEnd: (bucket + 1) * CHUNK_DURATION_MS,
    writtenAt,
    sessions,
  };
}

describe("ChunkCache", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = join(TMP_ROOT, `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(cacheDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  // Zone 1 — Empty / Nil inputs

  test("readBucket on non-existent bucket returns null", () => {
    const cache = new ChunkCache(cacheDir);
    expect(cache.readBucket(999999)).toBeNull();
  });

  test("getCacheDir returns non-empty string", () => {
    const dir = getCacheDir();
    expect(typeof dir).toBe("string");
    expect(dir.length).toBeGreaterThan(0);
  });

  test("getCacheDir uses override when provided", () => {
    expect(getCacheDir("/tmp/my-cache")).toBe("/tmp/my-cache");
  });

  // Zone 2 — Boundary alignment (bucketForTimestamp)

  test("bucketForTimestamp: times within same 15-min window share bucket", () => {
    const base = new Date("2024-01-01T00:00:00Z").getTime();
    expect(bucketForTimestamp(base)).toBe(bucketForTimestamp(base + CHUNK_DURATION_MS - 1));
  });

  test("bucketForTimestamp: times in different 15-min windows have different buckets", () => {
    const base = new Date("2024-01-01T00:00:00Z").getTime();
    expect(bucketForTimestamp(base)).not.toBe(bucketForTimestamp(base + CHUNK_DURATION_MS));
  });

  test("bucketForTimestamp: epoch 0 is bucket 0", () => {
    expect(bucketForTimestamp(0)).toBe(0);
  });

  test("bucketForTimestamp: negative timestamp floors correctly", () => {
    expect(bucketForTimestamp(-1)).toBe(-1);
  });

  // Zone 3 — Write + read round-trip

  test("write + read round-trip: sessions survive serialization", () => {
    const cache = new ChunkCache(cacheDir);
    const sessions = [
      makeSession({ id: "aaa", agent: "opencode", alias: "default" }),
      makeSession({ id: "bbb", agent: "codex", alias: "sessions" }),
    ];
    const now = Date.now();
    const bucket = bucketForTimestamp(now - CHUNK_DURATION_MS);
    cache.write(makeChunk(bucket, sessions, now));

    const read = cache.readBucket(bucket);
    expect(read).not.toBeNull();
    expect(read!.sessions).toHaveLength(2);
    expect(read!.sessions[0].id).toBe("aaa");
    expect(read!.sessions[1].id).toBe("bbb");
    expect(read!.bucket).toBe(bucket);
    expect(read!.writtenAt).toBe(now);
  });

  // Zone 4 — TTL expiry

  test("TTL expiry: chunk written >4h ago returns null (deleted)", () => {
    const cache = new ChunkCache(cacheDir);
    const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
    const bucket = bucketForTimestamp(fiveHoursAgo);
    cache.write(makeChunk(bucket, [makeSession({ id: "old" })], fiveHoursAgo));
    expect(cache.readBucket(bucket)).toBeNull();
  });

  test("TTL within bounds: chunk written 2h ago returns valid data", () => {
    const cache = new ChunkCache(cacheDir);
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const bucket = bucketForTimestamp(twoHoursAgo);
    cache.write(makeChunk(bucket, [makeSession({ id: "recent" })], twoHoursAgo));
    const result = cache.readBucket(bucket);
    expect(result).not.toBeNull();
    expect(result!.sessions[0].id).toBe("recent");
  });

  // Zone 5 — Active chunk bypass (state mutation)

  test("active chunk bypass: bucket containing Date.now() NEVER served from cache", () => {
    const cache = new ChunkCache(cacheDir);
    const now = Date.now();
    const bucket = bucketForTimestamp(now);
    cache.write(makeChunk(bucket, [makeSession({ id: "live" })], now));
    expect(cache.readBucket(bucket)).toBeNull();
  });

  // Zone 5 — Invalidation

  test("invalidation: write → invalidate → read returns null", () => {
    const cache = new ChunkCache(cacheDir);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const bucket = bucketForTimestamp(oneHourAgo);
    cache.write(makeChunk(bucket, [makeSession({ id: "doomed" })], oneHourAgo));
    expect(cache.readBucket(bucket)).not.toBeNull();
    cache.invalidate(bucket, "stale data");
    expect(cache.readBucket(bucket)).toBeNull();
  });

  test("invalidation entries are tracked with reason", () => {
    const cache = new ChunkCache(cacheDir);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const bucket = bucketForTimestamp(oneHourAgo);
    cache.write(makeChunk(bucket, [makeSession({ id: "x" })], oneHourAgo));
    cache.invalidate(bucket, "test reason");

    const entries = cache.getInvalidations();
    const match = entries.find((e) => e.bucket === bucket);
    expect(match).toBeDefined();
    expect(match!.reason).toBe("test reason");
  });

  test("invalidation pruning: entries older than 4h are cleaned up", () => {
    const cache = new ChunkCache(cacheDir);
    const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
    const recent = Date.now() - 60 * 60 * 1000;
    const oldBucket = bucketForTimestamp(fiveHoursAgo);
    const recentBucket = bucketForTimestamp(recent);

    cache.write(makeChunk(oldBucket, [makeSession({ id: "old-inv" })], fiveHoursAgo));
    cache.invalidate(oldBucket, "old invalidation");
    cache.write(makeChunk(recentBucket, [makeSession({ id: "recent-inv" })], recent));
    cache.invalidate(recentBucket, "recent invalidation");

    const entries = cache.getInvalidations();
    expect(entries.find((e) => e.bucket === oldBucket)).toBeUndefined();
    expect(entries.find((e) => e.bucket === recentBucket)).toBeDefined();
  });

  // Zone 3 — Lookup hit/miss (multi-bucket range)

  test("lookup: partial hits — returns both hits and misses", () => {
    const cache = new ChunkCache(cacheDir);
    const baseTime = new Date("2024-06-01T00:00:00Z").getTime();
    const bucket0 = bucketForTimestamp(baseTime);
    const bucket1 = bucket0 + 1;
    const bucket2 = bucket0 + 2;

    const writtenAt = Date.now() - 60 * 60 * 1000;
    cache.write(makeChunk(bucket0, [makeSession({ id: "s0" })], writtenAt));
    cache.write(makeChunk(bucket2, [makeSession({ id: "s2" })], writtenAt));

    const result = cache.lookup(
      bucket0 * CHUNK_DURATION_MS,
      (bucket2 + 1) * CHUNK_DURATION_MS,
    );

    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((h) => h.bucket).sort()).toEqual([bucket0, bucket2]);
    expect(result.misses).toHaveLength(1);
    expect(result.misses[0].bucket).toBe(bucket1);
  });

  test("lookup: fully populated range — all hits, zero misses", () => {
    const cache = new ChunkCache(cacheDir);
    const baseTime = new Date("2024-06-01T00:00:00Z").getTime();
    const bucket0 = bucketForTimestamp(baseTime);
    const bucket1 = bucket0 + 1;
    const writtenAt = Date.now() - 60 * 60 * 1000;

    cache.write(makeChunk(bucket0, [makeSession({ id: "a" })], writtenAt));
    cache.write(makeChunk(bucket1, [makeSession({ id: "b" })], writtenAt));

    const result = cache.lookup(
      bucket0 * CHUNK_DURATION_MS,
      (bucket1 + 1) * CHUNK_DURATION_MS,
    );
    expect(result.hits).toHaveLength(2);
    expect(result.misses).toHaveLength(0);
  });

  test("lookup: completely empty range — all misses", () => {
    const cache = new ChunkCache(cacheDir);
    const baseTime = new Date("2024-06-01T00:00:00Z").getTime();
    const bucket0 = bucketForTimestamp(baseTime);
    const bucket1 = bucket0 + 1;

    const result = cache.lookup(
      bucket0 * CHUNK_DURATION_MS,
      (bucket1 + 1) * CHUNK_DURATION_MS,
    );
    expect(result.hits).toHaveLength(0);
    expect(result.misses).toHaveLength(2);
  });

  // Zone 3 — Merge deduplication

  test("mergeChunks: dedupes by (agent, alias, id), keeps newer updated_at", () => {
    const cache = new ChunkCache(cacheDir);

    const chunk1: CachedChunk = {
      bucket: 100,
      windowStart: 100 * CHUNK_DURATION_MS,
      windowEnd: 101 * CHUNK_DURATION_MS,
      writtenAt: Date.now(),
      sessions: [
        makeSession({ id: "shared-1", agent: "opencode", alias: "default", updated_at: "2024-01-03T00:00:00Z" }),
        makeSession({ id: "only-in-1", agent: "codex", alias: "sessions" }),
      ],
    };

    const chunk2: CachedChunk = {
      bucket: 101,
      windowStart: 101 * CHUNK_DURATION_MS,
      windowEnd: 102 * CHUNK_DURATION_MS,
      writtenAt: Date.now(),
      sessions: [
        makeSession({ id: "shared-1", agent: "opencode", alias: "default", updated_at: "2024-01-04T00:00:00Z" }),
        makeSession({ id: "only-in-2", agent: "claude", alias: "desktop" }),
      ],
    };

    const merged = cache.mergeChunks([chunk1, chunk2]);
    expect(merged).toHaveLength(3);

    const shared = merged.filter((s) => s.id === "shared-1");
    expect(shared).toHaveLength(1);
    expect(shared[0].updated_at).toBe("2024-01-04T00:00:00Z");
    expect(merged.map((s) => s.id).sort()).toEqual(["only-in-1", "only-in-2", "shared-1"]);
  });

  test("mergeChunks: result sorted desc by updated_at", () => {
    const cache = new ChunkCache(cacheDir);

    const chunk1: CachedChunk = {
      bucket: 100,
      windowStart: 100 * CHUNK_DURATION_MS,
      windowEnd: 101 * CHUNK_DURATION_MS,
      writtenAt: Date.now(),
      sessions: [
        makeSession({ id: "oldest", updated_at: "2024-01-01T00:00:00Z" }),
        makeSession({ id: "middle", updated_at: "2024-01-05T00:00:00Z" }),
      ],
    };

    const chunk2: CachedChunk = {
      bucket: 101,
      windowStart: 101 * CHUNK_DURATION_MS,
      windowEnd: 102 * CHUNK_DURATION_MS,
      writtenAt: Date.now(),
      sessions: [makeSession({ id: "newest", updated_at: "2024-01-10T00:00:00Z" })],
    };

    const merged = cache.mergeChunks([chunk1, chunk2]);
    expect(merged).toHaveLength(3);
    expect(merged[0].id).toBe("newest");
    expect(merged[1].id).toBe("middle");
    expect(merged[2].id).toBe("oldest");
  });

  test("mergeChunks: empty chunks array returns empty array", () => {
    const cache = new ChunkCache(cacheDir);
    expect(cache.mergeChunks([])).toEqual([]);
  });
});
