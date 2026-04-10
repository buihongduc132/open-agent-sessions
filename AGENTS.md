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

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd sync               # Sync with git
```

For GitHub Copilot users:
Add the same content to .github/copilot-instructions.md

How it works:
   • bd prime provides dynamic workflow context (~80 lines)
   • bd hooks install auto-injects bd prime at session start
   • AGENTS.md only needs this minimal pointer, not full instructions

This keeps AGENTS.md lean while bd prime provides up-to-date workflow details.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Auto-syncs to JSONL for version control
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Auto-Sync

bd automatically syncs with git:

- Exports to `.beads/issues.jsonl` after changes (5s debounce)
- Imports from JSONL when newer (e.g., after `git pull`)
- No manual export/import needed!

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

<!-- END BEADS INTEGRATION -->

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

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
