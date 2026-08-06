# Agent Instructions

> **⚠️ TOP AUTHORITY — READ FIRST**
>
> All **requirements, priorities, statuses, ordering, and goal state** live in the Dolt matrix.
>
> **Query it at any time:**
> ```bash
> cd .beads/dolt && dolt sql -q "USE open_agent_sessions; SELECT id, category, title, status, priority FROM requirements ORDER BY CAST(SUBSTRING(id,4) AS SIGNED);"
> ```
>
> - The `_GOAL_open-agent-sessions.md` file is **derived from** the Dolt matrix — never the reverse
> - The `_GOAL_*.md` file documents the verification algorithm and DRY rules
> - Any **contradiction** between this file, the GOAL file, and the Dolt matrix → **Dolt wins**, discard the others
> - If this file says something different from the Dolt matrix → trust Dolt, update this file to match
> - **Never update the Dolt matrix from this file or the GOAL file** — always write status changes directly to Dolt

---

## CLI Agent Session Taxonomy

The `flow/providers/` system maps heterogeneous agent session formats onto a unified `SessionSummary` / `SessionDetail` schema via adapter plugins. Agents are classified into two maturity tiers based on storage architecture.

### Maturity Tiers

| Tier | Description |
|------|-------------|
| **Mature** | SQLite + structured schema, or well-defined JSONL with predictable fields. Rich metadata (tokens, model, tool calls) is available without inference. |
| **Minor** | JSONL event streams with flexible content shapes. Metadata (tokens, costs) either requires auxiliary files or is absent. These are normalised into the unified schema via the adapter pattern. |

The long-term goal is: **Minor agents → Unified Schema → Adapter pattern**, so all agents become queryable through a single interface regardless of their native storage format.

### Agent Reference Table

| Name | Maturity | Storage Type | Session ID Format | Key Metadata Fields |
|------|----------|-------------|-------------------|---------------------|
| `opencode` | Mature | SQLite (`opencode.db`) + JSONL | UUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) | `projects`, `sessions`, `messages`, `message_parts` tables; tool calls stored inline as structured rows |
| `claude` | Mature | JSONL transcripts in `~/.claude/sessions/` | Directory name (human-readable slug) | Content is flexible (`string \| array \| object`); token counts must be inferred |
| `codex` | Mature | SQLite (`state_5.sqlite` threads + `logs_1.sqlite` messages) + JSONL index | Integer thread ID | `messages.message` is a JSON string requiring parse; git context preserved in index |
| `openclaw` | Minor | JSONL event stream per session + `sessions.json` metadata index | UUID (`*.jsonl` filenames) | Index at `~/.openclaw/agents/main/sessions/sessions.json`; per-session stream has mixed event types |
|| `pi` / `oh-my-pi (OMP)` | Minor | JSONL event stream + `stats.db` (tokens/costs) + `history.db` (FTS prompts) | `<timestamp>_<id>.jsonl` under `~/.omp/agent/sessions/<slug>/` | Event types: `session`, `model_change`, `thinking_level_change`, `custom_message`, `message`, `compaction` |
|| `hermes` | Mature | SQLite (`~/.hermes/state.db`, WAL mode, schema v6) | UUID | `sessions` table (id, source, model, title, parent_session_id, billing, tokens); `messages` table (role, content, tool_calls JSON, reasoning); FTS5 `messages_fts`; parent chain for context compression |
|| `zcode` | Mature | SQLite (`~/.zcode/cli/db/db.sqlite`) | `sess_<uuid>` / `sess_subagent_<uuid>` | `session` / `message` / `part` / `tool_usage` tables; `session.parent_id` for parent chain; message role lives inside `message.data` JSON; part type lives inside `part.data` JSON |

### Adapter Interface

Each agent is served by an `Adapter` (defined in `src/core/types.ts`) that implements:

```typescript
interface Adapter {
  readonly version: string;
  listSessions(): SessionSummary[];
  listSessionsByTimeRange?(options: TimeRangeOptions): SessionSummary[];
  searchSessions?(query: SearchQuery): SessionSummary[];
  getSessionDetail?(sessionId: string, options: SessionReadOptions): Promise<SessionDetail>;
}
```

The canonical session key is `(agent, alias, session_id)`. The `AdapterRegistry` in `src/core/types.ts` holds handles for all registered agents and is the single entry point for cross-agent queries.

---

MUST follow TDD approach: 
- RED -> GREEN -> REFACTOR. 
MUST delegate SEPARATE sub agents PER tdd step. 
MUST ensure TESTS are WRITTEN first BEFORE the GREEN. 
MUST prove this by COMMIT these RED tests first THEN start implementing it.

## Hermes Curator — Auxiliary-Model Skill Lifecycle Prompts

The hermes curator (`~/.hermes/hermes-agent/agent/curator.py`) is the canonical example of an auxiliary-model-driven skill lifecycle task: it forks an AIAgent on the `auxiliary.curator` slot to do umbrella-building consolidation over agent-created skills. Its full prompts and assembly logic are captured verbatim in `flow/findings/hermes-curator/`: this is the reference design for any future `pi-curator` adapter or any "skill lifecycle" field on the `SessionSummary` schema.

| File | Symbol / topic |
|------|---------------|
| `flow/findings/hermes-curator/README.md` | TOC + provenance |
| `flow/findings/hermes-curator/curator-review-prompt.md` | `CURATOR_REVIEW_PROMPT` — main umbrella-building prompt (the full `user_message`) |
| `flow/findings/hermes-curator/curator-dry-run-banner.md` | `CURATOR_DRY_RUN_BANNER` — prepended on `--dry-run` |
| `flow/findings/hermes-curator/prune-builtins-note.md` | inline `builtins_note` — overrides rule #1 when `curator.prune_builtins: true` |
| `flow/findings/hermes-curator/prompt-assembly.md` | How banner + review prompt + builtins note + candidate list are composed |
| `flow/findings/hermes-curator/candidate-list-format.md` | Shape of the candidate list the model actually sees |
| `flow/findings/hermes-curator/runtime-and-config.md` | Defaults, `auxiliary.curator` slot precedence, lifecycle gates, fork flags, CLI surface |


## Skill Usage Analyzer (Pi-side curator input)

Pi implementation of the data-collection half of skill lifecycle. 4-tier fuzzy matcher (exact/normalized/alias/Damerau-Levenshtein) + sharded JSON filesystem cache.

- **Library:** `src/skill-usage/` — spec `flow/requirements/skill-usage-analyzer/README.md`, intention `flow/intentions/2026-07-19-skill-usage-analyzer.md`
- **Runner:** `scripts/skill-usage-heatmap.ts` — usage `flow/requirements/skill-usage-heatmap-script/README.md`, intention `flow/intentions/2026-07-20-skill-usage-heatmap-script.md`. Run weekly: `bun run scripts/skill-usage-heatmap.ts --days 7`

<lesson_learn>
1: Verifier ceremony violations — caveman/structure/showcase/LSL all skipped during verifier run
Context: Operating as verifier v1 for goal 745f748b, emitted APPROVE verdict correctly but violated 6 behavioral ceremony rules (caveman off, wall of text, no structure, showcase markdown, diplomatic speech, no LSL)
Solutions: LSL codified at flow/lesson_learn/2026-08-05_verifier-ceremony-violations/. Before any verdict: check caveman mode, structure sections, no-showcase, ≤30 words/line, create LSL if mistake.
Ref: 2026-08-05_verifier-ceremony-violations/index.md

2: DuckDB VARCHAR[] bind failure — duckdb-node does NOT auto-bind JS arrays to list columns
Context: Phase 2 GREEN cmd_events INSERT. JS string arrays → VARCHAR[] cols threw "Type VARCHAR with value 'hi' can't be cast to VARCHAR[]".
Solutions: Bind as JSON.stringify(arr) + explicit `?::VARCHAR[]` cast in SQL. Applies to ALL list-type columns. Cast MUST be in SQL not JS.
Ref: 2026-08-05_duckdb-varchar-array-bind/index.md (src/storage/ingest.ts:152)

3: DuckDB Date normalize mangling — normalize recursed INTO Date, returned empty {}
Context: Phase 2 NORMALIZE_FN. typeof Date==="object" → object recursion iterated Date own-keys (none) → TIMESTAMP cols returned as {}.
Solutions: Early-return `if (v instanceof Date) return v;` BEFORE object recursion. typeof unreliable for class instances — list all pass-through classes first.
Ref: 2026-08-05_duckdb-date-normalize-mangling/index.md (src/storage/duckdb.ts:22)

4: mvdan semicolon→newline statement_count — printer rewrites `;` to `\n`, old splitter blind
Context: Phase 2 parse. `a || b ; c` gave statement_count=2 (expected 3). mvdan/sh print() normalizes `;`→`\n`; old token-level `;` splitter missed it.
Solutions: New countLogicalCommands() walks NORMALIZED string treating `\n`+`;`+`&&`+`||` as separators. Never assume printer preserves source separators.
Ref: 2026-08-05_mvdan-semicolon-newline-statement-count/index.md (src/parse/mvdan.ts:337)

5: Bun+duckdb-node segfault on 2nd Database instance — uncatchable SIGSEGV
Context: Phase 2 readonly conn. 2nd `new Database(path)` same file/same Bun process → Napi::Error + SIGSEGV. Native crash, uncatchable.
Solutions: STUB = software-only regex readonly guard (block write SQL). Phase 5 MUST solve via CLI shell-out, FFI, different runtime, OR singleton pool. duckdb-node `readonly` option ALSO segfaults under Bun.
Ref: 2026-08-05_bun-duckdb-node-segfault-second-instance/index.md (src/storage/duckdb.ts:99)

6: PII regex env-assign lookahead — bare TOKEN=value missed + double-redact iteration
Context: Phase 4 PII redaction. Original regex required 1+ char before PII keyword → bare `TOKEN=value` not redacted. Fix added lookahead allowing keyword at start. Plus negative lookahead `(?![REDACTED:)` to skip already-redacted values from earlier passes.
Solutions: Lookahead `(?=[A-Za-z_]?...)` allows zero-prefix keyword. Negative lookahead guards idempotency across 6 ordered regex passes (bearer→AWS→git-https→sshpass→env→cc).
Ref: 2026-08-05_pii-regex-env-assign-lookahead/index.md (oas-command-stats/src/parse/pii.ts:36)

7: gitnexus_impact skipped Phase 4 — panic-write under delegation infra failure
Context: Phase 4 GREEN (abf792d) edited ingestBatch/SCHEMA_DDL/OAS_CS_SCHEMA_VERSION/KNOWN_SOURCE_SCHEMA_VERSIONS without running gitnexus_impact or detect_changes. Delegation infra broke (claude session-limit, gemy dead, codex missing, ocxo weak, pi -p MCP deadlock).
Solutions: Retrospective blast radius via rg (GitNexus index stale — symbols not found). ingestBatch: 21 test callers + 1 re-export, additive change = LOW risk. SCHEMA_DDL: 1 caller (duckdb.ts:80), additive cols. OAS_CS_SCHEMA_VERSION: module-private. KNOWN_SOURCE_SCHEMA_VERSIONS: 3 callers, array-grow = backward-compat. MANDATORY pre-edit: (1) gitnexus_impact upstream (2) gitnexus_impact downstream (3) edit (4) gitnexus_detect_changes (5) commit only if expected scope. Phase 6+: pre-commit hook to enforce.
Ref: 2026-08-05_gitnexus-impact-skipped-phase4/index.md

8: Auditor ceremony violations — 11 violations incl self-verify APPROVED = HARD-CONTRACT BREACH
Context: Auditor for goal msf02zrg-6cp56a emitted approved with 11 ceremony violations. V9: self-verify hash 7c6a90e1 ≠ independent verifier-loop approval (req 2+ independent verifiers). Correct verdict = disapproved.
Solutions: LSL codified at flow/lesson_learn/2026-08-06_auditor-ceremony-violations/. Before any verdict: caveman ON, structure present, ≤30 words/line, self-verify ≠ approval, load skills first.
Ref: 2026-08-06_auditor-ceremony-violations/index.md
</lesson_learn>

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **open-agent-sessions** (4533 symbols, 7943 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/open-agent-sessions/context` | Codebase overview, check index freshness |
| `gitnexus://repo/open-agent-sessions/clusters` | All functional areas |
| `gitnexus://repo/open-agent-sessions/processes` | All execution flows |
| `gitnexus://repo/open-agent-sessions/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
