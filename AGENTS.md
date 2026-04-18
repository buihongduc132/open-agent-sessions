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
| `pi` / `oh-my-pi (OMP)` | Minor | JSONL event stream + `stats.db` (tokens/costs) + `history.db` (FTS prompts) | `<timestamp>_<id>.jsonl` under `~/.omp/agent/sessions/<slug>/` | Event types: `session`, `model_change`, `thinking_level_change`, `custom_message`, `message`, `compaction` |

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
