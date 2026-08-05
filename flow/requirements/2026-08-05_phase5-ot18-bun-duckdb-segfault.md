# Phase 5 — OT18 Bun+DuckDB readonly segfault

Slug: phase5-ot18-bun-duckdb-segfault

## [C1] Problem
- Need DB-level readonly connection for query path.
- duckdb-node native segfaults under Bun.
- 2nd `new Database(path)` on same file, same process → crash.
- Confirmed via isolation repro.

## [C1] Phase 2 stub
- Location: `oas-command-stats/src/storage/duckdb.ts:99` (`openReadOnly`)
- Current: software-level regex guard blocks INSERT/UPDATE/DELETE/etc.
- Not real DB-level readonly.

## [C1] Candidate solutions (from FIX-3)
1. DuckDB CLI shell-out — subprocess for queries
2. Native FFI binding — not duckdb-node
3. Different runtime — Node.js for query path, not Bun
4. Single-instance Database pool — explicit lifecycle

## [A] Acceptance
- Phase 5 contract item (d): `access_mode='read_only'`
- Real DB-level readonly, no segfault.
- Unskip `oas-command-stats/test/unit/storage-read-only.test.ts`.

## [R1] Ref
- Phase 2 GREEN commit: 167ac17
- See [[2026-08-05_phase-2-extract-parse-storage]]
