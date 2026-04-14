# Performance Improvement Plan — OAS TUI

> **Context:** User measured real-world latency on a machine with 7748 total sessions
> (opencode: 1563, codex: 6185). All `list()` operations take 13–28 seconds.
> The `getSession` detail cache (QuickLRU, 50 entries) is already fast at 14ms.

---

## Findings: Root Causes of Slowness

### B-1 — `list()` (14,552ms for 7748 sessions): No list cache, full table scan every call

**Location:** `src/core/list.ts:111` → `collectSessions` → `adapter.listSessions()` (all adapters)

`collectSessions` calls `adapter.listSessions()` on every invocation — no list cache
whatsoever. Each call re-reads and re-normalizes all 7748 sessions from disk.
For the non-paginated path, all results must be loaded (that's fundamental), but the
absence of any caching layer means repeated calls (TUI re-renders, scroll, filter
change) are fully expensive every time.

---

### B-2 — `list(limit=20)` (13,850ms): Ignores `limit`, loads all sessions then slices

**Location:** `src/core/list.ts:121–183` (`listSessionsPaginated`) + opencode adapter

When `limit` is set without a cursor (`after`), `listSessionsPaginated` calls
`adapter.listSessionsByTimeRange({ since: undefined, limit })`. The opencode DB adapter
receives `since: undefined` and therefore issues:

```sql
SELECT s.id, s.project_id, ..., s.time_updated DESC  -- NO time filter
```

It applies `LIMIT 50` (the adapter default), but `limit=20` from the query is
**never forwarded** as `options.since` — the DB loads the top 50 sessions and
returns them. The core then slices to 20. Even worse, when `since` is `undefined`,
the opencode DB adapter should NOT be hitting the DB at all for the unfiltered case;
it should short-circuit to `listSessionsByTimeRangeFromDb` with `until` set to "now"
and `limit` set to the requested `limit`.

The Codex adapter has **no** `listSessionsByTimeRange` at all — it falls back to the
full `listSessions()` → `filterInProcess()` path, loading all 6185 Codex sessions on
every paginated call.

---

### B-3 — Pagination page 2 (28,275ms, worst): `skipSessionId` silently dropped

**Location:** `src/core/list.ts:149–150`; `src/adapters/opencode.ts:350–412`

`listSessionsPaginated` correctly decodes `skipSessionId` from the cursor (line 136),
but **never passes it to the adapter call** on line 149:

```typescript
const result = adapter.listSessionsByTimeRange({ since, limit });
//                                                           ↑
//                                                           skipSessionId missing
```

The DB adapter's `listSessionsByTimeRangeFromDb` receives `skipSessionId: undefined`
and does not filter it out. The in-process `filterInProcess` fallback also does not
handle `skipSessionId`. This means the cursor session reappears on page 2 and must be
filtered out in a post-processing step after ALL sessions are already loaded.

---

### B-4 — `list(agent=opencode)` (14,867ms): Agent filter applied in-process after full load

**Location:** `src/core/list.ts:189–211` (`applyFilters`)

All agents' sessions are loaded first, then `applyFilters` iterates them to keep only
`agent === "opencode"`. The adapter `listSessionsByTimeRange` has no knowledge of the
agent filter — it returns sessions from all configured adapters (or all sessions for
the single adapter being listed). The opencode DB adapter already scopes to the CWD
project, but cannot filter by "opencode" because the agent kind is a fixed constant
in the adapter instance.

---

### B-5 — Codex adapter has no `listSessionsByTimeRange` (fallback to full scan)

**Location:** `src/adapters/codex.ts`

The Codex adapter (`src/adapters/codex.ts`) implements only `listSessions()`. It has
no time-range method, so every paginated call triggers the `filterInProcess` fallback
in `listSessionsPaginated` — loading all 6185 Codex sessions into memory on every
request. This is the single biggest structural problem: with 6185 sessions, Codex is
the dominant cost on every mixed-agent query.

---

## Specific Fixes (Prioritized)

---

### Fix F1: Wire `skipSessionId` through to all adapter calls

**Priority:** P0 — Broken behavior, not just slow

**What:** Pass `skipSessionId` from `listSessionsPaginated` into
`adapter.listSessionsByTimeRange`.

**Where:** `src/core/list.ts:149`

**Current (broken):**
```typescript
const result = adapter.listSessionsByTimeRange({ since, limit });
```

**Fix:**
```typescript
const result = adapter.listSessionsByTimeRange({ since, limit, skipSessionId });
```

Also update `listSessionsByTimeRangeFromDb` (`src/adapters/opencode.ts:350`) to add
`skipSessionId` handling:

```sql
AND s.id != ?
```

**Why:** Without this, the cursor session reappears on the next page and must be
filtered post-load. Fixing it at the DB layer is O(1) per row vs O(n) post-filter.
Estimated improvement: **–200ms on page-2 calls**.

**How:** Add one optional parameter to the SQL params array, guarded by an
`if (options.skipSessionId !== undefined)`.

**Estimated improvement:** –200ms (page 2), eliminates post-filter re-sort.

---

### Fix F2: Codex adapter — implement `listSessionsByTimeRange`

**Priority:** P0 — Structural bottleneck; Codex holds 80% of sessions

**What:** Implement `listSessionsByTimeRange` on the Codex adapter, mirroring the
opencode approach: one SQL query with `time_updated >= since` + `LIMIT`.

**Where:** `src/adapters/codex.ts`

**Why:** Codex has 6185 of 7748 sessions (80%). Every paginated call that includes
Codex currently loads all 6185 sessions into memory via `filterInProcess`. With a
native implementation, Codex would return only the top 50 matching sessions in
milliseconds. Estimated improvement: **–11,000ms on mixed-agent paginated calls**.

**How:**
1. Read `src/adapters/codex.ts` to find the existing `listSessions` SQL
2. Copy the `TimeRangeOptions` parameter shape from opencode's
   `listSessionsByTimeRangeFromDb`
3. Add `WHERE ... time_updated >= ? LIMIT 50` to the existing query
4. Wire it as `listSessionsByTimeRange` in the adapter return object
5. Handle `skipSessionId` the same way as opencode

**Estimated improvement:** –11,000ms (80% of 13,850ms × mixed-agent calls).

---

### Fix F3: Default to `limit=50` even without explicit cursor (high-water mark)

**Priority:** P0 — Fastest win, eliminates unnecessary work on common TUI startup

**What:** When `limit` is set (e.g. `limit=20`) and no cursor is present (`after` is
undefined), pass `since: undefined` but also pass the adapter's `until` bound as
"now" — this does not change the opencode DB behavior materially. More importantly,
change the TUI default: when the user opens the TUI without any filters, always use
`limit=50` (the virtual window). Only load older sessions on demand.

**Where:** `src/tui/list-model.ts` (TUI default); `src/core/list.ts:104` (default
branch routing logic)

**Why:** The TUI only displays ~20 rows at a time. Loading 7748 sessions on startup
serves no purpose. Setting `limit=50` means the DB query gets `LIMIT 50` applied, not
just the final slice. Estimated improvement for the TUI startup path: **–13,000ms**.

**How:**
- In `list-model.ts`, make `DEFAULT_LIST_LIMIT = 50` and always pass `limit`
  to the list service on startup.
- The opencode adapter already applies `LIMIT` in SQL — confirm `limit=50`
  is forwarded when `since` is `undefined`.

**Estimated improvement:** –13,000ms on TUI startup (no longer loads 7748 sessions).

---

### Fix F4: `list()` (non-paginated) — add list result cache

**Priority:** P1 — Repeated calls are fully redundant

**What:** Add a `QuickLRU`-based list cache in `src/core/registry.ts` alongside the
existing `detailCache`. Cache key = serialized query params (agent + alias + q).

**Where:** `src/core/registry.ts` (new cache alongside R-40 detailCache)

**Why:** The TUI re-renders the list on filter changes, window focus, and
navigation. Without caching, each re-render re-reads all sessions from disk.
Estimated improvement: **–14,000ms on repeated `list()` calls**.

**How:**
```typescript
// Cache key: only the filter dimensions that affect results
const listCacheKey = (query: SessionListQuery) =>
  JSON.stringify({ agent: query.agent, alias: query.alias, q: query.q });

const listCache = new QuickLRU<string, SessionSummary[]>({ maxSize: 50 });
```

- **Cache lookup:** happens before `collectSessions` in `listSessions`
- **Cache population:** after `collectSessions` + `applyFilters` + `compareSessions`
- **TTL:** 30 seconds (sessions are updated by the agent, not the TUI)
- **Invalidation:** call `listCache.clear()` when `invalidateDetailCache` is called
  (session was updated); call when a new session is created via `forkSession`
- **Max entries:** 50 (one per unique query profile)
- **Cache miss path:** unchanged `collectSessions` + `applyFilters`

**Estimated improvement:** –14,000ms on repeated calls within TTL window.

---

### Fix F5: OpenCode adapter — fix `since=undefined` to not load full table

**Priority:** P1 — opencode already has LIMIT but query routing is wrong

**What:** When `listSessionsByTimeRange` is called with `since=undefined` and a `limit`,
the opencode DB adapter should still apply `ORDER BY time_updated DESC LIMIT N` —
not a full table scan. The current SQL is correct (it has `ORDER BY` and `LIMIT`),
but the core `listSessionsPaginated` is routing to `listSessionsByTimeRange` correctly
when `limit` is set. The real issue is that `since=undefined` with `limit=20` causes
the adapter to return the first 50 (its default) rather than the requested 20.

**Where:** `src/adapters/opencode.ts:388` (`limitClause` computation)

**Current:**
```typescript
const limit = options.limit !== undefined ? options.limit : 50;
```

**Fix:** The adapter correctly uses `options.limit` when provided. The problem is in
the TUI / caller: it should always pass `limit` when asking for sessions. This is
already addressed by Fix F3. No code change needed here — just ensure callers pass
`limit`.

**Estimated improvement:** N/A (fixed by Fix F3).

---

### Fix F6: Forward agent/alias filter to adapter if possible

**Priority:** P2 — Nice-to-have, reduces in-process filtering

**What:** If `query.agent` or `query.alias` is set, and the registry has exactly one
matching adapter, consider calling only that adapter's `listSessionsByTimeRange`.
For multi-agent registries, fall back to current behavior.

**Where:** `src/core/list.ts:121–183` (`listSessionsPaginated`)

**Why:** If `agent=opencode` is set and the registry has only one opencode adapter,
there's no need to call Codex's `listSessions` at all. This eliminates the Codex
fallback scan entirely for single-agent filtered queries. Estimated improvement:
**–11,000ms on `list(agent=opencode)` calls** (Codex would be skipped).

**How:** Before the adapter loop in `listSessionsPaginated`, check if
`query.agent` is set and exactly one adapter matches. If so, call only that adapter.
If multiple adapters match (e.g. two opencode aliases), call all matching ones.

**Estimated improvement:** –11,000ms on single-agent filtered queries.

---

## High-Water Mark / Virtual Window Strategy

**Goal:** Never load all 7748 sessions on startup. Load the most recent N by default.

### Recommended Default: N = 50

- TTY display typically shows 20–25 rows
- `LIMIT 50` in SQL is fast (indexed on `time_updated`)
- 50 is the existing adapter default — no behaviour change for explicit calls
- Provides "scroll buffer" of 25 sessions above/below viewport

### Implementation Approach

| Layer | Change |
|-------|--------|
| `src/tui/list-model.ts` | Define `const DEFAULT_LIMIT = 50`. Always pass `{ limit: DEFAULT_LIMIT }` on startup and on first load. |
| `src/core/list.ts` | Non-paginated branch (`list()`) — keep as-is (no limit = full load, intentional for exports/search). |
| `src/tui/list-model.ts` | Implement "load more" on scroll-near-bottom: append to existing list, track `hasMore`. |

### Scroll-to-Bottom Protocol

```
1. TUI renders first 50 sessions (fast: ~500ms)
2. User scrolls near bottom
3. TUI calls list(query, { after: lastCursor, limit: 50 })
4. Core returns next 50 sessions + new cursor
5. TUI appends to displayed list
6. Repeat until hasMore === false
```

### Back-to-Top

When the user presses `g` or navigates to top, the TUI discards the current list
and calls `list(query, { limit: 50 })` — fast path, no full reload.

**Estimated improvement on startup:** from 14,552ms → ~500ms (first 50 sessions only).

---

## Caching Strategy for `list()`

### Cache Architecture

```
┌─────────────────────────────────────────────────┐
│  listSessions(registry, query)                   │
│                                                 │
│  1. buildCacheKey(query)                        │
│  2. if cacheHit && !stale → return cached       │  ← ~0ms
│  3. collectSessions(registry)                   │  ← 13,000ms (first call)
│  4. applyFilters + sort                         │
│  5. cache.set(key, result)                      │
│  6. return result                              │
└─────────────────────────────────────────────────┘
```

### Cache Key Design

The cache key must uniquely identify the result set. Query fields that affect
results:

| Field | Affects result? | Include in key? |
|-------|-----------------|----------------|
| `agent` | Yes | ✅ Yes |
| `alias` | Yes | ✅ Yes |
| `q` | Yes | ✅ Yes |
| `limit` | No (slice only) | ❌ No |
| `after` | No (pagination token) | ❌ No |

**Key format:** `JSON.stringify({ agent, alias, q })` — or a lightweight
string like `${agent ?? ""}:${alias ?? ""}:${q ?? ""}`.

### TTL: 30 seconds

- Rationale: agent writes new sessions (fork, new session) happen infrequently
- 30s is short enough to catch new sessions within one TUI session
- Detail cache invalidation (`invalidateDetailCache`) does NOT invalidate the
  list cache — they are independent (different QuickLRU instances)
- List cache invalidation: on `forkSession` completion (new session created)

### Invalidation Triggers

| Event | Invalidate |
|-------|-----------|
| `forkSession` completes (new session created) | Full list cache clear |
| Session detail updated | No list cache invalidation needed (session data changed, not the list) |
| TUI explicit "refresh" | Full list cache clear |
| Config change (agent added/removed) | Full list cache clear |

### Max Entries: 20

- Distinct query combinations are bounded: at most (#agents × #aliases × #search-terms)
- 20 is sufficient for the TUI use case (user typically filters by 1 agent + occasional search)
- LRU eviction when full — oldest query profiles drop first

### Cache is Per-Registry Instance

- The cache lives in `createAdapterRegistry` closure, not a global
- Each `createListService(registry)` call shares the cache with its registry
- Safe for TUI: single registry instance, single cache
- Safe for CLI: each invocation creates a fresh registry → fresh cache (no stale data)

---

## Implementation Order

| # | Fix | Effort | Impact | Depends |
|---|-----|--------|--------|---------|
| F3 | Default `limit=50` on TUI startup | **Low** | –13,000ms startup | None |
| F1 | Wire `skipSessionId` to adapters | **Low** | –200ms page 2 | None |
| F2 | Codex adapter `listSessionsByTimeRange` | **Medium** | –11,000ms per mixed call | None |
| F4 | List result cache (QuickLRU) | **Medium** | –14,000ms repeated calls | F1, F2 |
| F6 | Forward agent filter to adapter | **Low** | –11,000ms single-agent calls | F2 |
| F5 | Verify limit forwarding in opencode | **Low** | Confirmed OK | F3 |

**Total estimated improvement (all fixes combined):**
- TUI startup: 14,552ms → ~500ms (**–14,000ms**)
- Pagination page 2: 28,275ms → ~600ms (**–27,000ms**)
- Repeated `list()` calls: 14,552ms → ~0ms (cache hit, **–14,552ms**)

---

## Verify Plan

### Baseline: `bun test` → 0 fail

```
1070 pass  5 skip  0 fail
Ran 1075 tests across 34 files.
Test time: 32.26s
```

### Tests exercising changed code paths

| Changed file | Tests that cover it |
|-------------|---------------------|
| `src/core/list.ts` | `test/core/list.test.ts` — tests `listSessions`, `listSessionsPaginated`, cursor encode/decode, `collectSessions`, `applyFilters`, `compareSessions` |
| `src/core/registry.ts` | `test/core/registry.test.ts` — tests `createAdapterRegistry`, `detailCache` (R-40), cache key uniqueness |
| `src/adapters/codex.ts` | `test/adapters/codex.test.ts` — tests `listSessions` for Codex |
| `src/adapters/opencode.ts` | `test/adapters/opencode.test.ts` — tests `listSessions`, `listSessionsByTimeRange` for DB and JSONL modes |
| `src/tui/list-model.ts` | `test/tui/list-model.test.ts` — tests list model state machine, pagination, filters |

### What to verify after each fix

| Fix | Verify |
|-----|--------|
| F1 | `bun test src/core/list.test.ts` — cursor pagination tests still pass |
| F2 | `bun test src/adapters/codex.test.ts` — Codex time-range tests pass |
| F3 | `bun test src/tui/list-model.test.ts` — default limit tests pass |
| F4 | `bun test src/core/registry.test.ts` — cache eviction / invalidation tests pass |
| F6 | `bun test src/core/list.test.ts` — agent-filtered pagination tests pass |

### Post-fix total

```
bun test → 0 fail  (expected)
```

If failures occur, they will be in `src/core/list.test.ts` or
`src/adapters/codex.test.ts` — the affected files for F1 and F2.

### Constraints compliance check

| Constraint | Status |
|-----------|--------|
| R-40 detail cache (QuickLRU 50) not broken | ✅ `detailCache` untouched |
| DRY: normalization in `src/core/normalize.ts` only | ✅ All changes use existing `normalizeSessionSummary` |
| All tests pass | ✅ No adapter interface changes |
| `TimeRangeOptions.skipSessionId` preserved | ✅ Field already in types.ts; F1 wires it up |
| Read-only (no write operations added) | ✅ All changes are reads |
| Adapter interface unchanged (R-04, R-05, R-21, R-22) | ✅ No interface changes |

---

## Non-Goals (Out of Scope for This Plan)

- Changing the opencode DB schema
- Adding write-through caching
- Multi-process caching (shared memory)
- Pre-loading sessions on agent startup
- Replacing SQLite with a different storage engine
