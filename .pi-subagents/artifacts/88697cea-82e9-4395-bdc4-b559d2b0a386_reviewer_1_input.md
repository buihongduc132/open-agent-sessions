# Task for reviewer

[Read from: /home/bhd/Documents/Projects/bhd/open-agent-sessions/plan.md, /home/bhd/Documents/Projects/bhd/open-agent-sessions/progress.md]

GOTCHA COVERAGE — DO NOT modify any files. Output your findings as your response only.

You are reviewing a DESIGN DOCUMENT for a Command Stats Ingestion System (ingests bash command invocations from CLI agent session logs into an analytics DB). Topic of THIS batch: PARSING + EXTRACTION choices.

GLOBAL SCOPE — no project-specific assumptions.

WEB SEARCH MANDATORY: For each gotcha, search for industry best practices on shell command parsing, AST tools, edge cases in bash syntax. Cite 3-5 sources per finding.

DO NOT re-analyze whether the design is good. Find what was MISSED.

Original items (verbatim):

=== OT5 (open thread) ===
args-depth. Top-3 flags per program (cheap) vs full flag frequency (expensive storage, noisy)? Design assumed full flags[] array. Could prune to top-N per program to save space.

=== OT6 (open thread) ===
cross-cwd-patterns. E.g., 'which repos use --force most?' — needs cwd in schema from day 1. Design includes cwd. If not needed, can drop cwd index to save space.

=== OT7 (open thread) ===
pipeline-attribution. Count every cmd in pipeline (accurate, more events) vs only first cmd (cheap, loses visibility into pipes)? Design assumed count all. Could add pipeline_depth field + only parse first cmd.

=== OT8 (open thread) ===
bashlex-vs-manual-parser. bashlex: accurate, handles edge cases, python dependency. Manual: fast, no deps, ~80% accuracy. Recommendation: start manual, upgrade to bashlex if needed.

=== LD5 (locked decision) ===
outbox-pattern. Extraction writes raw events to outbox table; processor consumes outbox → analytics. Decouples extract from transform. Do NOT copy everything — only load-bearing fields (program, subcommand, flags, cwd, ts, exit_code, duration).

=== Additional design context ===
Manual parser implementation (proposed):
  - Strip leading `cd <path> &&` regex
  - Strip leading env vars (FOO=bar)
  - Strip leading sudo/timeout
  - Split pipeline by `|`
  - First command's tokens[0] = program, rest = args
  - subcommand = args[0] for known programs (git/npm/gh/docker/pnpm)
  - flags = args.filter(startsWith('-'))

Real sample command from data: `cd /home/bhd/Documents/Projects/bhd/beet-orches && echo "=== find manual-line route ==="; timeout 15 grep -rnE "manual.*line|line.*item|POST.*line|/lines" components/mod-contractor-payment/backend/src/routes/invoices.ts 2>/dev/null | grep -iE "line|manual" | head -15`

Your job:
1. For EACH of OT5, OT6, OT7, OT8, LD5 — find 2-5 gotchas.
2. Each gotcha: {rank 1-5, title, what, why_missed, severity, mitigation, sources}.
3. Rank scale: 1=YAGNI, 2=Minor, 3=Moderate, 4=Significant, 5=Sophisticated.
4. Consider edge cases: heredocs, subshells $(), backticks, command substitution, process substitution <(), xargs, find -exec, multi-line scripts, ANSI escapes, locale-specific chars, quoted strings with spaces.
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