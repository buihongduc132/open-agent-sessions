# Task for worker

Fix bug: `oas session list --agent pi` returns zcode sessions (filter silently ignored).

**Root cause:** `runSessionsCommand` in `src/cli/sessions.ts` builds `SessionsQuery = { cwd, timeRange }` — has NO `agent`/`alias` fields. `SessionsOptions` type also lacks them. `bin/oas` handleSessionsCommand doesn't pass `--agent`/`--alias` from parsed.options. So the filter is dropped on the floor despite being advertised in help text.

**Reference impl:** `src/cli/list.ts` `runListCommand` DOES support `--agent`/`--alias` correctly via `SessionListQuery` — copy that pattern.

**TDD approach (STRICT — RED first, separate commit, then GREEN):**

Worktree: `/home/bhd/Documents/Projects/bhd/open-agent-sessions` (main repo, on a new branch `fix/session-list-agent-filter`)

**RED phase first:**
1. Create `test/cli-sessions-agent-filter.test.ts` with tests that WILL fail against current code:
   - `oas session list --agent pi --last 8h` returns ONLY pi sessions (no zcode)
   - `oas session list --agent zcode --last 8h` returns ONLY zcode sessions
   - `oas session list --alias omo` filters by alias
   - `oas session list --agent pi --alias omo` combines both filters
   - `oas session list` (no filter) returns sessions from all agents (regression check)
2. Use existing test patterns from `test/cli-sessions.test.ts` for setup (mock adapters, etc.)
3. Commit RED: `git commit -m "test(sessions): RED — agent/alias filter ignored by session list"`

**GREEN phase (separate commit):**
1. `src/cli/sessions.ts`:
   - Add `agent?: AgentKind` and `alias?: string` to `SessionsOptions` type
   - Add `agent?: AgentKind` and `alias?: string` to `SessionsQuery` type
   - In `runSessionsCommand`: parse/validate `agent` via `parseAgent` (copy from list.ts) and `alias` via `parseAlias`, set into query
   - Pass query.agent/query.alias to getSessions
2. `bin/oas` handleSessionsCommand: pass `agent: parsed.options["agent"]` and `alias: parsed.options["alias"]` to runSessionsCommand
3. Update `createSessionsService` (wherever it lives — find via grep) to honor query.agent/alias — likely needs to filter adapters or post-filter results. Mirror what `createListService` does in `src/core/list.ts`.
4. Run tests, all pass.
5. Commit GREEN: `git commit -m "fix(sessions): honor --agent/--alias in session list"`

**Verification:**
- `bun test test/cli-sessions-agent-filter.test.ts` → all pass
- `bun run typecheck` → 0 errors
- `bun test` (full regression) → no new failures vs baseline
- Manual: `./bin/oas session list --agent pi --last 8h --limit 20` returns ONLY pi sessions

**Constraints:**
- DO NOT touch `src/cli/list.ts` (it's correct, just the reference)
- DO NOT strip `--agent` from help text — fix the impl, not the docs
- If createSessionsService signature change is invasive, prefer post-filter approach (filter result.sessions by agent/alias after fetch) to minimize blast radius
- One writer per worktree — you own this branch

Report back: commit hashes for RED and GREEN, test counts before/after, typecheck result.

---
**Output:**
Write your findings to exactly this path: /home/bhd/Documents/Projects/bhd/open-agent-sessions/.pi-subagents/session-agent-filter-fix-output.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Review gate: required by reviewer.

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
    },
    {
      "id": "criterion-2",
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