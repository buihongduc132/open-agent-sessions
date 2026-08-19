# Task for reviewer

[Read from: /home/bhd/Documents/Projects/bhd/open-agent-sessions/plan.md, /home/bhd/Documents/Projects/bhd/open-agent-sessions/progress.md]

GOTCHA COVERAGE — DO NOT modify any files. Output your findings as your response only.

You are reviewing a DESIGN DOCUMENT for a Command Stats Ingestion System (ingests bash command invocations from CLI agent session logs into an analytics DB). Topic of THIS batch: STORAGE + DB ARCHITECTURE choices.

GLOBAL SCOPE — no project-specific assumptions. Project-agnostic design review.

WEB SEARCH MANDATORY: For each gotcha, search for industry best practices / known failure modes / canonical references. Cite 3-5 sources (URLs or doc titles) per finding.

DO NOT re-analyze whether the design is good. Find what the design MISSED: edge cases, failure modes, invalid assumptions, unconsidered scenarios.

Original items (verbatim text — do NOT need to read any files):

=== OT2 (open thread) ===
which-db-framework. User said 'could utilize db / framework to better structure the data (like timeseries db , timescale , ... )'. Hedge ('could') — not locked. Design recommended DuckDB (embedded, fast, SQL-on-JSON). Alternatives: TimescaleDB (PostgreSQL extension, server process), ClickHouse (overkill), SQLite (slow at >10M with heavy GROUP BY). Decision needed before implementation.

=== OT3 (open thread) ===
scale-target. 250k events/day = 90M/year. DuckDB handles fine; SQLite starts to strain at >10M with heavy GROUP BY. If scale is lower, simpler stack may suffice. If higher, need distributed store.

=== OT9 (open thread) ===
outbox-storage-choice. DuckDB (same as analytics): simple, single file. SQLite: lighter, but DuckDB already in stack. Recommendation: DuckDB (unified).

=== OT11 (open thread) ===
incremental-materialized-views. DuckDB doesn't support incremental MVs natively. Workaround: recompute hourly via cron. Alternative: use dbt for incremental models.

=== OT12 (open thread) ===
multi-process-safety. DuckDB: single-writer, multi-reader. Solution: single ingestion process, multiple query processes. If multiple ingestion processes needed (e.g., parallel agents), need file locking or queue.

=== Additional design context (relevant) ===
- Per-event: ~500 bytes. 91M events/year = 45 GB raw / ~4.5 GB DuckDB-compressed.
- Outbox table fields: id (hash), agent, alias, session_id, event_id, event_ts (TIMESTAMP), raw_command (TEXT), cwd, exit_code, duration_ms, status (pending/processing/processed/failed), attempts, last_error, created_at, processed_at. UNIQUE(agent, alias, session_id, event_id).
- Analytics cmd_events table: id, event_ts, event_date, event_hour (0-23), agent, alias, session_id, cwd, program, subcommand, flags (TEXT[]), positional_args (TEXT[]), exit_code, duration_ms, pipeline_depth, raw_command, created_at. Plus indexes on ts/date/program/cwd/session. Materialized views: cmd_stats_hourly, cmd_flag_stats.

Your job:
1. For EACH of OT2, OT3, OT9, OT11, OT12 — find 2-5 gotchas.
2. Each gotcha: {rank 1-5, title, what (description), why_missed (why original design missed it), severity (impact), mitigation (suggested), sources (3-5)}.
3. Rank scale: 1=YAGNI (theoretical/low impact), 2=Minor (trivial mitigation), 3=Moderate (needs handling), 4=Significant (likely, impacts correctness), 5=Sophisticated (fundamental gap).
4. Return ONLY structured findings. No prose intro/outro. Each gotcha clearly labeled with which OT it covers.
5. NO new design decisions. NO 'I think you should use X instead'. Just gaps in the EXISTING design.
6. Mark cross-cutting gotchas (apply to multiple OTs).

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```