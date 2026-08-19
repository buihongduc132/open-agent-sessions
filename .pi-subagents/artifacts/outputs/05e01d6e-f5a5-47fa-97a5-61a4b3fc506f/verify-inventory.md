# Inventory Verification — Pass/Fail Gate

Method: `rg`/`sed` against cited source files. Every adapter field value cross-checked.

Legend: V=VERIFIED, I=INCORRECT, U=UNVERIFIABLE.

---

## skills/inventory.yml (7 items)

| id | field claim | verdict | evidence |
|----|-------------|---------|----------|
| skills-query | all=missing | V | No `searchSessions(skill)` / skill search in any adapter; standalone module `src/skill-usage/` scans pi JSONL only |
| skills-stats | only pi=standalone, rest missing | V | `src/skill-usage/analyzer.ts` (SkillUsageReport); pi-format only; no adapter integration |
| skills-extract | only pi=standalone, rest missing | V | `src/skill-usage/parser.ts:73 extractSkillReads`, `:129 extractSkillMentions` |
| skills-inventory-load | only pi=standalone, rest na | V | `src/skill-usage/inventory.ts:19 loadSkillInventory` |
| skills-fuzzy-match | only pi=standalone, rest na | V | `src/skill-usage/fuzzy.ts:35 canonicalize`, `:60 damerauLevenshtein`, `:145 matchTier` |
| skills-cache | only pi=standalone, rest na | V | `src/skill-usage/cache.ts:169 computeFingerprint` |
| skills-heatmap-script | only pi=standalone, rest na | V | `scripts/skill-usage-heatmap.ts` exists; pi-format only |

Key claim 1 (only pi=standalone; all adapters missing skill search): **VERIFIED**.

---

## tools/inventory.yml (5 items)

### tools-extract-parts
| adapter | claim | verdict | evidence |
|---------|-------|---------|----------|
| opencode | implemented | V | `src/adapters/opencode.ts:908 type: "tool"` |
| codex | missing | V | only `type: "text"` at codex.ts:565; no tool part |
| claude | missing | V | only `type: "text"` at claude.ts:282 |
| acpx | missing | V | only `type: "text"` at acpx.ts:332 |
| hermes | implemented | V | `src/adapters/hermes.ts:410 type: "tool"` |
| gemini | implemented | V | `src/adapters/gemini.ts:288 type: "tool"` |
| antigravity | implemented | V | `src/adapters/antigravity.ts:247 type: "tool"` |
| pi | missing | V | pi.ts:319,323 only `type: "text"` |
| zcode | implemented | V | `src/adapters/zcode.ts:438 type: "tool"` |

Key claim 2: **VERIFIED**.

### tools-search-sessions
| adapter | claim | verdict | evidence |
|---------|-------|---------|----------|
| opencode | implemented | V | `src/adapters/opencode.ts:182,228 toolSearchSessions`; `toolSearchFromDb`/`toolSearchFromJsonl` at :943,:1007 |
| codex | missing | V | no `toolSearchSessions` in codex.ts |
| claude | missing | V | no `toolSearchSessions` in claude.ts |
| acpx | missing | V | no `toolSearchSessions` in acpx.ts |
| hermes | implemented | V | `src/adapters/hermes.ts:270 toolSearchSessions` (SQL LIKE) |
| gemini | missing | V | no `toolSearchSessions` in gemini.ts |
| antigravity | missing | V | no `toolSearchSessions` in antigravity.ts |
| pi | missing | V | no `toolSearchSessions` in pi.ts |
| zcode | implemented | V | `src/adapters/zcode.ts:279 toolSearchSessions` (SQL LIKE) |

Key claim 3 (only opencode/hermes/zcode): **VERIFIED**.

### tools-stats-callcount | tools-categorize | tools-mcp-tag
All adapters=core | core | core: **VERIFIED**.
- `src/core/subagents.ts:144 inferSubAgents` (call count)
- `src/core/subagents.ts:58 TOOL_CATEGORY_MAP` + `:225 categorise`
- `src/core/subagents.ts:187 isMcp = name.startsWith("MCP_")||startsWith("mcp_")`

Key claim 4: **VERIFIED**. (MCP heuristic is OpenCode-biased per notes — accurate.)

---

## mcp/inventory.yml (7 items)

| id | claim | verdict | evidence |
|----|-------|---------|----------|
| mcp-server-discovery | all=missing | V | no `mcpServers`/`discoverMcp`/`McpServer` in src/ |
| mcp-config-parse | all=missing | V | no MCP schema in src/config/; AgentKind has no mcpServers field |
| mcp-extract-toolcalls | opencode/hermes/gemini/antigravity/zcode=partial; rest=missing | V | inherits from tools-extract-parts evidence (generic tool parts, no MCP identity) |
| mcp-usage-stats | all=missing | V | no server-name aggregation; only generic tool stats |
| mcp-isMcp-heuristic | all=core | V | `src/core/subagents.ts:187` |
| mcp-agy-adapter | all=na | V | `rg "agy" src/` = 0 matches; not in AgentKind (`src/config/types.ts:1`); not in `src/adapters/index.ts` |
| mcp-acpx-agentkind | acpx=gap, rest=na | V | `src/adapters/acpx.ts:78 createAcpxAdapter` + `src/adapters/index.ts:7 export`; but `rg "acpx" src/config/types.ts src/core/types.ts` = 0 matches (NOT in AgentKind) |

Key claims 5-9: **VERIFIED**.

- Claim 5 (mcp-server-discovery all missing): **VERIFIED**.
- Claim 6 (mcp-config-parse all missing): **VERIFIED**.
- Claim 7 (mcp-isMcp-heuristic all=core @ subagents.ts:187): **VERIFIED**.
- Claim 8 (agy absent): **VERIFIED**.
- Claim 9 (acpx in adapters/index.ts:7 but NOT in AgentKind): **VERIFIED**.

---

## Final Verdict: **PASS**

All 19 items across 3 inventory files. Every adapter field value matches source. Zero INCORRECT. Zero UNVERIFIABLE.

Notes:
- Inventory citations are accurate, including line numbers (opencode.ts:908/943/1007, hermes.ts:270/410, gemini.ts:288, antigravity.ts:247, zcode.ts:279/438, subagents.ts:187).
- The "OpenCode-biased / misses other adapters' MCP tools" caveat in notes is substantiated: isMcp only matches `MCP_`/`mcp_` prefix, which is opencode's convention.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "All 19 inventory items verified against cited source with file:line evidence. Verdict PASS, zero INCORRECT."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "rg -n \"agy\" src/",
      "result": "passed",
      "summary": "0 matches — confirms agy adapter absent"
    },
    {
      "command": "rg -n \"toolSearchSessions\" src/adapters/",
      "result": "passed",
      "summary": "only opencode/hermes/zcode implement"
    },
    {
      "command": "rg -n \"type:.*tool|isMcp|categorise|TOOL_CATEGORY_MAP\" src/adapters/ src/core/subagents.ts",
      "result": "passed",
      "summary": "tool part extraction present in opencode:908/hermes:410/gemini:288/antigravity:247/zcode:438; isMcp heuristic @ subagents.ts:187"
    },
    {
      "command": "rg -n \"acpx\" src/config/types.ts src/core/types.ts; head src/adapters/acpx.ts",
      "result": "passed",
      "summary": "acpx exported in index.ts:7 + adapters/acpx.ts:78 but absent from AgentKind enum"
    },
    {
      "command": "rg -n \"mcpServers|discoverMcp|McpServer\" src/",
      "result": "passed",
      "summary": "0 matches — confirms MCP discovery/config-parse absent"
    },
    {
      "command": "rg skill-usage exports + heatmap script",
      "result": "passed",
      "summary": "all claimed skill-usage functions exist at cited locations"
    }
  ],
  "validationOutput": [
    "skills/inventory.yml: 7/7 items VERIFIED",
    "tools/inventory.yml: 5/5 items VERIFIED (45 adapter fields)",
    "mcp/inventory.yml: 7/7 items VERIFIED",
    "Final: PASS — all claims match source"
  ],
  "residualRisks": [
    "none — verification static; no code changed"
  ],
  "noStagedFiles": true,
  "diffSummary": "no changes — read-only verification pass",
  "reviewFindings": [
    "no blockers — all 19 inventory items match source code; verdict PASS"
  ],
  "manualNotes": "Inventory files are accurate. Aggregator notes correctly flag isMcp OpenCode-prefix bias as a real limitation."
}
```
