# Progress — mcp-survey subagent

- [x] Repo recon: grepped `mcp\|MCP\|Mcp` across src/ → only 3 source files reference MCP.
- [x] Per-adapter scan of all 9 adapters (opencode, codex, claude, hermes, gemini, antigravity, pi, zcode, acpx) for mcp/tool/server/config keywords.
- [x] Confirmed `agy` adapter does NOT exist.
- [x] Confirmed config layer has zero MCP schema.
- [x] Confirmed only `src/core/subagents.ts` carries MCP-aware logic (isMcp prefix heuristic).
- [x] Confirmed `toolSearchSessions` (R-41) implemented by opencode, zcode, hermes only.
- [x] Wrote findings to `.pi-subagents/artifacts/outputs/08bbe86f-2e2a-4eee-bb66-96012ae19d41/mcp-survey.md`.
