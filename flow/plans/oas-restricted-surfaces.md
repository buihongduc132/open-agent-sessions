# OAS restricted surfaces (skill / cmd / shell / mcp)

> Plan ID: `oas-restricted-surfaces`
> Created: 2026-08-23 · Last reconciled: 2026-08-23
> Status: pending
> Items: 22 total (4 implemented, 18 pending)
> Branch: main
> Location: flow/plans/oas-restricted-surfaces.md
> Ticket: BHD-144 (plan) → BHD-145 (implement)
> Parent: BHD-141 skill inventory / management
> Findings: `flow/findings/2026-08-23_oas_restricted_surfaces/`

## Requirement (verbatim)

Source: BHD-144 issue body + findings dir (resolved threads).

Make a declarative plan so **open-agent-sessions (OAS)** can actually be run when the calling agent is restricted to one (or a combination) of these surfaces:

- **skill only**
- **cmd only**
- **shell only**
- **mcp only**

Combinations are in scope (e.g. skill+shell, cmd+mcp). The point is: OAS must not be stranded behind a single privileged path (today: `bun` CLI + SDK `toolSearchSessions()`, hermes adapter not even in live `~/.config/oas/config.yaml`).

Cite parent BHD-141 explore matrix (usage overlay via OAS) so Stage 2 can implement without re-exploring.

LD7: cmd-only = cmd knowledge + bash allowed; skill-only = skill present + bash allowed; literal no-bash = mcp-only.

## DOD (Definition of Done)

Plan (this file) done when ALL below true — **this ticket writes the plan, does not implement**:

- [x] Findings dir exists with README, locked-decisions, open-threads (resolved or parked).
- [x] Gotcha appendix written against those findings.
- [x] This plan file has probe-verifiable items covering skill-only / cmd-only / shell-only / mcp-only and named combinations.
- [x] Plan cites BHD-141 explore matrix (usage overlay via OAS).
- [x] No production code in BHD-144.

**Stage 2 (BHD-145) done when ALL below true:**

- [ ] Shell-only agent runs `oas session list --limit 1 --last 4h` (exit 0, ≥1 row or explicit empty).
- [ ] Cmd-only (pi + bash): `/oas-use` recipes still work against the same CLI (including `--tool` once shipped).
- [ ] Skill-only: host with OAS SKILL.md symlink can run the recipes without cmd-palette.
- [ ] Mcp-only: `oas mcp` stdio initialize + list-tools + one list call succeeds with JSON-RPC-only stdout.
- [ ] Named combo cmd+mcp documented (cmd points at MCP tool names OR still shells CLI).
- [ ] `oas session search --tool skill_view` (or equivalent) returns via registry fan-out, not SDK-only.
- [ ] Live `~/.config/oas/config.yaml` includes hermes; `pi:omo` disabled or path fixed.
- [ ] No fourth dashboard. No third usage DB. No skill-manager fork.

## Tasks

### Shell-only

- [x] shell-oas-bin: `oas` is on PATH and runs via bun (`~/.local/bin/oas` → repo `bin/oas`, shebang `#!/usr/bin/env bun`).
  - **Probe:** `command -v oas && head -1 "$(command -v oas | xargs readlink -f)"` contains `bun`.
  - **Why already true:** live 2026-08-23.

- [ ] shell-tool-search: `oas session search --tool <name>` (flag name stable: `--tool`) lists sessions whose adapters report that tool via `toolSearchSessions`. `--text` unchanged.
  - **Probe:** `oas session search --help` mentions `--tool`. `oas session search --tool skill_view --format json` exits 0 (empty array OK).
  - **Gotcha:** G4.1 — must NOT copy `createSearchService` if/else (drops hermes/gemini/antigravity/zcode).

- [ ] shell-bun-doc: README/`USAGE` states bun-on-PATH is required for CLI; `env -i PATH=/usr/bin:/bin oas --help` is expected to fail unless bun is in that PATH.
  - **Probe:** sentence exists in OAS README or USAGE.md.

### Registry / tool search (BHD-141 gap)

- [ ] handle-tool-search: `AdapterHandle` and `buildHandle` expose `toolSearchSessions` when the adapter implements it. Registry fan-out visits every enabled agent.
  - **Probe:** `rg toolSearchSessions src/core/registry.ts` matches. Test asserts each enabled `AgentKind` in a fixture config is queried (hermes included).
  - **Cite:** BHD-141 `toolSearchSessions` SDK-only; G4.1.

- [ ] text-search-followup: Existing `oas session search --text` hermes-drop is listed as follow-up, not implemented here (LD5 — not a new inventory product).
  - **Probe:** this plan's Open Threads names it; no new search engine.

### Cmd-only (cmd+shell)

- [x] cmd-oas-use: pi cmd `oas-use` exists (`cli-agent-cmd/cmds/pi/oas-use.md` → `~/.pi/agent/prompts/oas-use.md`) and tells the model to shell `oas`.
  - **Probe:** file exists; contains `oas session list`.

- [ ] cmd-no-edit: BHD-145 does **not** modify `cli-agent-cmd` `oas-use.md` (LD2 / G4.4 / OT7 deferred). Stale "one bad adapter kills all" text remains until a separate cmd ticket.
  - **Probe:** `git -C ../cli-agent-cmd diff` has no `oas-use.md` in the Stage 2 PR. OAS `--tool` still works because the cmd shells whatever CLI exists.

### Skill-only (skill+shell)

- [ ] skill-sot: OAS repo contains `skills/oas-use/SKILL.md` with the same decision tree as the cmd (list/read/search/--tool/config cwd-vs-home). Source of truth lives here.
  - **Probe:** file exists; mentions `oas session list` and `--tool`.

- [ ] skill-host-symlink: Stage 2 probe creates a symlink from at least one host pool to that SKILL.md (`~/.pi/agent/skills/oas-use` OR a hermes profile skills dir). NOT `~/.agents/skills` (5 leftovers). NOT a commit into `cli-agent-skills`.
  - **Probe:** `readlink` of the host path points at OAS `skills/oas-use`. `test -f …/SKILL.md`.
  - **Gotcha:** G4.3 — file in OAS repo alone is invisible.

- [ ] skill-no-rewrite-axis: `axis-oas-work-discovery` (hermes user-helper) is not rewritten (OT2). `cd` side-effect documented as G2.1, not fixed here.
  - **Probe:** no diff under `~/.hermes/profiles/user-helper/skills/secretary/axis-oas-work-discovery/` in the OAS PR (file is outside repo).

### Mcp-only

- [ ] mcp-stdio: `oas mcp` starts a stdio JSON-RPC server. Tools wrap in-process SDK (list, read, search, detail, tool-search). No `spawn oas` per call (G3.5).
  - **Probe:** `oas mcp --help` or `oas --help` lists `mcp`. Process reads stdin JSON-RPC.

- [ ] mcp-stdout-clean: stdout is JSON-RPC only. Logs / adapter warnings go to stderr (G4.5).
  - **Probe:** `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' | oas mcp` → first stdout line is JSON starting `{` ; no bun banner on stdout.

- [ ] mcp-abs-bun: Host registration snippet (in OAS docs) uses an absolute bun **shim** (`~/.local/share/mise/shims/bun` or `$(command -v bun)` resolved) + absolute `bin/oas mcp`, plus `OAS_CONFIG` (G4.2, G3.2, G2.3).
  - **Probe:** docs contain an `mcp.json` (or equivalent) example with absolute paths. `env -i HOME="$HOME" <abs-bun> <abs-bin/oas> mcp` still speaks JSON-RPC (PATH empty except what the abs bun needs).

- [ ] mcp-register-doc: OAS repo documents how pi/claude/hermes register the server. Applying the snippet on this machine is the Stage 2 mcp-only probe, not a second product (G3.3).
  - **Probe:** USAGE or README section "MCP" with copy-paste config.

- [ ] mcp-cache: long-lived server does not serve stale detail forever (G2.2) — `clearDetailCache` per tool or TTL ≤60s.
  - **Probe:** test or comment at MCP handler.

### Live config (BHD-141 gap)

- [ ] live-hermes: `~/.config/oas/config.yaml` includes an enabled `hermes` entry (default storage). Repo `oas.config.yaml` already has hermes — cwd-first means home file only wins outside the OAS repo.
  - **Probe:** `cd /tmp && oas config --show` lists hermes. Cite BHD-141 "live OAS config enables pi+opencode only".

- [ ] live-pi-omo: repo and/or live config: `pi:omo` disabled or path exists (G3.6).
  - **Probe:** `oas session list --limit 1 --last 4h` stderr has no `Pi sessions path not found: …/vendor-omo/…`.

- [ ] live-config-note: docs state cwd `oas.config.yaml` wins over `~/.config/oas/config.yaml`; MCP should set `OAS_CONFIG` to the intended file (G3.2).
  - **Probe:** sentence in README or USAGE.

### Combinations + parent cite

- [ ] combo-probes: Stage 2 comment includes evidence for: (1) shell-only (2) cmd+shell (3) skill+shell (4) mcp-only (5) cmd+mcp (cmd text still valid while MCP tools exist). Not 2^4 matrix (G2.4).
  - **Probe:** BHD-145 comment has five labeled transcripts/outputs.

- [ ] cite-bhd-141: this plan and Stage 2 PR/issue comment cite parent explore comment `01a02e14-ba8d-76ad-a9c7-653e9521b446` (matrix rows `source:skill`, OAS usage overlay, heatmap pi-only, toolSearchSessions SDK-only, live hermes missing, bun shebang). Heatmap rewrite is **out of scope** (OT3).
  - **Probe:** this section exists; heatmap item below is docs-only.

- [x] heatmap-gap-doc: heatmap hardcoded to pi + stale inventory dirs is documented in findings; not implemented here.
  - **Probe:** findings turn1 table + OT3 deferred.

- [x] no-parallel-product: no new dashboard, no third usage DB, no skill-manager fork in this plan's ship list (LD4/LD5).
  - **Probe:** Tasks above contain none of those nouns as deliverables.

## Idempotency

Re-running `/10-plan-declarative` on the same requirement reconciles to THIS plan.
Implemented items auto-marked `- [x]`. Pending items surface as work-remaining.
DO NOT rewrite item prose on re-run (status flips only).

## Open Threads

From findings `2026-08-23-open-threads.yaml` (status: closed; remain deferred):

- OT3 heatmap multi-agent — deferred to BHD-141 overlay (`heatmap-gap-doc`).
- OT7 oas-use cmd text vs LD2 — deferred (`cmd-no-edit`).
- OT8 JSON list hang — deferred; MCP in-process; 60s probe budget (`mcp-stdio`).

Gotcha G4.1–G4.5 mapped to: `handle-tool-search`, `mcp-abs-bun`, `skill-host-symlink`, `cmd-no-edit`, `mcp-stdout-clean`.

## Stage 2 pointer

BHD-145 implements this plan then verifier-loop. Do not start until BHD-144 is `done`.
Wrong surface: open-agent-sessions only.

## ospx conversion

Not requested this ticket. Next if wanted: `/20-plan-verify-gotcha oas-restricted-surfaces` then optional ospx split.
