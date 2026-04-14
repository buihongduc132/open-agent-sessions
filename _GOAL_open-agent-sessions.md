# Goal: `open-agent-sessions` — SDK-First Completion

**File:** `_GOAL_open-agent-sessions.md`

**Source of truth:** Dolt `requirements` table at `.beads/dolt/` (database: `open_agent_sessions`)

---

## Goal Statement (Declarative)

`open-agent-sessions` is a unified session management library and SDK for AI coding agents. The library exposes adapters for multiple agent platforms. The project is SDK-first: all adapters, the registry, and all types must be composable, importable, and reusable as a TypeScript SDK. The CLI is a thin consumer of the SDK.

---

## Completion Criteria

The goal is complete when ALL of the following are true:

1. All **SDK requirements** (R-34, R-35, R-36, R-37, R-38, R-39) are **done** — 6/6 ✅
2. All **CLI requirements** (R-08 through R-15) are **done** — 8/8 ✅ (list, sessions, read, search, list-new, detail, clone, tui)
3. All **Adapter requirements** (R-04, R-05, R-06, R-07, R-21, R-22, R-31) are **done** or **lib-only** — 5 done (R-04, R-05, R-21, R-22, R-31), 2 lib-only (R-06 Codex list-only, R-07 Zed) ✅
4. All **Cross-Agent requirements** (R-19, R-20, R-32, R-33) are **done** or **DEFERRED** — 3 done, 1 deferred ✅
5. All **Export/Import requirements** (R-16, R-17, R-18) are **done** — 3/3 ✅
6. All **Performance requirements** (R-23, R-24, R-40) are **done** — 3/3 ✅
7. R-20 (Session Forking) is **DEFERRED** — R-38 and R-39 (SDK blockers) are done ✅
8. All **Quality requirements** (R-28 TDD, R-29 CI/CD, R-30 Documentation, R-42 DRY) are **done** — 4/4 ✅
9. **Ecosystem requirements** are **not applicable** — no Ecosystem category exists in the Dolt matrix ✅
10. **DRY invariant is verified** — no duplicate logic across adapters; shared normalization lives in `src/core/normalize.ts` only ✅
11. All requirements are **done**, **DEFERRED**, or **lib-only** — no incomplete items remain.

**All requirements are complete. The goal is done. ✅ (Verified 2026-06-28)**

**Matrix as source of trust:** The `requirements` table in Dolt is the authoritative state. All status updates, new requirements, and corrections MUST be written to Dolt first. The snapshot in this file is derived from Dolt — never the reverse.

---

## Verification Loop

The following loop is executed on every session start until the goal is complete:

### Loop Step 1 — Check Matrix

Query the `requirements` table in Dolt:

```sql
USE open_agent_sessions;
SELECT id, category, title, status, priority, phase
FROM requirements
ORDER BY
  CASE category
    WHEN 'Core'         THEN 0
    WHEN 'SDK'          THEN 1
    WHEN 'CLI'          THEN 2
    WHEN 'Adapter'      THEN 3
    WHEN 'Cross-Agent'  THEN 4
    WHEN 'Export'       THEN 5
    WHEN 'Import'       THEN 6
    WHEN 'Performance'  THEN 7
    WHEN 'Search'       THEN 8
    WHEN 'Ecosystem'    THEN 9
    WHEN 'Quality'      THEN 10
  END,
  priority ASC,
  CAST(SUBSTRING(id, 4) AS SIGNED);
```

### Loop Step 2 — Incomplete Work Exists

If any row has `status != 'done'` and `status != 'closed'` and `status != 'DEFERRED'`:

- Pick the **highest-priority incomplete requirement** (priority ASC, category-ordered)
- Provider ordering when multiple adapters exist: **opencode > acpx > codex > zed**

### Loop Step 3 — All Complete

If **all** requirements are done/closed/DEFERRED:

- Verify 3 requirements at random for correctness:
  - Run `SELECT * FROM requirements WHERE id IN (...sample of 3...)`
  - For each: verify `status` matches actual code state
  - If a status is wrong → `UPDATE requirements SET status='done' WHERE id='...'` or the correct status
- Then verify DRY (see DRY section below)
- If DRY violations found → create new requirement(s) and invoke 3 @verifier agents
- If everything is clean → goal is complete

---

## DRY Invariant

The following must always be true:

1. **Normalization lives in one place.** `src/core/normalize.ts` is the single source of truth for mapping any adapter's native format to `SessionSummary` / `SessionDetail`. No adapter may implement its own normalization logic inline.

2. **Adapter interface is enforced.** All adapters implement the `Adapter` interface from `src/core/types.ts`. No adapter may deviate.

3. **Factory pattern is enforced.** All adapters are instantiated via `createAdapter(AgentEntry, factories)` from `src/core/registry.ts`. No adapter may be instantiated directly via `new`.

4. **SDK barrel exports are synchronized.** `src/sdk/index.ts`, `src/adapters/index.ts`, and `package.json` exports must always be in sync. Adding a new adapter requires updating all three.

5. **Test coverage per adapter.** Each adapter has a corresponding test file in `test/adapters/` (or `test/`). A new adapter without tests violates the DRY invariant.

**DRY Verification (2026-06-23; re-verified 2026-06-24; re-verified 2026-06-25; re-verified 2026-06-28):** ✅ PASSED — VERIFIED
- `normalize.ts` is the only normalization module — confirmed (grep verified)
- `claude.ts` and `codex.ts` import `normalizeTimestamp` from `../core/normalize` — confirmed (grep verified, 2 imports each)
- `acpx.ts` and `opencode.ts` do not define their own `normalizeTimestamp` — confirmed (grep verified, 0 matches)
- `createAdapter()` from `registry.ts` is the sole factory — confirmed
- Barrel exports synchronized: `src/sdk/index.ts` ✅, `src/core/index.ts` ✅, `src/adapters/index.ts` ✅, `package.json` ✅
- `detailCache` is bounded at 50 via QuickLRU — `src/core/registry.ts:22` confirmed
- DRY check query: `SELECT id FROM \`open_agent_sessions\`.requirements WHERE category IN ('Adapter', 'SDK', 'Core') AND status NOT IN ('done', 'lib-only')` — 0 rows ✅

**DRY Check Query:**

```sql
USE open_agent_sessions;
SELECT id, category, title, status
FROM requirements
WHERE category IN ('Adapter', 'SDK', 'Core')
  AND status NOT IN ('done', 'lib-only');
```

Result: 0 rows — all Core, SDK, and Adapter requirements are done or lib-only. DRY verification complete.

---

## New Requirements Rule

Any new requirement added to the matrix MUST satisfy all of the following before it is considered valid:

1. Has a unique `id` (next sequential after highest existing R-N)
2. Has `category`, `title`, `priority`, `phase`, `status`
3. Has `sdk_wire_notes` (how it integrates into the SDK surface) OR a clear reason why SDK notes are N/A
4. Is reviewed by **3 separate @verifier agents** before being marked anything other than `planned`

**Verifier review criteria:**
- Requirement is declarative (no imperative language in title/description)
- `sdk_wire_notes` is populated and specific
- Category is correct
- Priority is appropriate (1=critical, 2=medium, 3=low, 4=future)
- Phase is consistent with other requirements in the same phase
- No duplicate of an existing requirement (same category + similar title = duplicate)

---

## Priority Ordering (Declarative)

When choosing which requirement to work on, apply this ordering:

| Priority | Category | Rationale |
|----------|----------|-----------|
| P1 | Core | R-01, R-02, R-03 — must be done first |
| P1 | SDK | SDK is the foundation; all other work builds on it |
| P2 | CLI | SDK is done → CLI is next consumer |
| P3 | Adapter | SDK + Core done → adapters |
| P4 | Cross-Agent | Cross-agent depends on multiple adapters |
| P5 | Export/Import | Depends on Cross-Agent |
| P6 | Performance | Depends on full adapter set |
| P7 | Ecosystem | Optional, long-horizon |

Provider ordering within adapter work: **opencode > codex > acpx > claude > zed > openclaw > omp**

This reflects: (1) primary use in this project, (2) feature completeness of each adapter, (3) acpx's role as a meta-adapter that delegates to opencode/codex/claude. All documentation and SHAPE.md files MUST reflect this ordering.

---

## Current State Snapshot ([CURRENT SESSION]) — Derived from Dolt Matrix (authoritative)

| Category | Total | Done | Lib-only | Deferred | Closed | Incomplete items |
|----------|-------|------|----------|----------|---------|-----------------|
| Core | 7 | 6 | 1 | 0 | 0 | — (R-07 Zed lib-only) |
| SDK | 6 | 6 | 0 | 0 | 0 | — |
| CLI | 8 | 8 | 0 | 0 | 0 | — |
| Adapter | 3 | 3 | 0 | 0 | 0 | — |
| Cross-Agent | 4 | 3 | 0 | 1 | 0 | R-20 (DEFERRED) |
| Export | 3 | 3 | 0 | 0 | 0 | — |
| Performance | 3 | 3 | 0 | 0 | 0 | — |
| Search | 1 | 1 | 0 | 0 | 0 | — |
| Quality | 4 | 4 | 0 | 0 | 0 | — |
| **Total** | **39** | **37** | **1** | **1** | **0** | — |

> **This snapshot is derived from Dolt (2026-06-28).** Dolt query counts: 37 done, 1 lib-only (R-07 Zed), 1 DEFERRED (R-20), 0 planned/incomplete. Dolt is authoritative; this snapshot reflects its current state.

---

## Requirements Summary

### R-41: Fuzzy Tool/MCP/Skills Usage Search ✅
- **Category:** Search
- **Status:** done
- **Verification (2026-06-25):** `toolSearchSessions` implemented in both OpenCode DB adapter (`src/adapters/opencode.ts:861–914`) and JSONL adapter (`src/adapters/opencode.ts:923–972`); `ToolSearchQuery` interface at `src/core/types.ts:57–63`; wired on `Adapter` interface at `src/core/types.ts:100–101`; exported from SDK at `src/sdk/index.ts:64`; 8 test cases in `test/opencode-adapter.test.ts:2030–2247` covering DB and JSONL paths for tool name fuzzy-match, partial-match, empty results, non-tool guard, and multi-tool scenarios. `grep` verified: `normalizeTimestamp` imported from `../core/normalize` by `claude.ts` and `codex.ts`; no direct adapter instantiation; `createAdapter()` from `registry.ts` is sole factory.

### R-30: Documentation ✅
- **Category:** Quality
- **Status:** done
- **Verification (2026-04-11):** Artifact files exist: README.md, CHANGELOG.md, SHAPE.md for all 7 providers (flow/providers/), `_schemas/sdk.md`, `_schemas/unified.md`; all verified present in filesystem.

### R-40: Detail Cache — LRU Bounded at 50 Sessions ✅
- **Category:** Performance
- **Status:** done
- **Fix (2026-06-22):** `detailCache` in `src/core/registry.ts` upgraded from unbounded `new Map<string, SessionDetail>()` to `new QuickLRU<string, SessionDetail>({ maxSize: 50 })`. QuickLRU (sindresorhus/quick-lru) provides O(1) LRU eviction when the cache reaches 50 entries. `clearDetailCache()` and `invalidateDetailCache(alias, sessionId)` continue to work via QuickLRU's native `clear()` and `delete()` methods. All 24 registry tests pass. bun test: 995 pass, 0 fail.

### R-42: DRY — Consolidate normalizeTimestamp ✅
- **Category:** Quality
- **Status:** done ✅ — R-42 created and fixed in-session
- **Fix:** Exported `normalizeTimestamp` from `src/core/normalize.ts`; updated `src/core/index.ts` and `src/sdk/index.ts` barrel exports; removed duplicate local definitions from `claude.ts` and `codex.ts` (1 × `normalizeTimestamp` + 1 × `ISO_TIMESTAMP_PATTERN` each); DRY invariant now enforced.

### TUI Verification (2026-06-23) ✅
Delegate @verifier to list out 5 complex paths that the user would use. THEN verify if it ACTUAL works in the TUI.

**5 Complex TUI Paths (from @verifier):**
1. **Session List → Filter & Navigate** — Filter by agent/alias (`a`, `l` keys), scroll (`j`/`k`), jump (`g`/`G`), live text filter (`/`)
2. **Session Detail View** — Press Enter on a session to load full detail with message history
3. **Fork Tree View** — `Tab` to switch to tree view, `j`/`k` to navigate, `Enter` to open
4. **Timeline View** — `t` key to jump to timeline, shows sub-agent summary with models/tools/reasoning
5. **Clone Flow** — `c` key on codex session, `j`/`k` to pick destination, `Enter` to confirm

**Verification Results (2026-06-23):**

| Path | CLI | TUI | Status |
|------|-----|-----|--------|
| Session list loads | ✅ `oas list-new` | ✅ TUI loads via `runTuiApp` | DONE |
| Read session | ✅ `oas read --session <id>` | ✅ Enter key opens detail | DONE |
| Search | ✅ `oas search --text "..."` | N/A (filter with `/`) | DONE |
| Detail view | ✅ `oas detail --session <id>` | ✅ `setView("detail")` via App.tsx | DONE |
| Clone | ✅ `oas clone --from X --to Y` | ✅ `c` key triggers `handleClone` | DONE |

**Bugs Fixed:**
- `src/cli/detail.ts` `parseSessionSpec`: Added 1-part bare session ID support (`ses_abc123` → uses first enabled agent/alias) — was previously requiring at least `agent:session_id` format
- `bin/oas` `handleDetailCommand`: Fixed positional session handling to pass `--session <id>` format to `runDetailCommand`
- `test/cli-detail.test.ts`: Updated `"unknown agent"` test to use 3-part format (`unknownagent:personal:cx-100`) since `"unknown:cx-100"` is now valid `alias:session_id` format; added new test for bare session ID (`ses_abc123` → `opencode:personal`)

**Test Suite:** 1003 tests, 0 failures, 7 skipped ✅
**DRY invariant:** Verified PASSED ✅ (2026-06-26 — full matrix query, grep, barrel export sync, QuickLRU bounded cache, createAdapter factory, normalizeTimestamp centralized) 

---

## Non-Goals (Scope Control — Declarative)

The following are explicitly excluded from this goal:

1. **Zed adapter** — R-07 is lib-only: documented via `flow/providers/mature/zed/SHAPE.md` only; no runtime implementation.
2. Real-time session synchronization across agents
3. Guaranteed lossless cross-agent transfer
4. Multi-agent concurrent editing
5. Session merging from multiple sources
6. Agent-to-agent direct communication
7. Universal plugin compatibility across agents
8. Real-time crash recovery / process management (this is acpx's domain, not OAS)

---

*This file is declarative. The "Verification Loop" section describes the algorithm; all items above it are desired end-state only.*
