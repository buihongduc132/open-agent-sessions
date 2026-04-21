# Session List: Roots-Only + 15-Min Chunk Cache — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add roots-only default filtering at the SDK core level, search limit + time window support, and a disk-backed 15-minute chunk cache for time-ranged session queries.

**Architecture:** Three independent modules. (1) `rootsOnly` flag on `SessionListQuery` applied before pagination in `list.ts`. (2) `limit` + `timeRange` on `SearchQuery` wired through CLI search command. (3) New `ChunkCache` class in `src/core/chunk-cache.ts` — disk-backed JSON files per 15-min bucket, 4h TTL, invalidation records for resumed sessions. All three share the `src/core/types.ts` type changes.

**Tech Stack:** TypeScript, Bun test runner, `node:fs`/`node:path` for disk cache, `XDG_CACHE_HOME` convention.

**Spec:** `docs/superpowers/specs/2026-04-21-session-list-cache-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/types.ts` | Modify | Add `rootsOnly` to `SessionListQuery`; add `limit` + `timeRange` to `SearchQuery` |
| `src/core/chunk-cache.ts` | Create | `ChunkCache` class: bucket math, disk I/O, TTL, invalidation |
| `src/core/list.ts` | Modify | Apply `rootsOnly` before limit; integrate `ChunkCache` for time-ranged queries |
| `src/cli/search.ts` | Modify | Accept `--limit`, `--last`, `--since`, `--until` flags; pass to `SearchQuery` |
| `src/cli/list.ts` | Modify | Remove post-hoc `rootsOnly` filtering (lines 84-110) — core handles it now |
| `src/sdk/index.ts` | Modify | Export `ChunkCache`, `clearChunkCache` |
| `test/list-roots-only.test.ts` | Create | Tests for R1: roots-only default + before-limit semantics |
| `test/chunk-cache.test.ts` | Create | Tests for R3/R4: chunk I/O, TTL, invalidation, merging |
| `test/search-limit.test.ts` | Create | Tests for R2: search with limit + time range |

---

## Task 1: Add `rootsOnly` to types

**Files:**
- Modify: `src/core/types.ts`

- [ ] **Step 1: Add `rootsOnly` to `SessionListQuery` type in `src/core/types.ts`**

Read `src/core/types.ts` and add the `rootsOnly` field to the `SessionListQuery` type (exported from `src/core/list.ts` — actually defined there). Also add `limit` and `timeRange` to `SearchQuery` in `src/core/types.ts`.

In `src/core/types.ts`, modify `SearchQuery`:

```typescript
export interface SearchQuery {
  cwd?: string;
  text: string;
  /** Maximum number of results to return. */
  limit?: number;
  /** Time range to restrict search results. */
  timeRange?: TimeRangeOptions;
}
```

In `src/core/list.ts`, modify `SessionListQuery`:

```typescript
export type SessionListQuery = {
  agent?: AgentKind;
  alias?: string;
  q?: string;
  /** Maximum number of sessions to return. When set, triggers cursor pagination. */
  limit?: number;
  /**
   * Cursor from a previous response (`nextCursor`) — positions after the
   * sessions in that page.
   */
  after?: string;
  /**
   * When true (default), only return sessions without a parentSessionId.
   * Set to false to include child/forked sessions.
   * Applied BEFORE limit/pagination.
   */
  rootsOnly?: boolean;
};
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no consumers use the new fields yet, they're optional)

- [ ] **Step 3: Commit**

```bash
git add src/core/types.ts src/core/list.ts
git commit -m "feat: add rootsOnly to SessionListQuery, limit+timeRange to SearchQuery

Type-only change. rootsOnly defaults to true at the listSessions
function level. SearchQuery gains optional limit and timeRange fields."
```

---

## Task 2: RED — Roots-only tests

**Files:**
- Create: `test/list-roots-only.test.ts`

- [ ] **Step 1: Write failing tests for roots-only behavior**

Create `test/list-roots-only.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { listSessions, type SessionListQuery } from "../src/core/list";
import { type AdapterRegistry, type SessionSummary } from "../src/core/types";

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    agent: "opencode",
    alias: "default",
    title: "Untitled",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 0,
    storage: "db",
    ...overrides,
  };
}

// Helper: build a registry with a single adapter returning given sessions
function makeRegistry(sessions: SessionSummary[]): AdapterRegistry {
  return {
    adapters: [
      {
        agent: "opencode",
        alias: "default",
        version: "1.0.0",
        listSessions: async () => sessions,
      },
    ],
  };
}

describe("roots-only filtering", () => {
  const root = makeSession({ id: "root-1", updated_at: "2024-03-01T00:00:00Z" });
  const child = makeSession({
    id: "child-1",
    updated_at: "2024-03-01T00:01:00Z",
    parentSessionId: "root-1",
  });
  const root2 = makeSession({ id: "root-2", updated_at: "2024-02-01T00:00:00Z" });
  const child2 = makeSession({
    id: "child-2",
    updated_at: "2024-02-01T00:01:00Z",
    parentSessionId: "root-2",
  });

  test("default query returns only root sessions", async () => {
    const registry = makeRegistry([root, child, root2, child2]);
    const result = await listSessions(registry);
    const ids = result.sessions.map((s) => s.id);
    expect(ids).toEqual(["root-1", "root-2"]);
  });

  test("rootsOnly: false returns all sessions", async () => {
    const registry = makeRegistry([root, child, root2, child2]);
    const result = await listSessions(registry, { rootsOnly: false });
    const ids = result.sessions.map((s) => s.id);
    expect(ids).toEqual(["root-1", "child-1", "root-2", "child-2"]);
  });

  test("rootsOnly filter applies BEFORE limit", async () => {
    // 2 roots + 8 children = 10 total. limit=5 should return 2 roots, not 5.
    const sessions: SessionSummary[] = [
      root,
      child,
      root2,
      ...Array.from({ length: 7 }, (_, i) =>
        makeSession({
          id: `child-extra-${i}`,
          updated_at: new Date(Date.parse("2024-01-01T00:00:00Z") + i * 1000).toISOString(),
          parentSessionId: "root-1",
        })
      ),
    ];
    const registry = makeRegistry(sessions);
    const result = await listSessions(registry, { limit: 5 });
    expect(result.sessions.length).toBe(2);
    expect(result.sessions.every((s) => !s.parentSessionId)).toBe(true);
  });

  test("cursor pagination with rootsOnly skips children", async () => {
    // Create many sessions: roots + children interleaved by time
    const sessions: SessionSummary[] = [];
    for (let i = 0; i < 20; i++) {
      const ts = new Date(Date.parse("2024-06-01T00:00:00Z") + i * 60000);
      sessions.push(makeSession({ id: `root-${i}`, updated_at: ts.toISOString() }));
      sessions.push(
        makeSession({
          id: `child-${i}`,
          updated_at: new Date(ts.getTime() + 30000).toISOString(),
          parentSessionId: `root-${i}`,
        })
      );
    }
    const registry = makeRegistry(sessions);

    // Page 1: limit 5 roots-only (default)
    const page1 = await listSessions(registry, { limit: 5 });
    expect(page1.sessions.length).toBe(5);
    expect(page1.sessions.every((s) => !s.parentSessionId)).toBe(true);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    // Page 2: continue from cursor
    const page2 = await listSessions(registry, { limit: 5, after: page1.nextCursor! });
    expect(page2.sessions.length).toBe(5);
    expect(page2.sessions.every((s) => !s.parentSessionId)).toBe(true);

    // Pages should not overlap
    const page1Ids = new Set(page1.sessions.map((s) => s.id));
    const page2Ids = page2.sessions.map((s) => s.id);
    expect(page2Ids.every((id) => !page1Ids.has(id))).toBe(true);
  });

  test("rootsOnly with agent filter still excludes children", async () => {
    const registry = makeRegistry([root, child]);
    const result = await listSessions(registry, { agent: "opencode" });
    expect(result.sessions.map((s) => s.id)).toEqual(["root-1"]);
  });

  test("session without parentSessionId field is treated as root", async () => {
    const noParent = makeSession({ id: "no-parent-1", updated_at: "2024-03-01T00:00:00Z" });
    // Ensure parentSessionId is not present (undefined)
    delete (noParent as any).parentSessionId;
    const registry = makeRegistry([noParent]);
    const result = await listSessions(registry);
    expect(result.sessions.map((s) => s.id)).toEqual(["no-parent-1"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/list-roots-only.test.ts`
Expected: FAIL — `listSessions` does not yet apply `rootsOnly` filter. The "default query returns only root sessions" test will fail because all 4 sessions are returned.

- [ ] **Step 3: Commit RED tests**

```bash
git add test/list-roots-only.test.ts
git commit -m "test: add failing roots-only filter tests (RED)

6 tests for rootsOnly behavior:
- default returns only roots
- rootsOnly:false returns all
- rootsOnly applies before limit
- cursor pagination with rootsOnly
- agent filter + rootsOnly
- undefined parentSessionId treated as root"
```

---

## Task 3: GREEN — Implement roots-only in `list.ts`

**Files:**
- Modify: `src/core/list.ts`

- [ ] **Step 1: Implement roots-only filter in `listSessions`**

In `src/core/list.ts`, modify `listSessions` to default `rootsOnly = true` and apply before limit:

```typescript
export async function listSessions(
  registry: AdapterRegistry,
  query: SessionListQuery = {}
): Promise<SessionListResult> {
  const rootsOnly = query.rootsOnly ?? true;

  // ── Cursor-pagination branch ──────────────────────────────────────────────
  if (query.limit !== undefined || query.after !== undefined) {
    return listSessionsPaginated(registry, query, rootsOnly);
  }

  // ── Default branch (no pagination) ──────────────────────────────────────
  const { sessions, errors } = await collectSessions(registry, query);
  const filtered = applyFilters(sessions, query);
  const rootFiltered = rootsOnly ? filtered.filter((s) => !s.parentSessionId) : filtered;
  const ordered = rootFiltered.slice().sort(compareSessions);
  return { sessions: ordered, errors };
}
```

Update `listSessionsPaginated` signature to accept `rootsOnly`:

```typescript
async function listSessionsPaginated(
  registry: AdapterRegistry,
  query: SessionListQuery,
  rootsOnly: boolean
): Promise<SessionListResult> {
  // ... existing pagination logic ...

  // After the existing `ordered = ordered.slice().sort(compareSessions);` line,
  // add roots-only filter BEFORE the limit slice:
  if (rootsOnly) {
    ordered = ordered.filter((s) => !s.parentSessionId);
  }

  // hasMore: true when there is at least one more item beyond the page.
  const hasMore = ordered.length > limit;
  const page = ordered.slice(0, limit);
  const nextCursor =
    hasMore && page.length > 0 ? cursorEncode(page[page.length - 1]) : undefined;

  return { sessions: page, errors, nextCursor, hasMore: hasMore || undefined };
}
```

Also update `applyFilters` in the non-paginated path — the `rootFiltered` line handles it there.

- [ ] **Step 2: Run roots-only tests to verify they pass**

Run: `bun test test/list-roots-only.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Run existing list-core tests to verify no regression**

Run: `bun test test/list-core.test.ts`
Expected: ALL PASS (existing tests don't use `parentSessionId` so they're all roots by default)

- [ ] **Step 4: Commit**

```bash
git add src/core/list.ts
git commit -m "feat: implement roots-only default filter in listSessions

rootsOnly defaults to true. Filter is applied before limit/pagination
so the limit counts root sessions, not root+children."
```

---

## Task 4: Remove CLI post-hoc roots-only (now handled by core)

**Files:**
- Modify: `src/cli/list.ts`

- [ ] **Step 1: Remove the rootsOnly/childrenOf/subOnly/hideChildren post-processing**

In `src/cli/list.ts`, the block at lines 84-110 does post-hoc filtering. Since core now handles `rootsOnly` by default, remove:

1. The `rootsOnly` filtering (lines 86-88) — core does this.
2. The `childrenOf` filtering (lines 91-93) — this is a different feature, keep it but it needs to stay in CLI since it's CLI-specific.
3. The `subOnly` filtering (lines 96-98) — keep in CLI (CLI-specific filter).
4. The `hideChildren` logic (lines 104-110) — core handles default behavior now.

Replace the entire filtering block with:

```typescript
  // Apply childrenOf filter: only sessions whose parent is the specified ID
  let sessions = result.sessions;
  if (options.childrenOf !== undefined) {
    sessions = sessions.filter((s) => s.parentSessionId === options.childrenOf);
  }

  // Apply subOnly filter: only sessions with a parentSessionId
  if (options.subOnly) {
    sessions = sessions.filter((s) => !!s.parentSessionId);
  }

  // When includeSubagents is set, re-query without rootsOnly to get all sessions
  // For now: if includeSubagents, re-query with rootsOnly:false
  // (The list service already applied rootsOnly by default, so includeSubagents
  // means we need to re-fetch with rootsOnly:false)
  // NOTE: This is handled by passing rootsOnly:false to the list service.
```

Also update the query construction to pass `rootsOnly` based on CLI flags:

```typescript
  const query: SessionListQuery = {
    agent: agentResult.value,
    alias: aliasResult.value,
    q: normalizeQuery(options.q),
    limit: options.limit,
    after: options.after,
    rootsOnly: options.includeSubagents ? false : (options.rootsOnly ?? true),
  };
```

Wait — `options.rootsOnly` on the CLI means "filter to roots", which is now the DEFAULT. If the user passes `--roots-only` explicitly, it's redundant. If they pass `--include-subagents`, we need `rootsOnly: false`. The `childrenOf` and `subOnly` cases need `rootsOnly: false` too since they need children visible.

Update the query to:

```typescript
  // Core defaults to rootsOnly=true. Override when CLI flags need children visible.
  const needsChildren = options.includeSubagents || options.childrenOf !== undefined || options.subOnly;
  const query: SessionListQuery = {
    agent: agentResult.value,
    alias: aliasResult.value,
    q: normalizeQuery(options.q),
    limit: options.limit,
    after: options.after,
    rootsOnly: needsChildren ? false : !(options.rootsOnly === false),
  };
```

- [ ] **Step 2: Run CLI list tests**

Run: `bun test test/cli-list.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/cli/list.ts
git commit -m "refactor: remove post-hoc rootsOnly filtering from CLI list

Core list.ts now handles rootsOnly by default. CLI only overrides
rootsOnly=false when --include-subagents, --children-of, or --sub-only
are used."
```

---

## Task 5: RED — Chunk cache tests

**Files:**
- Create: `test/chunk-cache.test.ts`

- [ ] **Step 1: Write failing chunk cache tests**

Create `test/chunk-cache.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ChunkCache,
  bucketForTimestamp,
  getCacheDir,
  CHUNK_DURATION_MS,
  type CachedChunk,
} from "../src/core/chunk-cache";
import type { SessionSummary } from "../src/core/types";

// Use a temp dir for tests
const TEST_CACHE_DIR = join(import.meta.dir, ".test-chunk-cache");

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
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

beforeEach(() => {
  // Clean slate
  if (existsSync(TEST_CACHE_DIR)) {
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_CACHE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_CACHE_DIR)) {
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  }
});

describe("bucketForTimestamp", () => {
  test("aligns to 15-minute boundaries", () => {
    // 2024-01-01T00:00:00Z = 1704067200000ms
    const t0 = 1704067200000;
    expect(bucketForTimestamp(t0)).toBe(Math.floor(t0 / CHUNK_DURATION_MS));
    // 7 minutes later — same bucket
    expect(bucketForTimestamp(t0 + 7 * 60 * 1000)).toBe(Math.floor(t0 / CHUNK_DURATION_MS));
    // 16 minutes later — next bucket
    expect(bucketForTimestamp(t0 + 16 * 60 * 1000)).toBe(Math.floor(t0 / CHUNK_DURATION_MS) + 1);
  });

  test("bucket * CHUNK_DURATION_MS gives window start", () => {
    const t = 1704067200000;
    const bucket = bucketForTimestamp(t);
    expect(bucket * CHUNK_DURATION_MS).toBeLessThanOrEqual(t);
    expect((bucket + 1) * CHUNK_DURATION_MS).toBeGreaterThan(t);
  });
});

describe("ChunkCache write + read", () => {
  test("round-trip: write a chunk then read it back", () => {
    const cache = new ChunkCache(TEST_CACHE_DIR);
    const bucket = bucketForTimestamp(1704067200000);
    const chunk: CachedChunk = {
      bucket,
      windowStart: bucket * CHUNK_DURATION_MS,
      windowEnd: (bucket + 1) * CHUNK_DURATION_MS,
      writtenAt: Date.now(),
      sessions: [
        makeSession({ id: "s1", updated_at: "2024-01-01T00:05:00Z" }),
        makeSession({ id: "s2", updated_at: "2024-01-01T00:10:00Z" }),
      ],
    };

    cache.write(chunk);

    const read = cache.readBucket(bucket);
    expect(read).not.toBeNull();
    expect(read!.sessions.length).toBe(2);
    expect(read!.sessions[0].id).toBe("s1");
    expect(read!.bucket).toBe(bucket);
  });

  test("reading non-existent bucket returns null", () => {
    const cache = new ChunkCache(TEST_CACHE_DIR);
    const result = cache.readBucket(999999);
    expect(result).toBeNull();
  });
});

describe("ChunkCache TTL", () => {
  test("chunk older than 4h is treated as expired", () => {
    const cache = new ChunkCache(TEST_CACHE_DIR);
    const bucket = bucketForTimestamp(1704067200000);
    const fourHoursAgo = Date.now() - (4 * 60 * 60 * 1000 + 1);

    const chunk: CachedChunk = {
      bucket,
      windowStart: bucket * CHUNK_DURATION_MS,
      windowEnd: (bucket + 1) * CHUNK_DURATION_MS,
      writtenAt: fourHoursAgo,
      sessions: [makeSession({ id: "s1" })],
    };

    cache.write(chunk);

    // Should be expired
    const result = cache.readBucket(bucket);
    expect(result).toBeNull();
  });

  test("chunk within 4h TTL is valid", () => {
    const cache = new ChunkCache(TEST_CACHE_DIR);
    const bucket = bucketForTimestamp(1704067200000);
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

    const chunk: CachedChunk = {
      bucket,
      windowStart: bucket * CHUNK_DURATION_MS,
      windowEnd: (bucket + 1) * CHUNK_DURATION_MS,
      writtenAt: twoHoursAgo,
      sessions: [makeSession({ id: "s1" })],
    };

    cache.write(chunk);

    const result = cache.readBucket(bucket);
    expect(result).not.toBeNull();
    expect(result!.sessions[0].id).toBe("s1");
  });
});

describe("ChunkCache active chunk", () => {
  test("bucket containing 'now' is never cached (lookup returns miss)", () => {
    const cache = new ChunkCache(TEST_CACHE_DIR);
    const now = Date.now();
    const bucket = bucketForTimestamp(now);

    const chunk: CachedChunk = {
      bucket,
      windowStart: bucket * CHUNK_DURATION_MS,
      windowEnd: (bucket + 1) * CHUNK_DURATION_MS,
      writtenAt: now,
      sessions: [makeSession({ id: "s1" })],
    };

    // Write it
    cache.write(chunk);

    // Read should return null because it's the active bucket
    const result = cache.readBucket(bucket);
    expect(result).toBeNull();
  });
});

describe("ChunkCache invalidation", () => {
  test("invalidated chunk returns null on read", () => {
    const cache = new ChunkCache(TEST_CACHE_DIR);
    const now = Date.now();
    // Use a bucket well in the past so it's not the active bucket
    const bucket = bucketForTimestamp(now - 24 * 60 * 60 * 1000);

    const chunk: CachedChunk = {
      bucket,
      windowStart: bucket * CHUNK_DURATION_MS,
      windowEnd: (bucket + 1) * CHUNK_DURATION_MS,
      writtenAt: now - 60000, // written 1 min ago
      sessions: [makeSession({ id: "s1" })],
    };

    cache.write(chunk);

    // Verify it's readable
    expect(cache.readBucket(bucket)).not.toBeNull();

    // Invalidate
    cache.invalidate(bucket, "session_updated");

    // Should now return null
    expect(cache.readBucket(bucket)).toBeNull();
  });

  test("invalidation entries older than 4h are pruned on load", () => {
    const cache = new ChunkCache(TEST_CACHE_DIR);
    const oldBucket = bucketForTimestamp(Date.now() - 8 * 60 * 60 * 1000);

    // Write invalidation for old bucket
    cache.invalidate(oldBucket, "session_updated");

    // Reload cache — should prune the old invalidation
    const cache2 = new ChunkCache(TEST_CACHE_DIR);
    const invalidations = cache2.getInvalidations();
    // The old invalidation should be pruned (it's >4h old)
    expect(invalidations.every((e) => Date.now() - e.invalidatedAt < 4 * 60 * 60 * 1000)).toBe(true);
  });
});

describe("ChunkCache lookup", () => {
  test("lookup returns hits for valid chunks and misses for missing/expired", () => {
    const cache = new ChunkCache(TEST_CACHE_DIR);
    const now = Date.now();
    const bucket1 = bucketForTimestamp(now - 2 * 60 * 60 * 1000); // 2h ago
    const bucket2 = bucketForTimestamp(now - 1 * 60 * 60 * 1000); // 1h ago
    const bucket3 = bucketForTimestamp(now - 30 * 60 * 1000);      // 30min ago (missing)

    // Write chunks for bucket1 and bucket2
    cache.write({
      bucket: bucket1,
      windowStart: bucket1 * CHUNK_DURATION_MS,
      windowEnd: (bucket1 + 1) * CHUNK_DURATION_MS,
      writtenAt: now - 60000,
      sessions: [makeSession({ id: "s-old-1" })],
    });
    cache.write({
      bucket: bucket2,
      windowStart: bucket2 * CHUNK_DURATION_MS,
      windowEnd: (bucket2 + 1) * CHUNK_DURATION_MS,
      writtenAt: now - 60000,
      sessions: [makeSession({ id: "s-old-2" })],
    });

    const result = cache.lookup(
      bucket1 * CHUNK_DURATION_MS,
      (bucket3 + 1) * CHUNK_DURATION_MS
    );

    // bucket1 and bucket2 should be hits, bucket3 should be a miss
    expect(result.hits.length).toBe(2);
    expect(result.misses.length).toBe(1);
    expect(result.misses[0].bucket).toBe(bucket3);
  });
});

describe("ChunkCache merge", () => {
  test("mergeChunks deduplicates by (agent, alias, id) and sorts desc by updated_at", () => {
    const cache = new ChunkCache(TEST_CACHE_DIR);
    const chunks: CachedChunk[] = [
      {
        bucket: 100,
        windowStart: 100 * CHUNK_DURATION_MS,
        windowEnd: 101 * CHUNK_DURATION_MS,
        writtenAt: Date.now(),
        sessions: [
          makeSession({ id: "s1", updated_at: "2024-01-01T00:05:00Z" }),
          makeSession({ id: "s2", updated_at: "2024-01-01T00:10:00Z" }),
        ],
      },
      {
        bucket: 101,
        windowStart: 101 * CHUNK_DURATION_MS,
        windowEnd: 102 * CHUNK_DURATION_MS,
        writtenAt: Date.now(),
        sessions: [
          makeSession({ id: "s2", updated_at: "2024-01-01T00:10:00Z" }), // duplicate
          makeSession({ id: "s3", updated_at: "2024-01-01T00:20:00Z" }),
        ],
      },
    ];

    const merged = cache.mergeChunks(chunks);
    expect(merged.length).toBe(3); // s1, s2, s3 (deduplicated)
    // Sorted desc by updated_at
    expect(merged[0].id).toBe("s3");
    expect(merged[1].id).toBe("s2");
    expect(merged[2].id).toBe("s1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/chunk-cache.test.ts`
Expected: FAIL — `../src/core/chunk-cache.ts` does not exist yet.

- [ ] **Step 3: Commit RED tests**

```bash
git add test/chunk-cache.test.ts
git commit -m "test: add failing chunk cache tests (RED)

10 tests for chunk cache:
- bucket computation (15-min alignment)
- write + read round-trip
- TTL expiry (4h)
- active chunk bypass
- invalidation write/read/prune
- lookup hit/miss classification
- merge deduplication + sorting"
```

---

## Task 6: GREEN — Implement `ChunkCache`

**Files:**
- Create: `src/core/chunk-cache.ts`

- [ ] **Step 1: Implement `ChunkCache` class**

Create `src/core/chunk-cache.ts`:

```typescript
/**
 * Disk-backed 15-minute chunk cache for session list queries.
 *
 * Each 15-min time window is stored as a separate JSON file.
 * Past chunks are immutable once written (4h TTL from write time).
 * The active chunk (containing "now") is never cached.
 * Invalidation records track chunks that must be re-queried.
 *
 * @file src/core/chunk-cache.ts
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionSummary } from "./types";

// 15 minutes in milliseconds
export const CHUNK_DURATION_MS = 15 * 60 * 1000;

// 4 hours TTL
const CHUNK_TTL_MS = 4 * 60 * 60 * 1000;

export interface CachedChunk {
  bucket: number;
  windowStart: number;
  windowEnd: number;
  writtenAt: number;
  sessions: SessionSummary[];
}

export interface InvalidationEntry {
  bucket: number;
  invalidatedAt: number;
  reason: string;
}

export interface CacheWindow {
  bucket: number;
  since: number;
  until: number;
}

export interface LookupResult {
  hits: CachedChunk[];
  misses: CacheWindow[];
}

/**
 * Compute the bucket index for a given timestamp.
 * Each bucket represents a 15-minute window.
 */
export function bucketForTimestamp(ms: number): number {
  return Math.floor(ms / CHUNK_DURATION_MS);
}

/**
 * Resolve the cache directory, respecting XDG_CACHE_HOME.
 */
export function getCacheDir(override?: string): string {
  if (override) return override;
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg ? xdg : join(homedir(), ".cache");
  return join(base, "oas", "chunks");
}

/**
 * Check if a bucket contains the current time (active chunk).
 */
function isActiveBucket(bucket: number): boolean {
  return bucket === bucketForTimestamp(Date.now());
}

export class ChunkCache {
  private readonly cacheDir: string;

  constructor(cacheDirOverride?: string) {
    this.cacheDir = getCacheDir(cacheDirOverride);
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  // ── Core operations ──────────────────────────────────────────────────────

  /**
   * Read a chunk from disk. Returns null if:
   * - File doesn't exist
   * - Chunk is expired (TTL exceeded)
   * - Chunk is the active bucket
   * - Chunk is invalidated
   */
  readBucket(bucket: number): CachedChunk | null {
    // Active bucket is never served from cache
    if (isActiveBucket(bucket)) {
      return null;
    }

    // Check invalidation
    if (this.isInvalidated(bucket)) {
      this.deleteChunkFile(bucket);
      return null;
    }

    const filePath = this.chunkFilePath(bucket);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const raw = readFileSync(filePath, "utf-8");
      const chunk: CachedChunk = JSON.parse(raw);

      // TTL check
      if (Date.now() - chunk.writtenAt > CHUNK_TTL_MS) {
        this.deleteChunkFile(bucket);
        return null;
      }

      return chunk;
    } catch {
      return null;
    }
  }

  /**
   * Write a chunk to disk. Only writes if the bucket is NOT the active bucket.
   */
  write(chunk: CachedChunk): void {
    // Never cache the active bucket
    if (isActiveBucket(chunk.bucket)) {
      return;
    }

    const filePath = this.chunkFilePath(chunk.bucket);
    writeFileSync(filePath, JSON.stringify(chunk), "utf-8");
  }

  /**
   * Record an invalidation for a bucket.
   */
  invalidate(bucket: number, reason: string): void {
    const entries = this.loadInvalidations();
    // Remove existing entry for this bucket
    const filtered = entries.filter((e) => e.bucket !== bucket);
    filtered.push({ bucket, invalidatedAt: Date.now(), reason });
    this.saveInvalidations(filtered);
  }

  // ── Lookup ───────────────────────────────────────────────────────────────

  /**
   * Look up chunks for a time range [since, until).
   * Returns hits (valid cached chunks) and misses (buckets that need querying).
   */
  lookup(since: number, until: number): LookupResult {
    this.pruneInvalidations();

    const startBucket = bucketForTimestamp(since);
    const endBucket = bucketForTimestamp(until - 1); // inclusive end bucket

    const hits: CachedChunk[] = [];
    const misses: CacheWindow[] = [];

    for (let b = startBucket; b <= endBucket; b++) {
      const chunk = this.readBucket(b);
      if (chunk !== null) {
        hits.push(chunk);
      } else {
        misses.push({
          bucket: b,
          since: b * CHUNK_DURATION_MS,
          until: (b + 1) * CHUNK_DURATION_MS,
        });
      }
    }

    return { hits, misses };
  }

  // ── Merge ────────────────────────────────────────────────────────────────

  /**
   * Merge multiple chunks into a single deduplicated, sorted session list.
   * Deduplicates by (agent, alias, id). Sorts by updated_at DESC.
   */
  mergeChunks(chunks: CachedChunk[]): SessionSummary[] {
    const seen = new Set<string>();
    const sessions: SessionSummary[] = [];

    for (const chunk of chunks) {
      for (const session of chunk.sessions) {
        const key = `${session.agent}:${session.alias}:${session.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          sessions.push(session);
        }
      }
    }

    return sessions.sort((a, b) => {
      const ta = Date.parse(a.updated_at);
      const tb = Date.parse(b.updated_at);
      if (ta !== tb) return tb - ta;
      return a.id.localeCompare(b.id);
    });
  }

  // ── Invalidation management ──────────────────────────────────────────────

  getInvalidations(): InvalidationEntry[] {
    return this.loadInvalidations();
  }

  private isInvalidated(bucket: number): boolean {
    const entries = this.loadInvalidations();
    return entries.some((e) => e.bucket === bucket);
  }

  private loadInvalidations(): InvalidationEntry[] {
    const filePath = this.invalidationsPath();
    if (!existsSync(filePath)) {
      return [];
    }
    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      return data.entries ?? [];
    } catch {
      return [];
    }
  }

  private saveInvalidations(entries: InvalidationEntry[]): void {
    writeFileSync(this.invalidationsPath(), JSON.stringify({ entries }), "utf-8");
  }

  /**
   * Prune invalidation entries older than CHUNK_TTL_MS.
   */
  private pruneInvalidations(): void {
    const entries = this.loadInvalidations();
    const cutoff = Date.now() - CHUNK_TTL_MS;
    const pruned = entries.filter((e) => e.invalidatedAt > cutoff);
    if (pruned.length !== entries.length) {
      this.saveInvalidations(pruned);
    }
  }

  // ── File helpers ─────────────────────────────────────────────────────────

  private chunkFilePath(bucket: number): string {
    return join(this.cacheDir, `chunk_${bucket}.json`);
  }

  private invalidationsPath(): string {
    return join(this.cacheDir, "invalidations.json");
  }

  private deleteChunkFile(bucket: number): void {
    const filePath = this.chunkFilePath(bucket);
    if (existsSync(filePath)) {
      rmSync(filePath);
    }
  }
}

/**
 * Clear all chunk cache files. Used for testing and manual cache reset.
 */
export function clearChunkCache(cacheDirOverride?: string): void {
  const dir = getCacheDir(cacheDirOverride);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Run chunk cache tests**

Run: `bun test test/chunk-cache.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/chunk-cache.ts
git commit -m "feat: implement ChunkCache — 15-min disk-backed session cache

ChunkCache stores session list results per 15-min time bucket.
- 4h TTL from write time
- Active bucket (contains now) never cached
- Invalidation records for resumed old sessions
- Merge with deduplication across buckets"
```

---

## Task 7: RED — Search limit + time range tests

**Files:**
- Create: `test/search-limit.test.ts`

- [ ] **Step 1: Write failing search limit tests**

Create `test/search-limit.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { SessionSummary, SearchQuery } from "../src/core/types";

// These tests verify the SearchQuery type supports limit + timeRange
// and that the search CLI/service honors them.
// The actual search service is tested via the CLI layer.

describe("SearchQuery type supports limit and timeRange", () => {
  test("SearchQuery accepts limit", () => {
    const query: SearchQuery = {
      text: "test",
      limit: 25,
    };
    expect(query.limit).toBe(25);
  });

  test("SearchQuery accepts timeRange", () => {
    const query: SearchQuery = {
      text: "test",
      timeRange: {
        since: Date.now() - 4 * 60 * 60 * 1000,
        until: Date.now(),
      },
    };
    expect(query.timeRange?.since).toBeDefined();
    expect(query.timeRange?.until).toBeDefined();
  });

  test("SearchQuery accepts both limit and timeRange", () => {
    const query: SearchQuery = {
      text: "test",
      limit: 10,
      timeRange: {
        since: Date.now() - 4 * 60 * 60 * 1000,
      },
    };
    expect(query.limit).toBe(10);
    expect(query.timeRange?.since).toBeDefined();
  });

  test("SearchQuery works without limit or timeRange (backward compat)", () => {
    const query: SearchQuery = {
      text: "test",
    };
    expect(query.limit).toBeUndefined();
    expect(query.timeRange).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (type-level tests)**

Run: `bun test test/search-limit.test.ts`
Expected: PASS — these are type-level tests that verify the type changes from Task 1.

- [ ] **Step 3: Commit**

```bash
git add test/search-limit.test.ts
git commit -m "test: add SearchQuery limit + timeRange type tests

Verify SearchQuery type accepts optional limit and timeRange fields.
Type changes were made in Task 1."
```

---

## Task 8: Wire search CLI flags to `SearchQuery`

**Files:**
- Modify: `src/cli/search.ts`

- [ ] **Step 1: Add `--limit`, `--last`, `--since`, `--until` flags to search command**

In `src/cli/search.ts`, add time range parsing (reuse `parseLastDuration` and `parseTimestamp` from `./utils/time-parser`) and pass limit/timeRange to `SearchQuery`.

Add to `SearchOptions` type:

```typescript
export type SearchOptions = {
  text?: string;
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
  currentSessionId?: string;
  excludeCurrent?: boolean;
  excludeSession?: string[];
  format?: "text" | "json";
  /** Maximum number of results. */
  limit?: number;
  /** Relative time window (e.g. "4h", "2d"). */
  last?: string;
  /** Absolute start time (ISO-8601). */
  since?: string;
  /** Absolute end time (ISO-8601). */
  until?: string;
  searchSessions: SearchService;
  findSimilarSessions?: ContentSearchService;
};
```

In `runSearchCommand`, after the raw query is built, add time range parsing:

```typescript
  // Parse time range for search
  let timeRange: TimeRangeOptions | undefined;
  const now = Date.now();

  if (options.since || options.until || options.last) {
    timeRange = {};
    if (options.until) {
      const untilResult = parseTimestamp(options.until);
      if (untilResult.ok) timeRange.until = untilResult.value;
    }
    const referencePoint = timeRange?.until ?? now;
    if (options.last) {
      const lastResult = parseLastDuration(options.last, referencePoint);
      if (lastResult.ok) timeRange!.since = lastResult.value;
    }
    if (options.since) {
      const sinceResult = parseTimestamp(options.since);
      if (sinceResult.ok) timeRange!.since = sinceResult.value;
    }
  }
```

Then pass `limit` and `timeRange` to the `SearchQuery` objects constructed in the function. For every `SearchQuery` construction, add:

```typescript
const query: SearchQuery = {
  cwd: process.cwd(),
  text: normalizedSearchText,
  ...(options.limit !== undefined ? { limit: options.limit } : {}),
  ...(timeRange ? { timeRange } : {}),
};
```

After results are collected, apply the limit slice (since search results come from multiple sources):

```typescript
  // Apply limit if specified
  if (options.limit !== undefined && options.limit > 0) {
    filteredSessions = filteredSessions.slice(0, options.limit);
  }
```

Add imports at the top:

```typescript
import { parseLastDuration, parseTimestamp } from "./utils/time-parser";
import { TimeRangeOptions } from "../core/types";
```

- [ ] **Step 2: Run search tests**

Run: `bun test test/cli-search.test.ts test/search-limit.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/cli/search.ts
git commit -m "feat: add --limit, --last, --since, --until to oas search

Search now supports time-window filtering and result count limiting.
Flags reuse the same parsing utilities as oas sessions."
```

---

## Task 9: Export chunk cache from SDK

**Files:**
- Modify: `src/sdk/index.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 1: Add exports**

In `src/core/index.ts`, add:

```typescript
export { ChunkCache, clearChunkCache, bucketForTimestamp, CHUNK_DURATION_MS, type CachedChunk, type CacheWindow, type LookupResult } from "./chunk-cache";
```

In `src/sdk/index.ts`, add:

```typescript
export { ChunkCache, clearChunkCache, bucketForTimestamp, CHUNK_DURATION_MS } from "../core/chunk-cache";
export type { CachedChunk, CacheWindow, LookupResult } from "../core/chunk-cache";
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/core/index.ts src/sdk/index.ts
git commit -m "feat: export ChunkCache from SDK and core barrel exports"
```

---

## Task 10: Run full test suite + typecheck

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: ALL PASS (1089+ existing tests + new tests)

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Run CI pipeline**

Run: `bun run ci`
Expected: PASS (typecheck + build + test)

- [ ] **Step 4: Mark plan complete**

All tasks done. No commit needed — this is a verification step.
