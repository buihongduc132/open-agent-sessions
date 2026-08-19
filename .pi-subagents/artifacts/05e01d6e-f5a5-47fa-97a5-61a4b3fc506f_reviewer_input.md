# Task for reviewer

[Read from: /home/bhd/Documents/Projects/bhd/open-agent-sessions/plan.md, /home/bhd/Documents/Projects/bhd/open-agent-sessions/progress.md]

VERIFY inventory accuracy. Cross-check every claim in flow/{skills,tools,mcp}/inventory.yml against actual source code. This is a verifier loop pass/fail gate.

Inventory files:
- flow/skills/inventory.yml (7 items)
- flow/tools/inventory.yml (5 items)
- flow/mcp/inventory.yml (7 items)

For EACH item, verify EVERY adapter field value (implemented/missing/standalone/core/partial/na/gap) against the cited source. Report:
- VERIFIED (claim matches code)
- INCORRECT (claim wrong — show actual code evidence)
- UNVERIFIABLE (claim ambiguous)

Key claims to verify:
1. skills: only `pi=standalone` (src/skill-usage/*). All adapters = missing skill search.
2. tools/tools-extract-parts: opencode/hermes/gemini/antigravity/zcode = implemented; pi/claude/codex/acpx = missing.
3. tools/tools-search-sessions: only opencode/hermes/zcode implemented; rest missing.
4. tools/tools-stats-callcount + tools-categorize + tools-mcp-tag = `core` for all adapters (src/core/subagents.ts).
5. mcp/mcp-server-discovery: ALL missing.
6. mcp/mcp-config-parse: ALL missing.
7. mcp/mcp-isMcp-heuristic: `core` for all (src/core/subagents.ts:187).
8. mcp/mcp-agy-adapter: agy does NOT exist in code.
9. mcp/mcp-acpx-agentkind: acpx in adapters/index.ts but NOT in AgentKind (src/config/types.ts).

Evidence method: rg/grep the cited files. Cite file:line for each verdict.

Verdict at end: PASS or FAIL. If FAIL, list every incorrect field value with the correct value.

Output format: per-item verdict table + final PASS/FAIL.

---
Update progress at: /home/bhd/Documents/Projects/bhd/open-agent-sessions/.pi-subagents/artifacts/progress/05e01d6e-f5a5-47fa-97a5-61a4b3fc506f/progress.md

---
**Output:**
Write your findings to exactly this path: /home/bhd/Documents/Projects/bhd/open-agent-sessions/.pi-subagents/artifacts/outputs/05e01d6e-f5a5-47fa-97a5-61a4b3fc506f/verify-inventory.md
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