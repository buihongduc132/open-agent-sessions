# Task for scout

Recon open-agent-sessions repo (cwd). Find ALL tools query + tools stats functionality. Report per-adapter (pi, zcode, claude, agy, opencode, codex, hermes, gemini, antigravity, acpx).

Focus: tool usage extraction, tool search (toolSearchSessions), tool stats (counts, frequency), tool categories.

Key dirs: src/adapters/, src/core/, src/cli/, src/core/subagents.ts (has ToolUsage interface)

For EACH adapter, report:
- tool calls extracted from session messages? (Y/N)
- toolSearchSessions method? (Y/N)
- tool usage stats? (Y/N)
- tools categorized? (Y/N)
- File:line evidence

Output: markdown table | adapter | tool_extract | tool_search | tool_stats | tool_categorize | evidence |

---
Update progress at: /home/bhd/Documents/Projects/bhd/open-agent-sessions/.pi-subagents/artifacts/progress/08bbe86f-2e2a-4eee-bb66-96012ae19d41/progress.md

---
**Output:**
Write your findings to exactly this path: /home/bhd/Documents/Projects/bhd/open-agent-sessions/.pi-subagents/artifacts/outputs/08bbe86f-2e2a-4eee-bb66-96012ae19d41/tool-survey.md
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