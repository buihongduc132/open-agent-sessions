# LSL-7: gitnexus_impact skipped Phase 4 GREEN

- **Date**: 2026-08-05
- **Phase**: 4 GREEN (commit abf792d)
- **Severity**: ceremony violation (no production harm — schema additive)
- **Ref commit**: abf792d (PII redaction + retention, OT30 GDPR)

## Context

Phase 4 GREEN written by primary session after sub-agent delegation infra broke
(claude session-limit, gemy dead, codex missing, ocxo too weak, pi -p MCP
deadlock). Panic-write skipped AGENTS.md hard rule:

> MUST run impact analysis before editing any symbol.
> MUST run gitnexus_detect_changes() before committing.

Source: `/home/bhd/Documents/Projects/bhd/oas-command-stats/AGENTS.md` gitnexus
block, "Always Do" section.

## Symptom

4 symbols edited without blast-radius analysis:
- `ingestBatch` — added redact + computeSignature + new INSERT cols
- `SCHEMA_DDL` — added cmd_text/cmd_signature/retention_hold/sample_excluded
- `OAS_CS_SCHEMA_VERSION` — bumped 0.2.0 → 0.3.0
- `KNOWN_SOURCE_SCHEMA_VERSIONS` — added "0.3.0"

Commit pushed (abf792d) without `gitnexus_detect_changes` cross-check.

## Root Cause

[C1] Panic-write under delegation infra failure — primary session shortcut ceremony to unblock Phase 4.
[C2] No pre-commit gate enforced gitnexus_impact + detect_changes.
[C3] GitNexus index was already stale (pre-Phase-4) — even retroactive impact returns "not found" for edited symbols.

## Solution (retrospective blast radius via grep — GitNexus index stale)

### `ingestBatch` (src/storage/ingest.ts:34)

**Upstream callers** (would have broken if signature changed):
- `src/index.ts:8` — re-export (public API)
- `src/extract/registry.ts:6` — doc reference only
- 21 test files (unit + integration):
  - `test/integration/full-ingest-{hermes,pi,zcode}.test.ts`
  - `test/unit/ingest-*.test.ts` (6 files)
  - `test/unit/parse-*.test.ts` (4 files)
  - `test/unit/pii-redaction-retention.test.ts`
  - `test/unit/crash-recovery-concurrency.test.ts`
  - `test/unit/effective-cwd-repo.test.ts`
  - `test/unit/watermark-perf-hint-not-skip.test.ts`

**Downstream callees** (added new dependency):
- `redact`, `computeSignature` — `src/parse/pii.ts` (Phase 4 new)

**Actual change**: signature unchanged (only added cols + values). All 21
tests passed because additive. **Retro risk**: LOW — additive INSERT cols do
not break existing call sites.

### `SCHEMA_DDL` (src/storage/schema.ts:22)

**Upstream callers**:
- `src/storage/duckdb.ts:80` — `execAll(SCHEMA_DDL)` (DDL bootstrap)
- `src/storage/duckdb.ts:12` — import

**Actual change**: added 4 columns to `cmd_events` + `outbox` tables.
**Retro risk**: LOW — DuckDB `CREATE TABLE IF NOT EXISTS` is idempotent on
fresh DB; existing rows use defaults. Migration path NOT addressed (no ALTER
for existing DBs) — see [R1].

### `OAS_CS_SCHEMA_VERSION` (src/storage/duckdb.ts:20)

**Upstream callers**: none outside duckdb.ts:86 (meta write).
**Retro risk**: NONE — module-private const.

### `KNOWN_SOURCE_SCHEMA_VERSIONS` (src/storage/schema.ts:19)

**Upstream callers**:
- `src/index.ts:9` — re-export
- `src/storage/schema.ts:12,108` — assertKnownSchemaVersion
- `test/unit/ingest-schema-version.test.ts:14,50`

**Actual change**: appended "0.3.0" to array.
**Retro risk**: LOW — array-grow is backward-compatible.

## Retrospective `gitnexus_detect_changes`

GitNexus index for `open-agent-sessions` repo predates Phase 4 — symbols
ingestBatch/SCHEMA_DDL/OAS_CS_SCHEMA_VERSION return "not found".
`detect_changes({scope:"compare", base_ref:"37f4e24"})` only flags
AGENTS.md sections (post-merge LSL ref). Index NOT usable for this
retrospective — grep fallback used instead.

## Mandatory Pre-Edit Ceremony Checklist

Before editing ANY symbol (not just Phase work):

1. `gitnexus_impact({target, direction:"upstream"})` — list callers
2. `gitnexus_impact({target, direction:"downstream"})` — list callees
3. Edit symbol
4. `gitnexus_detect_changes({scope:"unstaged"})` — verify only intended symbols touched
5. Commit only if scope matches expectation

If GitNexus index stale: `rg` fallback (callers via `<symbol>(` , callees via
imports in file), but flag in [CA] — index MUST be rebuilt (`npx gitnexus
analyze`) before next session.

## Panic-Write Guardrails

- Ceremony holds EVEN under delegation failure. Skipping is not a valid
  escape hatch — better to delay Phase than ship without analysis.
- Phase 6+ should add pre-commit hook enforcing:
  - `gitnexus_impact` ran in last 5min for staged .ts files
  - `gitnexus_detect_changes` ran before `git commit`
- If GitNexus down → fail-closed (block commit) until index rebuilt OR human override.

## Gotchas

- GitNexus index for `open-agent-sessions` was built BEFORE Phase 4 schema
  changes — symbols return "not found" until `npx gitnexus analyze` runs.
- Retro blast radius via `rg` is reliable for caller lists but misses
  semantic edges (cross-module data flow). GitNexus preferred when available.
- Additive schema changes (new cols + defaults) are backward-compatible for
  fresh DBs only — existing DBs need ALTER migration (see [R1]).

## Refs

- Phase 4 GREEN commit: `abf792d`
- AGENTS.md hard rule: `AGENTS.md` (gitnexus section, "Always Do")
- Symbols (current HEAD):
  - `oas-command-stats/src/storage/ingest.ts:34`
  - `oas-command-stats/src/storage/schema.ts:19,22`
  - `oas-command-stats/src/storage/duckdb.ts:20,80,86`
- Related LSL (same session):
  - LSL-6 PII regex lookahead (`2026-08-05_pii-regex-env-assign-lookahead/`)
  - LSL-5 DuckDB segfault (`2026-08-05_bun-duckdb-node-segfault-second-instance/`)
