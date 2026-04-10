# Goal: `open-agent-sessions` — SDK-First Completion

**File:** `_GOAL_open-agent-sessions.md`
**Created:** 2026-04-07
**Status:** active
**Phase:** Phase 5 — SDK-First Completion
**Last verified against Dolt:** 2026-04-08 00:45 UTC — MATCH (38/38 rows cross-checked, 0 discrepancies)
**Source of truth:** Dolt `requirements` table at `.beads/dolt/` (database: `open_agent_sessions`)

---

## Goal Statement (Declarative)

`open-agent-sessions` is a unified session management library and SDK for AI coding agents. The library exposes adapters for multiple agent platforms. The project is SDK-first: all adapters, the registry, and all types must be composable, importable, and reusable as a TypeScript SDK. The CLI is a thin consumer of the SDK.

---

## Completion Criteria

The goal is complete when ALL of the following are true:

1. All **SDK requirements** (R-34, R-35, R-36, R-37, R-38, R-39) are **done** — 6 done (R-38 workspace, R-39 fork API — done 2026-04-10)
2. All **CLI requirements** (R-08 through R-15) are **done** — 7 done, 1 planned (R-15 TUI wiring); R-18 is in Import, not CLI
3. All **adapter requirements** (R-04, R-05, R-06, R-07, R-21, R-22, R-31) are **done** — 2 done, 2 lib-only, 3 planned
4. All **Cross-Agent requirements** (R-19, R-32, R-33) are **done**
5. All **Export/Import requirements** (R-16, R-17, R-18) are **done**
6. All **Performance requirements** (R-23, R-24) are **done**
7. R-20 (Session Forking) is **unblocked** — R-38 and R-39 (SDK blockers) are now done
8. R-28 (TDD) is **done** and R-29 (CI/CD) is **done**
9. All **Ecosystem requirements** (R-25, R-26, R-27) are **done** or formally closed
10. DRY invariant is **verified** — no duplicate logic across adapters; shared normalization lives in `src/core/normalize.ts` only

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
    WHEN 'Ecosystem'    THEN 8
    WHEN 'Quality'      THEN 9
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
| P1 | Core | R-01, R-02, R-03 — must be done first |
| P1 | SDK | SDK is the foundation; all other work builds on it |
| P2 | CLI | SDK is done → CLI is next consumer |
| P3 | Adapter | SDK + Core done → adapters |
| P4 | Cross-Agent | Cross-agent depends on multiple adapters |
| P5 | Export/Import | Depends on Cross-Agent |
| P6 | Performance | Depends on full adapter set |
| P7 | Ecosystem | Optional, long-horizon |

Provider ordering within adapter work: **opencode > acpx > codex > zed**

---

## Current State Snapshot (2026-04-10 02:50 UTC) — Derived from Dolt Matrix

| Category | Total | Done | Planned | Lib-only | Deferred | Incomplete items |
|----------|-------|------|---------|----------|----------|-----------------|
| Core | 3 | 3 | 0 | 0 | 0 | — |
| SDK | 6 | 6 | 0 | 0 | 0 | — |
| CLI | 8 | 7 | 1 | 0 | 0 | R-15 |
| Adapter | 7 | 2 | 3 | 2 | 0 | R-21, R-22, R-31 |
| Cross-Agent | 4 | 0 | 4 | 0 | 0 | R-19, R-20, R-32, R-33 |
| Export | 2 | 0 | 2 | 0 | 0 | R-16, R-17 |
| Import | 1 | 0 | 1 | 0 | 0 | R-18 |
| Performance | 2 | 0 | 2 | 0 | 0 | R-23, R-24 |
| Ecosystem | 3 | 0 | 3 | 0 | 0 | R-25, R-26, R-27 |
| Quality | 2 | 2 | 0 | 0 | 0 | — |
| **Total** | **38** | **20** | **15** | **2** | **0** | |

> **This snapshot is derived from Dolt.** Query: `SELECT COUNT(*) FROM requirements` — totals are: 20 done, 15 planned, 2 lib-only, 0 deferred. If this snapshot disagrees with Dolt, Dolt wins — update this section to match.

---

## Incomplete Requirements (15 planned)

Ordered by execution priority:

1. **SDK** (P1): — all done (R-38 workspace scoped imports, R-39 session fork API — done 2026-04-10)
2. **CLI** (P2): R-15 (TUI wiring to CLI)
3. **Adapter** (P3): R-31 (acpx), R-21 (Codex full), R-22 (Claude full)
4. **Cross-Agent** (P4): R-19 (cross-agent search), R-20 (session forking), R-32 (git-root scoping), R-33 (named sessions)
5. **Export** (P5): R-16 (CSF), R-17 (Markdown/text)
6. **Import** (P5): R-18 (OpenCode write-path import)
7. **Performance** (P6): R-23 (pagination), R-24 (caching)
8. **Ecosystem** (P7): R-25 (VS Code), R-26 (Web UI), R-27 (Docker)
9. **Quality**: — all done (R-29 CI/CD pipeline — done 2026-04-10)

---

## Files Produced by This Goal

- `src/sdk/index.ts` — SDK entry point (done — R-35)
- `src/adapters/index.ts` — Adapter barrel (done — R-36)
- `src/types/index.ts` — Type-only export (done — R-37)
- `src/sdk/workspace.ts` — Workspace-scoped session factory (done — R-38, 2026-04-10)
- `src/sdk/session.ts` — Session fork API (done — R-39, 2026-04-10)
- `flow/providers/mature/zed/SHAPE.md` — Zed storage shape
- `flow/providers/mature/acpx/SHAPE.md` — acpx storage shape
- `flow/providers/_schemas/zed.md` — Zed TypeScript interfaces
- `flow/providers/_schemas/acpx.md` — acpx TypeScript interfaces
- `flow/providers/_schemas/sdk.md` — SDK export surface documentation

---

## Non-Goals (Scope Control — Declarative)

The following are explicitly excluded from this goal:

1. **Zed adapter** — zed is documented via `flow/providers/mature/zed/SHAPE.md` only; runtime implementation of Zed adapter is not in scope. **acpx adapter (R-31)**, **Codex full (R-21)**, and **Claude full (R-22)** ARE runtime implementations — these requirements are `planned` and require actual code.
2. Real-time session synchronization across agents
3. Guaranteed lossless cross-agent transfer
4. Multi-agent concurrent editing
5. Session merging from multiple sources
6. Agent-to-agent direct communication
7. Universal plugin compatibility across agents
8. Real-time crash recovery / process management (this is acpx's domain, not OAS)

---

*This file is declarative. The "Verification Loop" section describes the algorithm; all items above it are desired end-state only.*
