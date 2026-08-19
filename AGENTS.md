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

## oas-command-stats (separate repo)

Companion repo `../oas-command-stats/` consumes OAS adapters as `@open-agent-sessions/sdk` to ingest bash command stats into DuckDB. Design + gotcha findings + locked decisions live at `../oas-command-stats/flow/findings/2026-08-04_oas-command-stats/` (NOT in this repo).

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
