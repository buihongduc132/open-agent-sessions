# Explore Turn 1 — restricted-surfaces

> Date: 2026-08-23
> Phase: 10-ospx-explore
> Status: captured
> Ticket: BHD-144 / parent BHD-141

## [user] (verbatim — trust chain L1)

> Make a declarative plan so **open-agent-sessions (OAS)** can actually be run when the calling agent is restricted to one (or a combination) of these surfaces:
>
> - **skill only**
> - **cmd only**
> - **shell only**
> - **mcp only**
>
> Combinations are in scope (e.g. skill+shell, cmd+mcp). The point is: OAS must not be stranded behind a single privileged path (today: `bun` CLI + SDK `toolSearchSessions()`, hermes adapter not even in live `~/.config/oas/config.yaml`).
>
> Ground in the live OAS repo + live machine. Cover at least:
>
> - How OAS is invoked today: CLI (`oas`), SDK, scripts (`scripts/skill-usage-heatmap.ts`), MCP (if any), skill wrapper (if any), pi/hermes cmd (if any).
> - What breaks under each restricted surface (skill / cmd / shell / mcp) and under combinations.
> - Known gaps from BHD-141 explore (parent comment 01a02e14-ba8d-76ad-a9c7-653e9521b446): heatmap hardcoded to pi + stale inventory dirs; `toolSearchSessions` SDK-only; live OAS config enables pi+opencode only (hermes missing); `oas` shebang needs `bun` on PATH.
> - Barely-fit vs over-engineered (≥3 rejections). No fourth dashboard. No third usage DB.
> - Cherry-pick vs avoid: reuse existing OAS analyzer / heatmap / adapters; do not invent a parallel inventory product.
>
> Persist findings under `open-agent-sessions/flow/findings/` (not disposable chat). Then gotcha-coverage + resolve open threads on that findings dir. Then write the plan at `open-agent-sessions/flow/plans/<slug>.md`.
>
> Do **not** implement code in this ticket.

## [assistant]

Quote (verbatim): OAS must actually be run when the calling agent is restricted to skill-only / cmd-only / shell-only / mcp-only (and combinations).

This turn is explore only (no production code). Grounded in live OAS repo + live machine 2026-08-23, plus BHD-141 parent explore, plus remote search.

---

## How OAS is invoked today (live)

```
Caller
  │
  ├─ shell ──► ~/.local/bin/oas ──symlink──► repo/bin/oas
  │                 shebang: #!/usr/bin/env bun
  │                 loadConfig: cwd oas.config.yaml FIRST, then ~/.config/oas/config.yaml
  │
  ├─ cmd ──► ~/.pi/agent/prompts/oas-use.md  (canonical: cli-agent-cmd/cmds/pi/oas-use.md)
  │                 tells agent to shell `oas …`
  │
  ├─ skill ──► ~/.hermes/profiles/user-helper/skills/secretary/axis-oas-work-discovery/SKILL.md
  │                 hermes-profile only; tells agent to `cd` OAS repo then `oas …`
  │                 NO SKILL.md in cli-agent-skills / OAS repo skills/
  │
  ├─ SDK ──► import { createAdapterRegistry } from "open-agent-sessions/sdk"
  │                 TypeScript/bun. toolSearchSessions lives on Adapter, NOT AdapterHandle
  │
  ├─ script ──► bun run scripts/skill-usage-heatmap.ts
  │                 hardcoded ~/.pi/agent/sessions + stale inventory dirs
  │
  └─ MCP ──► DOES NOT EXIST
                  not in package.json, mcp.json, settings.json, or src/
```

### Live probes

| Probe | Result |
|---|---|
| `which oas` | `/home/bhd/.local/bin/oas` |
| file type | symlink → `/home/bhd/Documents/Projects/bhd/open-agent-sessions/bin/oas` |
| shebang | `#!/usr/bin/env bun` |
| `which bun` | `/home/bhd/.local/share/mise/installs/node/22.22.2/bin/bun` |
| `env -i PATH=/usr/bin:/bin which bun` | **no bun** (clean PATH fails) |
| `oas --help` | works (session list/read/detail/export/clone/search/similar, config, tui) |
| `oas config --show` from OAS repo cwd | loaded **repo** `oas.config.yaml`: 9 agents (opencode, codex, hermes, gemini, antigravity, pi omo, pi pi, zcode, grok) |
| `oas config --show` from `/tmp` | loaded **home** `~/.config/oas/config.yaml`: **pi + opencode only** |
| `oas config --paths` | `[found] ./oas.config.yaml` then `[found] ~/.config/oas/config.yaml` (first match wins) |
| `timeout 20 oas session list --limit 1 --format json --last 4h` | **exit 124** (timeout) |
| `timeout 15 oas session list --limit 1 --last 4h --format text` | exit 0; printed hermes session + `[pi:omo] Pi sessions path not found: …/vendor-omo/…/sessions` |
| `rg oas\|open-agent-sessions` in `~/.pi/agent/{mcp,settings}.json` + pi-plugins profile | **empty** — no MCP entry, no package |
| OAS skill in `cli-agent-skills/skills` | **none** |
| pi cmd `oas-use` | exists |
| hermes skill `axis-oas-work-discovery` | exists, user-helper profile only |

Repo `oas.config.yaml` (9 agents) ≠ live `~/.config/oas/config.yaml` (2 agents). Hermes **is** in repo config; **missing** from live home config. Any agent that does **not** `cd` into the OAS repo inherits the thin home config.

`install.sh` writes a bash wrapper `exec bun run "$OAS_BIN"`. Live machine skipped that: symlink straight at `bin/oas`. Both still need `bun` on PATH.

---

## Surfaces — what exists vs what breaks

| Surface | Exists today? | How | Breaks when |
|---|---|---|---|
| **shell-only** | YES | `oas` on PATH | bun missing; cwd picks wrong config; one-session `--tools` only (no `--tool NAME` cross-session); `session list --format json` can hang >20s |
| **cmd-only** | YES (pi) | `/oas-use` | agent has no cmd-palette (hermes/claude/codex); cmd still shells `oas` so bun+PATH still required; cmd docs say SDK for tool search |
| **skill-only** | PARTIAL | hermes `axis-oas-work-discovery` only | pi/opencode/claude skill-only agents see **nothing**; skill `cd`s into OAS repo (side-effect); not in shared pool |
| **mcp-only** | NO | — | agent with MCP tools only cannot call OAS at all |
| **SDK** | YES | `open-agent-sessions/sdk` | needs bun/node + import path; `toolSearchSessions` on Adapter not registry handle; not a "surface" in the ticket's four |
| **heatmap script** | YES | `bun run scripts/skill-usage-heatmap.ts` | pi sessions only; stale inventory dirs; not a general OAS run path |

### Combinations

| Combo | Today | Gap |
|---|---|---|
| skill+shell | hermes user-helper only | other agents: skill missing; shell still needs bun |
| cmd+shell | pi: `/oas-use` → `oas` | works if bun+PATH; tool-search still SDK |
| cmd+mcp | impossible | no MCP |
| skill+mcp | impossible | no MCP, skill not shared |
| shell+mcp | impossible | no MCP |
| all four | stranded on shell+bun | mcp missing; skill not shared; tool search SDK-only |

---

## BHD-141 gaps — re-verified live (do not re-explore the matrix)

Parent comment `01a02e14-ba8d-76ad-a9c7-653e9521b446` (hp-skill-manager explore). This ticket cites it; does not rebuild the skill×agent matrix.

| Gap (parent) | Live 2026-08-23 | Blocks restricted run? |
|---|---|---|
| heatmap hardcoded to pi + stale inventory dirs | `scripts/skill-usage-heatmap.ts`: `SESSIONS_DIR=~/.pi/agent/sessions`; inventory includes `~/.agents/skills` (5 leftovers) + git-sourced pi skills; **no hermes profiles**; `loadSkillInventory` one-level, name-dedup (drops `source:`) | Usage overlay for BHD-141 matrix. Not required to *invoke* OAS. PARK as OT3. |
| `toolSearchSessions` SDK-only | TRUE. Adapters implement it (opencode, pi, hermes, claude, zcode, antigravity, grok). `AdapterHandle` in `src/core/registry.ts` **drops** it. CLI search = `--text` content only. README: CLI ❌ SDK ✅. `oas-use` documents SDK snippet + slow xargs workaround. | YES. Skill/cmd/shell cannot do cross-session tool/MCP/skill_view search without SDK. |
| live config pi+opencode only (hermes missing) | TRUE for `~/.config/oas/config.yaml`. FALSE for repo `oas.config.yaml` (hermes enabled). First-match = cwd file. | YES for callers not in OAS cwd. Hermes overlay for BHD-141 needs home config OR always run from repo. |
| `oas` shebang needs bun on PATH | TRUE. Clean PATH has no bun. Symlink shebang + install.sh wrapper both exec bun. | YES for any surface that shells `oas`. |

Additional live gaps not in parent (callouts):

[CA1] `Adapter.toolSearchSessions` exists; `AdapterHandle` / `AdapterRegistry` do not expose it. Even SDK users of `createAdapterRegistry()` cannot fan-out tool search without reaching into raw adapters.

[CA2] `oas session list --format json --last 4h --limit 1` timed out 20s; text format returned in 15s. JSON list is not a reliable probe for restricted agents.

[CA3] `pi:omo` path in repo config points at missing vendor-omo sessions dir. Broken-adapter fix (2026-08-19 OT4) now prints per-agent error instead of killing CLI. Still noise on every list.

[CA4] `oas-use` gotcha "ONE bad adapter kills ALL cmds" is **stale** — fixed via `createBrokenAdapter`. Cmd text not updated.

[CA5] axis-oas-work-discovery instructs `cd /home/bhd/Documents/Projects/bhd/open-agent-sessions` before `oas`. That is how hermes accidentally gets the 9-agent repo config. Home-config hermes gap is hidden for that one skill, not for others.

---

## Search results

### What exists (open source / patterns found)

- **OpenClaw `mcp serve`** (docs.openclaw.ai/cli/mcp): existing CLI grows a stdio MCP server. Client owns the process. Same verbs, extra transport. High relevance.
- **Mario Zechner "MCP vs CLI"** (mariozechner.at/posts/2025-08-15-mcp-vs-cli): coding agents often cheaper with CLI+skills than MCP (token cost of tool schemas). Relevance: do not lead with MCP if shell/cmd/skill already cover; still need mcp-only because the ticket lists it.
- **FastMCP** (PrefectHQ/fastmcp, high stars): MCP framework. Overkill to wrap 6 existing CLI verbs.
- **modelcontextprotocol/servers**: reference stdio servers. Pattern = JSON-RPC stdio, tools map 1:1 to operations.
- **wrapmcp / SubZtep/wrapmcp / ralphkrauss/mcp-wrapper**: generic CLI→MCP. Low stars; idea only (wrap, don't rewrite). Below 100★ = noise as a dependency.
- **Sianmin/ccinv**, **intelligentrascal/skill-manager**: parent BHD-141 inventory cousins. Wrong surface for this ticket (LD2).
- **Our stack**: `oas` CLI + `oas-use` cmd + heatmap + adapters + hermes profile skill. Reuse these.

### What to cherry-pick

- OpenClaw: `oas mcp` = stdio server that calls existing CLI/SDK functions. No new query engine.
- `--tools` hide-by-default precedent → add `oas session search --tool NAME` (or `oas session tools --name`) wrapping adapter `toolSearchSessions`.
- `oas-use` decision tree → copy into a SKILL.md so skill-only agents get the same recipes.
- Enable hermes (and other repo agents the user actually runs) in `~/.config/oas/config.yaml` so cwd-independent callers see them.
- Document bun-on-PATH as a hard runtime dep (install.sh already installs bun). Do not rewrite shebang to node this slice (engines.bun).

### What to avoid

- Fourth Next.js dashboard (LD4 / parent reject #1).
- Third usage DB (LD4 / parent reject #2).
- Skill-manager genome/drift workspace inside OAS (LD2, LD5).
- Per-session `oas session read --tools` loop as the official cross-session tool search (parent reject #4).
- FastMCP / wrapmcp product as a new repo.
- Shipping heatmap multi-agent rewrite in this ticket (OT3 / BHD-141 overlay).
- Treating `~/.agents/skills` as the shared skill pool (parent CA; live = 5 leftovers).

### Recommendation

Minimal: make **one CLI** the privileged implementation, then **thin adapters** for the four surfaces.

```
                    ┌─────────────────────────┐
                    │  oas CLI + SDK adapters │
                    │  (+ --tool on CLI)      │
                    └────────────┬────────────┘
           ┌─────────────┬───────┴────────┬─────────────┐
           ▼             ▼                ▼             ▼
      shell-only     cmd-only        skill-only     mcp-only
      `oas` PATH     oas-use.md      SKILL.md       `oas mcp`
                     (exists)        (new, same     stdio wrap
                                     recipes)       same verbs
```

Enable hermes in live home config so overlay queries work without `cd` to repo.

---

## Minimal approach (barely-fit)

**User intention (verbatim):** OAS runnable under skill-only / cmd-only / shell-only / mcp-only (and combinations). Not stranded on bun CLI + SDK `toolSearchSessions`.

**Must-haves (traceable):**

1. Skill-only agent can invoke OAS (no cmd-palette, no MCP).
2. Cmd-only agent can invoke OAS (pi cmd-palette).
3. Shell-only agent can invoke OAS (`oas` on PATH).
4. Mcp-only agent can invoke OAS (MCP tools only).
5. Combinations work because they share one implementation.
6. Cite BHD-141 gaps: tool search not SDK-only; live hermes; bun PATH; heatmap noted.
7. No fourth dashboard, no third usage DB, no parallel inventory product.

**Smallest thing that satisfies all:**

| Must | Barely-fit ship |
|---|---|
| shell-only | Keep `oas`. Add `oas session search --tool <name>` (fan-out `toolSearchSessions` via registry). Document bun. |
| cmd-only | Keep `oas-use`. Update it: `--tool` exists, broken-adapter gotcha stale, config cwd vs home. |
| skill-only | Add `skills/oas-use/SKILL.md` in OAS repo (same decision tree as cmd). Install/copy into shared skill pool is a one-line in the plan; do not rebuild inventory. |
| mcp-only | `oas mcp` stdio: tools `session_list`, `session_read`, `session_search`, `session_detail`, `session_tool_search` = CLI verbs. |
| hermes live | Add hermes (path default) to `~/.config/oas/config.yaml`. |
| combinations | All four call the same CLI/SDK; no second engine. |

### Over-engineer ↔ minimal (≥5)

| # | REJECT (over-engineered) | SHIP (barely-fit) |
|---|---|---|
| 1 | New Next.js skill-dashboard | CLI table + existing cmd/skill. Parent already rejected dashboard. |
| 2 | Own skill-usage DB / third store | Files + OAS sessions + hermes `.usage.json` (parent). This ticket does not add a store. |
| 3 | FastMCP rewrite / wrapmcp product | `oas mcp` stdio wrapping existing functions (OpenClaw pattern). |
| 4 | Per-session xargs `oas read --tools` as official tool search | CLI `--tool` → adapter `toolSearchSessions`. |
| 5 | 40 hermes-profile columns / heatmap rewrite here | Enable hermes adapter in live config; heatmap multi-agent stays BHD-141 (OT3). |
| 6 | Node rewrite of shebang to drop bun | Keep bun; document PATH; install.sh already installs bun. |

---

## Restricted-surface breakage (detail)

### Shell-only

Works if: `oas` on PATH, `bun` on PATH, config finds at least one healthy adapter.

Fails if: bun missing (clean PATH); JSON list hangs; caller cwd has no `oas.config.yaml` → home config (no hermes); wants tool-metadata search (`oas session search --text` ≠ tool name).

### Cmd-only

Works on pi (cmd-palette loads `oas-use`). Cmd body is a prompt that tells the model to run shell commands — so cmd-only **still needs shell** unless the host injects the cmd as the only knowledge and the model is allowed bash.

Fails on hermes/claude/codex (no this cmd). Fails if bash tool disabled (true cmd-only with no shell = cmd is documentation, cannot execute). True cmd-only without shell is **unexecutable** unless MCP or a host-native cmd runner exists. Decision: cmd-only = "agent may only load cmds, bash still allowed" (pi reality). If bash also denied → that agent is mcp-only or stuck. Named combination cmd+shell is the real pi path.

### Skill-only

Works on hermes user-helper via `axis-oas-work-discovery` (and it `cd`s to repo).

Fails everywhere else. Shared pool has no OAS skill. Skill-only + no bash = same trap as cmd-only. Decision: skill-only = skill present + bash allowed to run `oas`. Skill-only + no bash → mcp-only.

### Mcp-only

Total miss. No server. Agent with only MCP tools cannot list/read/search sessions.

### Combinations that matter (named for Stage 2)

1. **shell-only** — `oas` PATH + bun + `--tool`.
2. **cmd+shell** — `oas-use` + `oas` (pi).
3. **skill+shell** — shared SKILL.md + `oas`.
4. **mcp-only** — `oas mcp` stdio, no bash.
5. **cmd+mcp** — cmd documents MCP tool names if host has OAS MCP; optional, follows from 2+4.

---

## Decisions (not questions)

- Possible: yes. Four surfaces share one CLI; missing pieces are skill file, CLI `--tool`, live hermes, thin MCP.
- Cmd-only and skill-only imply bash unless mcp-only. Document that. Do not invent an in-process cmd interpreter.
- Heatmap multi-agent = BHD-141, not this DoD (OT3 park).
- No dashboard. No third DB. No skill-manager fork.
- Stage 2 implements; this ticket writes findings + gotcha + plan.

## Status at end of turn 1

Locked: LD1–LD6. Open: OT1 (mcp in this plan — lean YES thin), OT2 (new SKILL.md — lean YES in OAS repo), OT3 (heatmap park). Next: persist (this dir) → gotcha-coverage → resolve threads → `10-plan-declarative`.
