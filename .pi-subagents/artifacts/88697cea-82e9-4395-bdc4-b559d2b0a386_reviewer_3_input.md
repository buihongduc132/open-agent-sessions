# Task for reviewer

[Read from: /home/bhd/Documents/Projects/bhd/open-agent-sessions/plan.md, /home/bhd/Documents/Projects/bhd/open-agent-sessions/progress.md]

GOTCHA COVERAGE — DO NOT modify any files. Output your findings as your response only.

You are reviewing a DESIGN DOCUMENT for a Command Stats Ingestion System (ingests bash command invocations from CLI agent session logs into an analytics DB). Topic of THIS batch: DEPLOYMENT / SCOPE / INGESTION CORRECTNESS.

GLOBAL SCOPE — no project-specific assumptions.

WEB SEARCH MANDATORY: For each gotcha, search for CDC (change data capture) patterns, idempotency patterns, outbox pattern gotchas. Cite 3-5 sources per finding.

DO NOT re-analyze whether the design is good. Find what was MISSED.

Original items (verbatim):

=== OT1 (open thread) ===
separate-repo-vs-integrated. User said 'could make this as a separate repository, oas is the common function / sdk that it can import and progress'. Hedge ('could') — not locked. Design assumed separate repo (oas-command-stats/). Alternative: new CLI command inside open-agent-sessions repo. Decision needed.

=== LD2 (locked decision) ===
per-session-watermarks. Idempotent ingestion with per-session high watermark. Watermark tracks last_event_ts per session_id. Old sessions with new events above watermark get re-scanned; fully-ingested sessions skipped. Captures NEW changes only.

=== LD4 (locked decision) ===
perf-caching-ease-of-use. Performance, caching, ease-of-use are first-class design constraints. Manifests as: DuckDB columnar storage, materialized views for common aggregations, batched ingestion (10k), in-memory watermarks, single CLI.

=== OT13 (also process question) ===
next-step-choice (see batch 3) — relevant here because deployment choice depends on it.

=== Additional design context ===
Watermark schema (JSON):
  { 'pi:omo': { sessions: { '<session_id>': { last_event_ts, last_event_id, event_count, updated_at } } } }

Outbox ingestBatch pseudocode:
  - Parse command, INSERT INTO cmd_events ON CONFLICT DO NOTHING, UPDATE outbox status=processed
  - All in one transaction; on failure, mark batch failed + increment attempts

Chunking:
  - BATCH_SIZE=10_000, MAX_CONCURRENT_SESSIONS=10
  - PromisePool over sessions, chunk events per session

Multi-agent source ingestion: pi JSONL (147k/day), zcode SQLite (99k/day), hermes SQLite (0/day in observed window). Three different schemas, three different timestamp formats (ISO-8601 vs epoch-ms vs epoch-ms).

Your job:
1. For EACH of OT1, LD2, LD4, OT13 — find 2-5 gotchas.
2. Each gotcha: {rank 1-5, title, what, why_missed, severity, mitigation, sources}.
3. Rank scale: 1=YAGNI, 2=Minor, 3=Moderate, 4=Significant, 5=Sophisticated.
4. Consider: clock skew across agents, what if session_id reused, what if events arrive out-of-order, what if session file rotated/truncated, what if watermark file corrupt, what if outbox grows unbounded, OOM on large batches, partial-failure recovery, version skew between oas and oas-stats if separate repos, what if adapter schema changes upstream.
5. Return ONLY structured findings. Mark cross-cutting gotchas.

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