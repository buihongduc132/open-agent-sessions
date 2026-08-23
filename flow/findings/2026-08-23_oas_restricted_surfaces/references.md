# References

> Sources consulted during this explore session.

## Source files

- `bin/oas` — CLI entry, shebang `#!/usr/bin/env bun`, config search order (cwd `oas.config.yaml` then `~/.config/oas/config.yaml`), session subcommands, no `--tool` / `toolSearchSessions` dispatch.
- `package.json` — `"bin": { "oas": "./bin/oas" }`, `"engines": { "bun": ">=1.0.0" }`, exports map (`.` / `./sdk` / adapters). No MCP package.
- `oas.config.yaml` — repo config: opencode, codex, hermes, zcode, gemini, antigravity, pi×2 (omo+pi), grok. 9 enabled.
- `~/.config/oas/config.yaml` — live home config: pi + opencode only. Hermes missing.
- `~/.local/bin/oas` — symlink → repo `bin/oas` (NOT install.sh bash wrapper).
- `scripts/install.sh` — official install writes bash wrapper `exec bun run "$OAS_BIN"`. Needs bun on PATH.
- `scripts/skill-usage-heatmap.ts` — hardcoded `SESSIONS_DIR=~/.pi/agent/sessions` + stale `INVENTORY_DIRS` (includes `~/.agents/skills` + git-sourced pi skills; no hermes profiles).
- `src/skill-usage/inventory.ts` — `loadSkillInventory`: one level `<dir>/<name>/SKILL.md`, first-dir-wins by name (no `source:` prefix, no hermes category recurse).
- `src/skill-usage/analyzer.ts` / `parser.ts` / `cache.ts` / `fuzzy.ts` — pi JSONL skill-usage analyzer (standalone, not adapter-integrated).
- `src/sdk/index.ts` — SDK barrel: `createAdapterRegistry`, adapters, config, types. No MCP.
- `src/core/types.ts` — `Adapter.toolSearchSessions?(query: ToolSearchQuery)`; `AdapterHandle` does NOT expose `toolSearchSessions`.
- `src/core/registry.ts` — `buildHandle` wraps list/search/detail only. No tool-search fan-out.
- `src/cli/search.ts` — content search (`--text`). Not tool-metadata search.
- `src/cli/read.ts` — `--tools` = include tool messages in ONE session. Not cross-session tool search.
- `src/adapters/hermes.ts` — `toolSearchSessions` via `messages.tool_name LIKE`.
- `src/adapters/{opencode,pi,claude,zcode,antigravity,grok}.ts` — per-adapter `toolSearchSessions`.
- `src/index.ts` — re-exports config/core/adapters. TUI not in SDK.
- `flow/mcp/inventory.yml` — MCP server discovery/config/stats = missing across adapters.
- `flow/skills/inventory.yml` — skill search/stats = missing on adapters; standalone `src/skill-usage/` pi-only.
- `README.md` — feature table: Tool/MCP usage search CLI ❌ SDK ✅.
- `~/.pi/agent/prompts/oas-use.md` (canonical `cli-agent-cmd/cmds/pi/oas-use.md`) — cmd wrapping `oas` CLI. Documents SDK-only tool search + bun + one-bad-adapter (partially stale vs broken-adapter fix).
- `~/.hermes/profiles/user-helper/skills/secretary/axis-oas-work-discovery/SKILL.md` — hermes-profile skill wrapping `oas` CLI. Tells agent to `cd` into OAS repo.
- `flow/findings/2026-08-19-oas_default_conversation_output/` — prior findings pattern (README/turns/locked-decisions/open-threads). OT4 zcode throw = resolved (broken adapter).
- `flow/plans/skill-usage-perf-correctness.md` — heatmap/analyzer perf plan (orthogonal; do not fold).

## Documents

- BHD-144 issue body — Stage 1 explore → gotcha → resolve threads → declarative plan. No production code.
- BHD-141 parent comment `01a02e14-ba8d-76ad-a9c7-653e9521b446` — skill matrix explore: heatmap pi-only, `toolSearchSessions` SDK-only, live config pi+opencode, bun shebang, no fourth dashboard, no third usage DB.
- BHD-141 comment `01a02e23-47bb-7d09-84ce-50e8d5c4f915` — create OAS tickets for skill/cmd/shell/mcp-only; skill-manager research stays on parent.
- `~/.pi/agent/prompts/10-ospx-explore.md` + `_references/{search-strategies,minimal-approach,inherit-established,intention}.md`.
- `~/.pi/agent/prompts/{10-findings-persist,gotcha-coverage,10-plan-declarative}.md`.
- Mario Zechner "MCP vs CLI" (https://mariozechner.at/posts/2025-08-15-mcp-vs-cli/) — coding agents: CLI+skills often cheaper than MCP for token cost.
- OpenClaw MCP docs (https://docs.openclaw.ai/cli/mcp) — `mcp serve` stdio wrapping existing CLI. Pattern to cherry-pick if mcp-only is required.
- FastMCP (PrefectHQ/fastmcp, high stars) — MCP server framework. Over-engineered for wrapping 6 CLI verbs.
- wrapmcp / SubZtep/wrapmcp — generic "CLI → MCP" wrappers. Low stars; idea = wrap existing CLI, don't rewrite.
- Sianmin/ccinv, intelligentrascal/skill-manager — parent BHD-141 inventory cousins. Out of scope here (wrong surface).

## Code patterns

- **CWD-first config** (`bin/oas` `loadConfig`): first existing of `./oas.config.yaml` then `~/.config/oas/config.yaml`. Running from OAS repo enables 9 agents; running from `$HOME` enables 2.
- **`--tools` hide-by-default** (`src/cli/formatters/text.ts`): single-session tool visibility. Precedent for a CLI `--tool NAME` cross-session search, not a new product.
- **broken adapter** (`src/adapters/broken.ts`): factory throw deferred to query time. One missing store no longer kills all cmds (OT4 from 2026-08-19 resolved).
- **Adapter vs AdapterHandle**: adapters implement `toolSearchSessions`; registry handle drops it. SDK callers must hold raw adapters, not the registry, unless they import adapters directly.
- **heatmap hardcoded paths**: not config-driven; pi sessions only; inventory dirs stale vs live skill layout (BHD-141).
