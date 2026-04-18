---
name: smoke-e2e-test
description: use when smoke & e2e test.
---

# OAS Smoke & E2E Test Commands

## LIST Commands

### `oas list [N] [--exclude-current] [--format json|text]`
List recent OpenCode sessions. Default limit 10. Optional --exclude-current flag to hide the active session.

### `oas sessions --last DURATION [--since TIMESTAMP] [--until TIMESTAMP] [--limit N] [--format text|json]`
List sessions with time-range filtering. DURATION examples: 4h, 2d, 1w. Returns time-sorted list.

### `oas list-new [--agent NAME] [--alias NAME] [--q QUERY] [--exclude-current] [--format json|text]`
List sessions with agent/alias/query filters. Shows all matching sessions from the registry.

### `oas onboard`
Initialize bd (beads) for the project. Delegates to `bd onboard`.

---

## READ Commands

### `oas read <session-id> [--first N] [--last N] [--all] [--user-only] [--tools] [--role ROLE] [--format text|json|csf|markdown|md] [--output FILE]`
Read session messages. Supports composable flags: --last + --user-only together, --first + --tools together. Default is --last 10.

### `oas read <session-id> --range START:END [--user-only] [--tools] [--format text|json|csf|markdown]`
Read a specific message range (1-indexed, inclusive). Used to zoom into a slice of a long session.

### `oas read <session-id> --first N --tools --user-only --format json`
Audit agent initialization: first N messages filtered to tools calls only, from user/assistant context.

### `oas read <session-id> --last N --user-only --tools --format markdown`
Triage read: last N messages that are either user prompts or tool calls — dense summary of what mattered.

---

## DETAIL Commands

### `oas detail <session-id> [--session SPEC] [--agent NAME] [--alias NAME] [--id SESSION_ID]`
Show session metadata (id, title, agent, alias, created_at, updated_at, message_count, clone info).

---

## SEARCH Commands

### `oas search --text QUERY [--body] [--boolean] [--fuzzy] [--regex] [--exclude-current] [--exclude-session ID] [--limit N] [--format text|json]`
Search sessions by query. --body searches message content (not just titles). --boolean enables AND/OR/NOT parsing via liqe. --fuzzy enables edit-distance matching. --regex enables /pattern/ literal. --exclude-current hides the active session.

### `oas search --text "TERM1 AND TERM2" --body --boolean [--exclude-current]`
Boolean AND: find sessions where both terms appear (title or content).

### `oas search --text "TERM1 OR TERM2" --body --boolean [--format json]`
Boolean OR: find sessions where either term appears.

### `oas search --text "TERM1 NOT TERM2" --body --boolean`
Boolean NOT: find sessions matching TERM1 but excluding those that mention TERM2.

### `oas search --text "/REGEX_PATTERN/i" --body [--format json]`
Regex search: find sessions whose titles/content match the given pattern (case-insensitive).

### `oas search --text "typo_query" --fuzzy --body --exclude-current`
Fuzzy search: find sessions tolerating typos in query terms.

### `oas search --text "content_query" --body --exclude-current --limit 10 --format csf`
Content-only search with current session excluded. Used for finding prior work during active sessions.

### `oas search --text "TERM1 TERM2" --body --boolean --limit 20 --format json | jq ...`
Boolean multi-term search piped to jq for structured extraction and further filtering.

### `oas search --text "error" --scope tree:<root-session-id> [--body]`
Scoped search: find matching sessions only within a specific delegation tree, not across all sessions.

---

## TREE / HIERARCHY Commands

### `oas tree <session-id> [--format text|json]`
Show the full parent→child session tree for a delegation workflow. JSON output for piping to scripts.

### `oas children <session-id> [--format json] [--status failed|success]`
List all direct child sessions spawned by a parent session. Can filter by status.

### `oas parent <child-session-id>`
Show the parent session of a given child — traceability from sub-agent back to orchestrator.

### `oas list --roots-only [--format json]`
List only root (main) sessions — sessions with no parentSessionId.

### `oas list --sub-only [--format json]`
List only sub-agent sessions — sessions that were spawned as children.

---

## CLONE Commands

### `oas clone --from codex:<session-id> --to opencode:<alias>`
Clone a Codex session to OpenCode (codex→opencode only). Preserves clone metadata.

### `oas clone --from codex:<alias>:<session-id> --to opencode:<alias>`
Clone with alias-qualified source spec.

---

## EXPORT Commands

### `oas export <session-ref> [--from SPEC] [--format csf|markdown|text] [--output FILE]`
Export session in CSF (Canonical Session Format), Markdown, or plain text. CSF is the default.

### `oas read --session <id> --range 1:N --format csf`
Export a message range (1 to N) as CSF. Used for checkpoint-based export before forking.

---

## SIMILAR Commands

### `oas similar <session-id> [--top N] [--format text|json]`
Find sessions similar to the given session via hybrid FTS5 + vector KNN + RRF fusion.

---

## CONFIG Commands

### `oas config [--validate] [--path FILE]`
Inspect, validate, or list config file paths. Returns parsed config or validation errors.

---

## PIPELINE / SCRIPT COMBINATIONS

### `oas list --exclude-current --format json | jq '.[] | .id' | wc -l`
Count non-current sessions (for monitoring scripts).

### `oas search --text "TERM" --body --format json | jq -r '.[] | "\(.id)\t\(.title)"' | fzf --preview='oas read {1} --last 20'`
Search → filter → fzf preview workflow for interactive session discovery.

### `oas tree <id> --format json | jq '[recurse(.children[]?) | {id, agent, status}]'`
Export delegation tree as JSON and extract for monitoring/alerting scripts.

### `oas children <id> --format json | jq '.[] | select(.status == "failed") | .id'`
Find failed child sessions of a parent orchestrator session.

### `oas read <id> --first N --tools --format json | jq '[.[] | select(.tool_name == "Bash") | .tool_input.command]'`
Audit agent initialization: extract all Bash commands from the first N tool calls.

### `oas search --text "error" --body --exclude-current --limit 10 --format json`
Find prior sessions discussing an error, excluding the current active session.