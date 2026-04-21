# Session List: Roots-Only Default + 15-Min Chunk Cache

**Date**: 2026-04-21
**Status**: Draft
**Scope**: `src/core/list.ts`, `src/core/types.ts`, `src/core/chunk-cache.ts` (new), `src/cli/sessions.ts`, `src/cli/search.ts`

---

## Problem

1. **Child sessions pollute the list** — forked/sub-agent sessions appear alongside parents. Users want the default to show **parent (root) sessions only**, with children accessible via explicit opt-in.
2. **No limit on search** — `oas search` returns every matching session with no time-window or count boundary.
3. **Cache is flat and dumb** — current `QuickLRU` (20 entries, 30s TTL) doesn't understand time. Every query either hits or misses wholesale. No ability to reuse partial results across overlapping time windows.

## Requirements

### R1: Roots-only default at SDK level
- `listSessions` defaults to returning **only sessions without `parentSessionId`** (root sessions).
- `rootsOnly` filter applies **before** limit/pagination — the limit counts roots, not roots+children.
- Opt-out: `rootsOnly: false` on `SessionListQuery` shows all sessions (parents + children).
- Applies to SDK, CLI (`oas sessions`, `oas list`), and TUI.
- ⚠️ **Breaking change**: current SDK `listSessions(registry, {})` returns all sessions; new default returns roots only. Consumers must pass `rootsOnly: false` to get old behavior.

### R2: Search limit + time window
- `SearchQuery` gains `limit` and optional `timeRange` (`since`/`until` in ms).
- CLI: `oas search --text "..." --limit 25 --last 4h`.
- SDK: `searchSessions(registry, { text: "...", limit: 25, timeRange: { since: ..., until: ... } })`.

### R3: 15-minute chunk cache (disk-backed)
- Cache directory: `~/.cache/oas/chunks/` (respects `XDG_CACHE_HOME`).
- Each 15-min window is a separate JSON file: `chunk_<bucket>.json` where bucket = `Math.floor(timestamp / 900_000)`.
- **Current/active chunk** (contains "now") is NEVER cached — always live query.
- **Past chunks** are immutable once written.
- **TTL**: 4 hours from write time. Stale chunks are deleted on read.
- **Chunk merging**: queries spanning multiple chunks merge them transparently (sorted, deduplicated by session ID).

### R4: Invalidation for resumed old sessions
- When an old session gets a new `updated_at` (user resumes it), its old chunk must be invalidated.
- Mechanism: `invalidations.json` alongside chunks — maps `bucket → expiresAt`.
- On chunk read: check invalidations. If chunk is invalidated, delete it and re-query.
- Invalidation is recorded by the core `listSessions` flow when it detects `updated_at` changed for a session that was previously in a different chunk.

---

## Architecture

### Data Flow

```
User query { rootsOnly, limit, timeRange }
       │
       ▼
  ChunkCache.lookup(since, until)
       │
       ├─ HIT (all chunks present + valid)
       │     └─ merge chunks → filter rootsOnly → apply limit → return
       │
       └─ MISS (missing/invalidated chunk)
             ├─ query adapters for missing window
             ├─ write new chunk(s) to disk
             └─ merge all → filter rootsOnly → apply limit → return
```

### Chunk File Format

```jsonc
// ~/.cache/oas/chunks/chunk_12345.json
{
  "bucket": 12345,           // Math.floor(timestamp / 900_000)
  "windowStart": 12345000,   // ms epoch
  "windowEnd": 12345900,     // ms epoch (exclusive)
  "writtenAt": 12345678,     // ms epoch — TTL baseline
  "sessions": [
    { "id": "...", "agent": "opencode", "alias": "default", "title": "...", ... }
  ]
}
```

### Invalidation File

```jsonc
// ~/.cache/oas/chunks/invalidations.json
{
  "entries": [
    { "bucket": 12340, "invalidatedAt": 12345678, "reason": "session_updated" }
  ]
}
```

Invalidation entries older than 4h are pruned on read (they're past TTL anyway).

---

## Changes by File

### `src/core/types.ts`
- `SessionListQuery` gains `rootsOnly?: boolean` (default `true` at the `listSessions` function level, not the type itself — the type field is optional, the function defaults it to `true`).
- `SearchQuery` gains optional `limit?: number` and `timeRange?: TimeRangeOptions`.

### `src/core/list.ts`
- `listSessions` / `listSessionsPaginated` / `collectSessions`:
  - Apply `rootsOnly` filter **before** limit/pagination slice.
  - Default `rootsOnly = true` when not explicitly set.
- Integrate with `ChunkCache` for time-ranged queries.
- Record invalidations when detecting `updated_at` changes.

### `src/core/chunk-cache.ts` (NEW)
- `ChunkCache` class:
  - `lookup(since, until): { hits: Chunk[], misses: Window[] }`
  - `write(chunk: Chunk): void`
  - `invalidate(bucket, reason): void`
  - `prune(): void` — delete stale chunks (TTL expired)
- `getCacheDir(): string` — resolves `XDG_CACHE_HOME/oas/chunks/` or `~/.cache/oas/chunks/`
- `bucketForTimestamp(ms: number): number` — `Math.floor(ms / 900_000)`
- `chunkFilePath(bucket: number): string`
- `invalidationsPath(): string`

### `src/cli/sessions.ts`
- No changes needed — rootsOnly is now the default at SDK level.

### `src/cli/search.ts`
- Accept `--limit N` and `--last/--since/--until` flags.
- Pass to `SearchQuery`.

### `src/cli/list.ts`
- Remove post-hoc `rootsOnly` filtering (lines 84-110). The core layer now handles it.

### `src/sdk/index.ts`
- Export `ChunkCache`, `clearChunkCache`, `listSessions` (updated signature).

### `src/tui/list-model.ts`
- `DEFAULT_LIST_LIMIT` stays at 50.
- No rootsOnly change needed — core default handles it.

---

## Chunk Merging Algorithm

When a query spans `[since, until]`:

1. Compute bucket range: `bucketStart = floor(since / 900k)` to `bucketEnd = floor(until / 900k)`.
2. For each bucket:
   - Check invalidation record. If invalidated, treat as miss.
   - Check TTL. If `now - writtenAt > 4h`, treat as miss (delete file).
   - If the bucket contains "now" (active chunk), always miss.
3. Load all valid hit chunks, collect sessions.
4. For missing buckets, query adapters with `listSessionsByTimeRange({ since: bucketStart*900k, until: (bucketEnd+1)*900k })`.
5. Write new chunk files for each populated bucket.
6. Merge all sessions: deduplicate by `(agent, alias, id)`, sort by `updated_at` DESC.
7. Apply `rootsOnly` filter.
8. Apply `limit` slice.

---

## Testing Strategy (TDD)

Tests are written first (RED), then implementation (GREEN), then refactored.

### Unit Tests

1. **`chunk-cache.test.ts`**:
   - Bucket computation: verify 15-min boundaries align correctly.
   - Write + read round-trip.
   - TTL expiry: chunks older than 4h are pruned.
   - Active chunk detection: bucket containing Date.now() is never cached.
   - Invalidation: write → invalidate → read returns miss.
   - Merge: overlapping sessions from two chunks are deduplicated.

2. **`list-roots-only.test.ts`**:
   - `rootsOnly = true` (default) returns only sessions without `parentSessionId`.
   - `rootsOnly: false` returns all sessions (parents + children).
   - Roots-only filter applies BEFORE limit: if 10 roots + 90 children, limit=25 returns 10 roots (not 25 from 100).
   - Cursor pagination with rootsOnly: cursor points to last root, next page starts after it.

3. **`search-limit.test.ts`**:
   - Search with limit returns at most N results.
   - Search with time range only returns sessions in range.
   - Search with limit + time range applies both.

### Integration Tests

4. **`chunk-cache-integration.test.ts`**:
   - Full flow: miss → query adapter → write chunk → hit → return cached.
   - Invalidation on session update: old chunk busted, new chunk written.
   - Multi-chunk merge: query spanning 2+ chunks merges correctly.

---

## Open Questions (Resolved)

| Question | Decision |
|----------|----------|
| Where does rootsOnly live? | SDK/core level, not CLI post-processing |
| rootsOnly default? | `true` — breaking change for SDK consumers |
| rootsOnly field? | Single `rootsOnly?: boolean` field (no separate `includeChildren`) |
| Cache storage? | Disk-backed JSON files per 15-min window |
| TTL strategy? | 4h fixed from write time |
| Active chunk? | Never cached, always live query |
| Invalidation approach? | Per-chunk invalidation record in `invalidations.json` |
| Default limit? | Keep at 50 (user said skip 25 change for now) |
