# Phase 2 — Extraction Core + mvdan/sh Parser + DuckDB Storage

> **Source**: goal `msf02zrg-6cp56a`, task `t2`. Branch `feat/oas-command-stats`.
> **Predecessor**: Phase 1 SDK carve-out (commit `ec2c553`, verifier hash `080526-08fed2e4`).
> **Successor**: Phase 3 (effective_cwd + repo derivation) — gated on Phase 2 verifier hash.

## Contract Recap (from `t2` task definition)

Done when ALL of:
- (a) **mvdan/sh v3 WASM parser** integrated (`sh-syntax@^0.6.0`), parse_success rate measured on 247k cmds bucketed by complexity (OT43) — ≥95% on medium+complex, ≥99% on simple
- (b) **`parse_status` (ok|partial|failed) + `parser_version` + `parser_notes`** columns on `cmd_events`; failed rows → quarantine table
- (c) **event_id derivation per agent**:
  - pi = `hash(session_file_path + byte_offset_of_record)`
  - zcode = `tool_usage.id`
  - hermes = synthetic (hash of message_id + tool_call_idx + session_id)
- (d) **extraction idempotency test**: re-run identical input → 0 new outbox rows
- (e) **DuckDB single file** (outbox + cmd_events same DB, one tx)
- (f) **per-row try/catch inside ingestBatch** (NOT batch rollback) — poison row isolated, rest commits
- (g) **idempotency ON CONFLICT (agent, alias, session_id, event_id)** — NOT surrogate id
- (h) **watermark = perf hint only** (scan-start bound), NOT skip predicate — outbox UNIQUE is idempotency oracle
- (i) **`source_schema_version` per batch**, fail-loud on unknown fields
- (j) **verifier-loop approval hash recorded**

## Respects Rank-5 Blockers + Critical OTs

- **OT20** (parser quote-awareness, rank5) → mvdan/sh WASM
- **OT21** (parser choice) → tier-2 WASM parser selected
- **OT22** (parse_status columns) → schema
- **OT23** (poison-batch isolation, rank5) → per-row try/catch
- **OT26** (outbox+analytics same file) → single DuckDB
- **OT28** (pi event_id instability) → byte_offset hash
- **OT45** (ts-watermark drops late events, rank5) → outbox UNIQUE as oracle
- **OT48** (event_id column required) → schema
- **OT16** (per-row upsert slow path) → batch COPY + dedupe strategy
- **OT49-X4** (adapter schema drift) → source_schema_version

## Schema (single DuckDB file)

```sql
-- Watermarks table (perf hint only — NOT idempotency oracle)
CREATE TABLE IF NOT EXISTS session_watermarks (
  agent           VARCHAR NOT NULL,
  alias           VARCHAR NOT NULL,
  session_id      VARCHAR NOT NULL,
  scan_started_at TIMESTAMP,        -- last scan start bound (for skip-fast path)
  scan_completed_at TIMESTAMP,
  source_schema_version VARCHAR,
  PRIMARY KEY (agent, alias, session_id)
);

-- Outbox table — raw extracted events, idempotency oracle
CREATE TABLE IF NOT EXISTS outbox (
  outbox_id          BIGINT PRIMARY KEY,    -- surrogate, monotonic
  agent              VARCHAR NOT NULL,
  alias              VARCHAR NOT NULL,
  session_id         VARCHAR NOT NULL,
  event_id           VARCHAR NOT NULL,      -- per-agent derivation (c)
  source_schema_version VARCHAR NOT NULL,   -- (i)
  event_ts           TIMESTAMP NOT NULL,    -- raw event ts (UTC)
  extracted_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- LD5 load-bearing fields only — NO full payload
  raw_command        VARCHAR,               -- raw cmd text (pre-parse)
  cwd_hint           VARCHAR,               -- session cwd (Phase 3 derives effective_cwd)
  exit_code          INTEGER,
  duration_ms        INTEGER,
  processing_status  VARCHAR NOT NULL DEFAULT 'pending',  -- pending|processing|processed|failed
  UNIQUE (agent, alias, session_id, event_id)             -- (g) idempotency target
);

-- Processed cmd events — parser output
CREATE TABLE IF NOT EXISTS cmd_events (
  agent              VARCHAR NOT NULL,
  alias              VARCHAR NOT NULL,
  session_id         VARCHAR NOT NULL,
  event_id           VARCHAR NOT NULL,
  event_ts           TIMESTAMP NOT NULL,
  program            VARCHAR,               -- mvdan/sh AST walk
  subcommand         VARCHAR,
  positional_args    VARCHAR[],             -- DuckDB native list type
  flags              VARCHAR[],             -- expanded short-flag runs
  pipeline_depth     INTEGER,
  statement_count   INTEGER,
  cwd_hint           VARCHAR,
  -- (b) parser signals
  parse_status       VARCHAR NOT NULL,      -- ok|partial|failed
  parser_version     VARCHAR NOT NULL,
  parser_notes       VARCHAR,               -- e.g. "binary_in_args", "ambiguous_redirect"
  processed_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent, alias, session_id, event_id)        -- (g) mirrors outbox
);

-- Quarantine — failed parse rows for forensics + retry
CREATE TABLE IF NOT EXISTS cmd_quarantine (
  agent              VARCHAR NOT NULL,
  alias              VARCHAR NOT NULL,
  session_id         VARCHAR NOT NULL,
  event_id           VARCHAR NOT NULL,
  raw_command        VARCHAR,
  parse_status       VARCHAR NOT NULL,      -- always 'failed' here
  parser_version     VARCHAR,
  parser_notes       VARCHAR,
  quarantined_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent, alias, session_id, event_id)
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_meta (
  key   VARCHAR PRIMARY KEY,
  value VARCHAR NOT NULL
);
-- row: ('oas_command_stats_schema_version', '0.1.0')
-- row: ('duckdb_version_pinned', '1.4.4')
```

## Module Breakdown

```
oas-command-stats/
├── src/
│   ├── extract/
│   │   ├── pi.ts           # JSONL byte-offset hash event_id
│   │   ├── zcode.ts        # tool_usage.id event_id
│   │   ├── hermes.ts       # synthetic event_id
│   │   ├── registry.ts     # per-agent dispatch
│   │   └── types.ts        # ExtractedEvent, SourceSchema
│   ├── parse/
│   │   ├── mvdan.ts        # sh-syntax WASM wrapper + version pin
│   │   ├── ast-walk.ts     # extract program/subcommand/flags/pipeline
│   │   └── complexity.ts   # OT43 bucketing (simple/medium/complex)
│   ├── storage/
│   │   ├── duckdb.ts       # connection, schema bootstrap, migration
│   │   ├── ingest.ts       # ingestBatch w/ per-row try/catch (OT23)
│   │   ├── watermark.ts    # perf-hint only (OT45)
│   │   └── schema.ts       # DDL + source_schema_version gate
│   ├── types/
│   │   └── contract.ts     # ParseStatus, CommandEvent, etc.
│   ├── cli.ts              # `oas-stats ingest` entrypoint
│   └── index.ts
├── test/
│   ├── unit/
│   │   ├── parse-mvdan.test.ts        # OT20 quote/escape/ANSI/$'...'
│   │   ├── parse-ast-walk.test.ts     # program/subcommand/pipeline
│   │   ├── parse-complexity.test.ts   # OT43 bucketing
│   │   ├── extract-pi-event-id.test.ts
│   │   ├── extract-zcode-event-id.test.ts
│   │   ├── extract-hermes-event-id.test.ts
│   │   ├── ingest-per-row-isolation.test.ts   # OT23 poison batch
│   │   ├── ingest-idempotency.test.ts         # OT45/OT48
│   │   ├── ingest-schema-version.test.ts      # OT49-X4 fail-loud
│   │   └── watermark-perf-hint.test.ts        # OT45
│   └── integration/
│       ├── full-ingest-cycle.test.ts          # end-to-end outbox→cmd_events
│       ├── same-tx-outbox-events.test.ts      # OT26
│       └── parse-rate-on-sample.test.ts       # 247k cmds measurement (a)
├── scripts/
│   └── measure-parse-rate.ts                  # OT43 complexity bucketing
└── package.json
```

## Worst-First Test List (RED phase)

Per worst-first-testing skill (Zone 4 error-propagation → Zone 1 empty → Zone 3 multi-flag → Zone 2 boundary → Zone 5 state → Zone 6 permission → happy path LAST).

### Zone 4 — Error Propagation (write FIRST)
1. **`test_poison_row_isolated_rest_of_batch_commits`** (OT23): batch of 10, row #5 throws → rows 1-4, 6-10 committed to outbox, row #5 in cmd_quarantine, ingestBatch returns 9-success-1-failed summary, NO batch rollback
2. **`test_unknown_source_schema_version_aborts_batch`** (OT49-X4): source_schema_version='99.99' → ingestBatch throws SchemaVersionError, 0 rows committed
3. **`test_parser_failure_quarantines_not_lost`** (OT22): cmd with invalid syntax → outbox row written, cmd_events has NO row, cmd_quarantine has 1 row with parse_status='failed'
4. **`test_partial_parse_flags_both_statuses`** (OT22): mixed batch where some parse ok, some partial, some failed → all 3 statuses present, partial has parser_notes

### Zone 1 — Empty/Nil
5. **`test_empty_session_yields_zero_outbox_rows`**: SessionDetail with 0 tool calls → 0 outbox rows, no error
6. **`test_missing_cwd_field_defaults_null_no_crash`**: event with cwd=undefined → cwd_hint=NULL, ingest continues

### Zone 3 — Multi-Flag Interaction
7. **`test_idempotency_on_conflict_dedupes_exact_same_input`** (OT45/OT48/d): re-run identical extraction → 0 NEW outbox rows (UNIQUE constraint hit), watermark still advances
8. **`test_idempotency_target_is_event_id_not_surrogate`** (OT48/g): two distinct events with same cmd text but different event_id → 2 outbox rows, NOT deduped
9. **`test_same_tx_outbox_and_cmd_events_atomic`** (OT26/e): if cmd_events insert fails for whole batch, outbox NOT written either (single DuckDB file, one tx)

### Zone 2 — Boundary
10. **`test_event_id_byte_offset_stable_on_append`** (OT28/c): pi session appended with new events → old event_ids unchanged (byte_offset of existing records stable)
11. **`test_watermark_does_not_skip_late_events`** (OT45/h): event with ts EARLIER than watermark still ingested (watermark is hint, not predicate)

### Zone 5 — State Mutation
12. **`test_second_ingest_same_session_only_new_events`** (LD2/d/h): ingest session, then ingest again with 5 new appended events → exactly 5 new outbox rows, original N rows untouched
13. **`test_parser_version_in_idempotency_upgrade_backfills`** (OT22): upgrade parser v1→v2 → existing rows NOT re-processed (idempotency holds by event_id), but NEW rows get v2

### Zone 6 — Permission
14. **`test_read_only_connection_refuses_writes`** (OT18 prep): access_mode='read_only' on queries → INSERT throws, but SELECT works

### Happy Path (LAST)
15. **`test_happy_path_pi_session_basic_ingest`**: small pi JSONL with 3 bash calls → 3 outbox rows + 3 cmd_events rows, all parse_status='ok'
16. **`test_happy_path_zcode_session_basic_ingest`**
17. **`test_happy_path_hermes_session_basic_ingest`**

## TDD Delegation Plan

Per project AGENTS.md + goal custom prompt:
- **RED subagent** writes ALL tests above, commits RED (tests fail with `ReferenceError: module not found`). One subagent, one commit.
- **GREEN subagent #1** (separate context) implements modules until tests pass. May NOT modify tests. Commits GREEN.
- **REFACTOR subagent** (separate context) cleans up, no behavior change. Commits REFACTOR.
- **Verifier-loop** (jewilo CLI) — 2+ verifiers, blind review, unanimous APPROVE required.

## Verifier-Loop Strategy

1. After GREEN+REFACTOR committed, run:
   ```
   jewilo NEW "Phase 2 of oas-command-stats: extraction core + mvdan/sh parser + DuckDB storage. Verify all 10 contract items (a)-(j) satisfied, OT20/OT21/OT22/OT23/OT26/OT28/OT45/OT48/OT16/OT49-X4 respected, worst-first tests cover all 6 zones. Reference: flow/plans/2026-08-05_phase2-extraction-core/README.md"
   ```
2. If REJECT → spawn FIXER subagent with raw rejection → re-run jewilo RESUME
3. If APPROVE (2+ verifiers unanimous) → record hash, mark t2 done, advance to t3

## Open Items (DO NOT block Phase 2)

- OT1 (separate repo) — deferred; code lives in this worktree under `oas-command-stats/`
- OT14 (DuckDB format stability) — Phase 7
- OT19 (real MVs) — Phase 7
- OT40 (outbox TTL ≥ analytics TTL) — Phase 4/7
- 247k cmds sample — needs regeneration (was at `/tmp/cmds_24h.txt`, now missing); measure-parse-rate.ts script will generate from local pi sessions if file absent
