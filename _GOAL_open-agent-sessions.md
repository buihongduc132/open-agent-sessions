# Goal: `open-agent-sessions` — SDK-First Completion

**File:** `_GOAL_open-agent-sessions.md`
**Created:** 2026-04-07
**Status:** active
**Phase:** Phase 5 — SDK-First Completion
**Last verified against Dolt:** 2026-04-07 (17 done / 18 planned / 2 lib-only / 1 deferred)

---

## Goal Statement (Declarative)

`open-agent-sessions` is a unified session management library and SDK for AI coding agents. The library exposes adapters for multiple agent platforms. The project is SDK-first: all adapters, the registry, and all types must be composable, importable, and reusable as a TypeScript SDK. The CLI is a thin consumer of the SDK.

---

## Completion Criteria

The goal is complete when ALL of the following are true:

1. All **SDK requirements** (R-34, R-35, R-36, R-37, R-38, R-39) are **done** — 4 done, 2 planned (R-38 workspace, R-39 fork API)
2. All **CLI requirements** (R-08 through R-15) are **done** — 7 done, 1 planned (R-15 TUI wiring)
3. All **adapter requirements** (R-04, R-05, R-06, R-07, R-21, R-22, R-31) are **done** — 2 done, 2 lib-only, 3 planned
4. All **Cross-Agent requirements** (R-19, R-32, R-33) are **done**
5. All **Export/Import requirements** (R-16, R-17, R-18) are **done**
6. All **Performance requirements** (R-23, R-24) are **done**
7. R-20 (Session Forking) is **unblocked** — all blocking requirements resolved
8. R-28 (TDD) is **done** and R-29 (CI/CD) is **done**
9. All **Ecosystem requirements** (R-25, R-26, R-27) are **done** or formally closed
10. DRY invariant is **verified** — no duplicate logic across adapters; shared normalization lives in `src/core/normalize.ts` only

**Matrix as source of trust:** The `requirements` table in Dolt is the authoritative state. All status updates, new requirements, and corrections MUST be written to Dolt first. The snapshot in this file is derived from Dolt — never the reverse.

---

## Verification Loop (Declarative — Repeating Until Goal is Complete)

The following loop is executed on every session start until the goal is complete:

### Loop Step 1 — Check Matrix

Query the `requirements` table in Dolt:

```sql
USE open_agent_sessions;
SELECT id, category, title, status, priority, phase
FROM requirements
ORDER BY
  CASE category
    WHEN 'SDK'        THEN 1
    WHEN 'CLI'        THEN 2
    WHEN 'Adapter'    THEN 3
    WHEN 'Cross-Agent'THEN 4
    WHEN 'Export'     THEN 5
    WHEN 'Import'    THEN 6
    WHEN 'Performance'THEN 7
    WHEN 'Ecosystem' THEN 8
    WHEN 'Quality'   THEN 9
  END,
  priority ASC,
  CAST(SUBSTRING(id, 4) AS SIGNED);
```

### Loop Step 2 — Incomplete Work Exists

If any row has `status != 'done'` and `status != 'closed'` and `status != 'DEFERRED'`:

- Pick the **highest-priority incomplete SDK requirement** (category = 'SDK', priority ASC)
- If all SDK done → pick the **highest-priority incomplete CLI requirement**
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

3. **Factory pattern is enforced.** All adapters are instantiated via `createAdapter(AdapterEntry)` from `src/core/registry.ts`. No adapter may be instantiated directly.

4. **SDK barrel exports are synchronized.** `src/sdk/index.ts`, `src/adapters/index.ts`, and `package.json` exports must always be in sync. Adding a new adapter requires updating all three.

5. **Test coverage per adapter.** Each adapter has a corresponding test file in `test/adapters/`. A new adapter without tests violates the DRY invariant.

**DRY Check Query:**

```sql
USE open_agent_sessions;
-- No adapter may have duplicate normalization logic
-- This is enforced by code review; query verifies status
SELECT id, category, title, status
FROM requirements
WHERE category IN ('Adapter', 'SDK', 'Core')
  AND status != 'done';
```

If any adapter or SDK requirement is incomplete, DRY verification is deferred until all are done.

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
| P1 | SDK | SDK is the foundation; all other work builds on it |
| P1 | Core | R-01, R-02, R-03 — must be done first |
| P2 | CLI | SDK is done → CLI is next consumer |
| P3 | Adapter | SDK + Core done → adapters |
| P4 | Cross-Agent | Cross-agent depends on multiple adapters |
| P5 | Export/Import | Depends on Cross-Agent |
| P6 | Performance | Depends on full adapter set |
| P7 | Ecosystem | Optional, long-horizon |

Provider ordering within adapter work: **opencode > acpx > codex > zed**

---

## Current State Snapshot (2026-04-07 20:07 UTC) — Dolt Matrix is Source of Trust

| Category | Total | Done | Planned | Lib-only | Deferred |
|----------|-------|------|---------|----------|----------|
| Core | 3 | 3 | 0 | 0 | 0 |
| SDK | 6 | 4 | 2 | 0 | 0 |
| CLI | 8 | 7 | 1 | 0 | 0 |
| Adapter | 7 | 2 | 3 | 2 | 0 |
| Cross-Agent | 4 | 0 | 3 | 0 | 1 |
| Export | 2 | 0 | 2 | 0 | 0 |
| Import | 1 | 0 | 1 | 0 | 0 |
| Performance | 2 | 0 | 2 | 0 | 0 |
| Ecosystem | 3 | 0 | 3 | 0 | 0 |
| Quality | 2 | 1 | 1 | 0 | 0 |
| **Total** | **38** | **17** | **18** | **2** | **1** |

> Incomplete: R-38, R-39 (SDK); R-15 (CLI); R-21, R-22, R-31 (Adapter); R-19, R-32, R-33 (Cross-Agent); R-16, R-17 (Export); R-18 (Import); R-23, R-24 (Performance); R-25, R-26, R-27 (Ecosystem); R-29 (Quality). Source: Dolt `requirements` table.

> **Note:** This snapshot is derived from `SELECT COUNT(*) FROM requirements` in Dolt. The Dolt `requirements` table is the source of truth. If this snapshot disagrees with Dolt, Dolt wins — update this section to match.

---

## Files Produced by This Goal

- `src/sdk/index.ts` — SDK entry point (exists, needs completion)
- `src/adapters/index.ts` — Adapter barrel (exists, needs sync)
- `src/types/index.ts` — Type-only export (exists)
- `src/sdk/workspace.ts` — Workspace-scoped session factory (R-38, not yet implemented)
- `src/sdk/session.ts` — Session fork API (R-39, not yet implemented)
- `flow/providers/mature/zed/SHAPE.md` — Zed storage shape
- `flow/providers/mature/acpx/SHAPE.md` — acpx storage shape
- `flow/providers/_schemas/zed.md` — Zed TypeScript interfaces
- `flow/providers/_schemas/acpx.md` — acpx TypeScript interfaces
- `flow/providers/_schemas/sdk.md` — SDK export surface documentation

---

## Non-Goals (Scope Control — Declarative)

The following are explicitly excluded from this goal:

1. **Zed adapter** — zed is documented via `flow/providers/mature/zed/SHAPE.md` only (R-35 is planned, not done); runtime implementation of Zed adapter is not in scope until R-35 is promoted to planned with implementation intent. **acpx adapter (R-31)** and **Codex full (R-21)** and **Claude full (R-22)** ARE runtime implementations — these requirements are `planned` and require actual code
2. Real-time session synchronization across agents
3. Guaranteed lossless cross-agent transfer
4. Multi-agent concurrent editing
5. Session merging from multiple sources
6. Agent-to-agent direct communication
7. Universal plugin compatibility across agents
8. Real-time crash recovery / process management (this is acpx's domain, not OAS)

---

*This file is declarative. The "Verification Loop" section describes the algorithm; all items above it are desired end-state only.*
