# Task for reviewer

[Read from: /home/bhd/Documents/Projects/bhd/open-agent-sessions/plan.md, /home/bhd/Documents/Projects/bhd/open-agent-sessions/progress.md]

GOTCHA COVERAGE — DO NOT modify any files. Output your findings as your response only.

You are reviewing a DESIGN DOCUMENT for a Command Stats Ingestion System (ingests bash command invocations from CLI agent session logs into an analytics DB). Topic of THIS batch: OPS / USE-CASE / QUERY tailoring.

GLOBAL SCOPE — no project-specific assumptions.

WEB SEARCH MANDATORY: For each gotcha, search for how observability/logging tools handle these cases (Datadog, Splunk, Elastic, Honeycomb, Grafana Loki). Cite 3-5 sources per finding.

DO NOT re-analyze whether the design is good. Find what was MISSED.

Original items (verbatim):

=== LD1 (locked decision) ===
programmatic-only-no-ui. Programmatic stats only — NO UI (TUI/dashboard/web) in scope for v1. Stats surfaced via SQL queries or CLI output.

=== LD3 (locked decision) ===
sysops-query-tailoring. Schema + queries tailored to sysops/devops questions: (1) recent cmds + args, (2) most-run cmds ranking, (3) time-of-day histogram for cmd X. Brief-view first, drill-down via oas to exact session.

=== OT4 (open thread) ===
live-or-batch. Dashboard (poll every N min) vs ad-hoc query on demand? Design assumed ad-hoc (CLI `oas-stats query`). If live dashboard needed, adds polling layer + caching invalidation.

=== OT10 (open thread) ===
retention-policy. Outbox: 7 days (configurable). Analytics: 90 days (configurable). Recommendation: start with 7d/90d, tune based on disk usage.

=== OT13 (open thread) ===
next-step-choice. Three paths offered: (1) Capture as OpenSpec change (`/opsx:new oas-command-stats`), (2) Spike DuckDB on real data first, (3) Keep exploring (dig into viz, args semantics, cross-agent patterns). User did NOT pick.

=== Additional design context ===
- 6 sysops query examples defined (recent commands, args for git, most-run, time-of-day histogram, drill-down to session, cross-cwd counts).
- CLI surface: `oas-stats ingest [--agent X --alias Y] [--force]`, `oas-stats query --last 24h --by program`, `oas-stats status`, `oas-stats reset`.
- Workflow: 'stats for overview then oas to drill down to the exact session if needed' (user verbatim).
- Data sources ingest from: pi (~/.pi/agent/sessions JSONL), zcode (~/.zcode/cli/db/db.sqlite), hermes (~/.hermes/state.db SQLite).

Your job:
1. For EACH of LD1, LD3, OT4, OT10, OT13 — find 2-5 gotchas.
2. Each gotcha: {rank 1-5, title, what, why_missed, severity, mitigation, sources}.
3. Rank scale: 1=YAGNI, 2=Minor, 3=Moderate, 4=Significant, 5=Sophisticated.
4. Consider: privacy/PII in commands, GDPR/retention legal issues, query ergonomics for ops under pressure, alert thresholds, timezones for 'time-of-day' histograms, what 'recent' means across agents on different machines, schema migration pain when no UI.
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