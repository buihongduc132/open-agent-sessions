# Task for scout

Recon open-agent-sessions repo (cwd). Find ALL skills query + skills stats functionality. Report per-adapter (pi, zcode, claude, agy, opencode, codex, hermes, gemini, antigravity, acpx).

Focus: skill usage analysis, skill search, skill stats, skill inventory, skill fuzzy match.

Key dirs: src/skill-usage/, src/adapters/, src/core/, src/cli/, scripts/skill-usage-heatmap.ts

For EACH adapter, report:
- skill usage analysis? (Y/N)
- skill invocations extracted from sessions? (Y/N)
- skill search/query? (Y/N)
- skill stats (counts, frequency)? (Y/N)
- File:line evidence

Output: markdown table | adapter | skill_query | skill_stats | skill_extract | evidence |

---
Update progress at: /home/bhd/Documents/Projects/bhd/open-agent-sessions/.pi-subagents/artifacts/progress/08bbe86f-2e2a-4eee-bb66-96012ae19d41/progress.md

---
**Output:**
Write your findings to exactly this path: /home/bhd/Documents/Projects/bhd/open-agent-sessions/.pi-subagents/artifacts/outputs/08bbe86f-2e2a-4eee-bb66-96012ae19d41/skill-survey.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

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