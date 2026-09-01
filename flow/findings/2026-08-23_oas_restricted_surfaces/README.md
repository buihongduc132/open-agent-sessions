# OAS restricted surfaces (skill / cmd / shell / mcp)

> Date range: 2026-08-23 → 2026-08-23
> Status: proposal-written
> Ticket: BHD-144 (parent BHD-141)

## Topics

### oas-restricted-surfaces (2026-08-23)

Explore how open-agent-sessions can actually be run when the calling agent is restricted to one (or a combination) of: skill-only, cmd-only, shell-only, mcp-only. Grounded in live OAS repo + live machine. No production code.

**What explored:**
- Live invocation map: CLI (`oas` shebang bun), SDK (`createAdapterRegistry`), heatmap script, cmd (`oas-use`), hermes skill (`axis-oas-work-discovery`), no MCP server, no OAS skill in shared pool.
- Restricted-surface breakage matrix for the four surfaces + combinations.
- BHD-141 parent explore gaps (heatmap pi-only + stale dirs; `toolSearchSessions` SDK-only; live `~/.config/oas/config.yaml` pi+opencode only; bun-on-PATH).
- Barely-fit vs over-engineered (≥5 rejections). Cherry-pick vs avoid.

**What concluded:**
- Shell-only already works (wrapper + bun). Cmd-only already works (`oas-use`) but still shells out. Skill-only exists only as a hermes-profile skill, not shared. MCP-only does not exist.
- `toolSearchSessions` is on adapters but NOT on `AdapterHandle` / CLI / registry fan-out.
- CWD-first config: repo `oas.config.yaml` (9 agents) wins over `~/.config/oas/config.yaml` (pi+opencode). Hermes missing from live home config.
- Barely-fit: thin skill wrapping `oas-use` + CLI `--tool` + enable hermes in live config. No MCP server this slice unless mcp-only is a hard must — then `oas mcp` stdio wrapping existing CLI, not a new product.

**What open:** none blocking. OT3 heatmap + OT7 cmd-text + OT8 JSON hang deferred with reduced coverage.

### gotcha-coverage (2026-08-23)
Two fresh reviewers. Rank 5 = none. Rank 4: CLI search fan-out skips hermes (G4.1); mcp still needs bun in spawn env (G4.2); SKILL.md in OAS invisible until host symlink (G4.3); do not edit cli-agent-cmd oas-use (G4.4); MCP stdout hygiene (G4.5). Threads resolved or parked in `2026-08-23-open-threads.yaml`. LD7 auto: cmd/skill include bash; no-bash = mcp-only.

## Pick up next time

1. `flow/plans/oas-restricted-surfaces.md` — Stage 2 implement (BHD-145).
2. `2026-08-23-turn1a-gotcha-restricted-surfaces.md` — ranked gotchas.
3. `2026-08-23-locked-decisions.yaml` — LD1–LD7.
4. `2026-08-23-open-threads.yaml` — closed; remain deferred OT3/OT7/OT8.
