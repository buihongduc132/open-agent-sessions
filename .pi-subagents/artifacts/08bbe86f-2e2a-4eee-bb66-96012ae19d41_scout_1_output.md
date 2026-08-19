# MCP Functionality Survey — open-agent-sessions

Scope: all MCP-related functionality (server discovery, tool listing, usage stats, config parsing) across adapters and core.

## TL;DR

- **No MCP server discovery anywhere.** No adapter enumerates running/configured MCP servers.
- **No MCP config parsing.** `src/config/` parses `oas.config.yaml` (agents list, opencode storage). No `mcpServers` / `mcp.json` field. AgentKind does not include "acpx" or "agy".
- **No MCP-specific usage stats.** Only **generic tool-call** stats exist, via `inferSubAgents()` which *tags* tools with an `isMcp` boolean (prefix `MCP_`/`mcp_` heuristic). No server-name aggregation, no per-MCP-server counts.
- **No "agy" adapter** in the codebase. Adapter set = `opencode, codex, claude, hermes, gemini, antigravity, pi, zcode, acpx`. `acpx` is not in `AgentKind` either (only in adapter index + acpx.ts self-types).
- **Tool/MCP fuzzy search (`toolSearchSessions`, R-41)** is implemented by **opencode, hermes, zcode** only. It searches by tool-name substring — has no MCP awareness, just generic.

## Per-adapter table

Legend: `mcp_discovery` = enumerates configured/running MCP servers; `mcp_extract` = extracts MCP tool calls from sessions (tagged/counted); `mcp_stats` = MCP-specific stats aggregation; `mcp_config` = parses MCP server config.

| adapter     | mcp_discovery | mcp_extract       | mcp_stats         | mcp_config | evidence (file:line) |
|-------------|---------------|-------------------|-------------------|------------|----------------------|
| opencode    | N             | Y (via R-41 search+ isMcp tag in core) | N (tool-level only) | N | `src/adapters/opencode.ts:181-183, 227-229, 935-1005` (toolSearchFromDb/Jsonl); tagging in `src/core/subagents.ts:187-210` |
| zcode       | N             | Y (tool-name LIKE search) | N | N | `src/adapters/zcode.ts:279-285` (toolSearchSessions → `tool_usage.tool_name`); `:18` schema |
| claude      | N             | N (no toolSearch impl) | N | N | `src/adapters/claude.ts` — grep `mcp\|toolSearch\|tool_name` = 0 hits |
| hermes      | N             | Y (tool-name LIKE search) | N | N | `src/adapters/hermes.ts:270-278` (toolSearchSessions → `messages.tool_name`); `:70` col |
| gemini      | N             | N (extracts tool parts but no search impl) | N | N | `src/adapters/gemini.ts:284-289` (tool part mapping only) |
| antigravity | N             | N (extracts tool parts but no search impl) | N | N | `src/adapters/antigravity.ts:244-248` (tool part mapping only) |
| codex       | N             | N (no toolSearch impl) | N | N | `src/adapters/codex.ts` — grep = 0 hits |
| pi          | N             | N (no toolSearch impl) | N | N | `src/adapters/pi.ts` — grep = 0 hits |
| acpx        | N             | N (no toolSearch impl) | N | N | `src/adapters/acpx.ts` — grep = 0 hits; reads only its own JSON prompts |
| agy         | —             | —                 | —                | —          | **No `agy` adapter exists** (no `src/adapters/agy.ts`; not in `AgentKind`, not in `src/adapters/index.ts`) |

Notes:
- "mcp_extract = Y" for opencode/zcode/hermes means tool calls (incl. MCP-named ones) are retrievable; **none isolate MCP-tool identity** beyond the `isMcp` prefix check that happens only in `inferSubAgents` (post-hoc, on `SessionDetail`), not in the search path.
- gemini/antigravity **do** map tool-call parts into `MessagePart { type:"tool", tool, ... }` so a downstream `inferSubAgents` could tag them — but they expose no search interface, so they get N on extract-as-feature.

## Core MCP surfaces (cross-adapter)

### `src/core/subagents.ts` — the ONLY MCP-aware code
- `ToolUsage.isMcp: boolean` (`:25`)
- `SessionSubAgentSummary.mcpPlugins: string[]` (`:36`)
- Detection heuristic — pure prefix match, no server resolution (`:187`):
  ```ts
  const isMcp = name.startsWith("MCP_") || name.startsWith("mcp_");
  ```
- Aggregation: pushes tool names into `mcpPlugins` (`:190-191`), surfaced in `formatSubAgentSummary` (`:267-268`).
- **Limitation**: detection is brittle — only catches OpenCode-style `MCP_*` names. Claude/hermes/zcode tool names won't match this pattern, so `isMcp` is effectively always false for those adapters' tools.

### `src/core/types.ts` — `ToolSearchQuery` (R-41)
- `ToolSearchQuery.tool` (`:62-67`): generic fuzzy tool-name needle.
- `Adapter.toolSearchSessions?(query: ToolSearchQuery)` (`:116`): optional method. Implemented by 3/9 adapters (see table).

### `src/config/` — no MCP config
- `src/config/types.ts:1` — `AgentKind` = `opencode|codex|claude|hermes|gemini|antigravity|pi|zcode`. No `acpx`, no `agy`, no MCP.
- `src/config/types.ts:30` `Config` = `{ agents: AgentEntry[] }` only. No `mcpServers`, no per-agent server config.
- `src/config/load.ts`, `validate.ts` — no MCP parsing.

## Gaps / residual risks

1. **No MCP server inventory** — feature does not exist; would need a new per-adapter `discoverMcpServers()` (read `mcp.json`/settings for each agent's native config). Out of scope of current code.
2. **`isMcp` heuristic is OpenCode-biased** — misses other agents' MCP tools entirely. Any "MCP usage stats" built on `mcpPlugins` today undercounts everything except OpenCode.
3. **`toolSearchSessions` coverage is 3/9** — claude, pi, codex, gemini, antigravity, acpx have no tool search at all.
4. **`agy` requested in task but not present** in repo. `acpx` also absent from `AgentKind` (only registered in adapter index) — separate inconsistency worth flagging.
5. **No MCP config parsing** — the config layer has no schema for it; adding it requires extending `AgentEntry` and `validateConfig`.

## Files retrieved
1. `src/core/subagents.ts:140-249` — MCP tagging + summary aggregation (only MCP-aware code).
2. `src/core/types.ts:55-154` — `ToolSearchQuery`, `Adapter` interface, `toolSearchSessions?`.
3. `src/adapters/opencode.ts:935-1005` — R-41 toolSearchFromDb/Jsonl.
4. `src/adapters/zcode.ts:279-285` — toolSearchSessions SQL.
5. `src/adapters/hermes.ts:270-278` — toolSearchSessions SQL.
6. `src/adapters/gemini.ts:284-289`, `src/adapters/antigravity.ts:244-248` — tool part mapping (no search).
7. `src/config/types.ts` (full) — `AgentKind`, `Config`, no MCP fields.
8. `src/adapters/index.ts` (full) — adapter exports; `agy` absent.
9. `src/adapters/acpx.ts:1-90` — acpx adapter (reads own JSON, no MCP).

## Start here
`src/core/subagents.ts` — the single source of MCP-aware logic; any new MCP feature extends `inferSubAgents` or adds a sibling module. Pair with `src/core/types.ts:62-67,116` for the `toolSearchSessions` contract.