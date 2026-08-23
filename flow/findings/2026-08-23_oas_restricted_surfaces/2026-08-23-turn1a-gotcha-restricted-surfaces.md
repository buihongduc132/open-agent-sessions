# Gotcha Coverage — 2026-08-23_oas_restricted_surfaces

> Source: `flow/findings/2026-08-23_oas_restricted_surfaces/`
> Mode: findings
> Sub-agents: reviewer ×2 (fresh, parallel)
> Units reviewed: OT1, OT2, OT3, LD1–LD6, combinations, turn1 conclusions
> Original turn files: IMMUTABLE

## Findings (ranked)

Merged from two independent reviewers. Dupes collapsed. Rank = max of the two when they disagreed (skill-install: reviewer B called rank 5, reviewer A rank 4 → keep 4: claim is incomplete, not invalid — install was already an OT2 lean).

### Rank 5 (Sophisticated)

none

### Rank 4 (Significant)

- **G4.1 CLI search fan-out already skips hermes + 3 agents**
  - What: `bin/oas` `createSearchService()` only wires `opencode, codex, claude, acpx, pi, grok`. `hermes, gemini, antigravity, zcode` silently dropped from CLI `--text` search TODAY. Search also handles `acpx` while `createAllAgentFactories()` may not — asymmetric.
  - Why missed: Turn1 treated CLI `--text` as working and only `--tool` as missing (CA1/LD3). Enabling hermes in live config does not make `oas session search --text` query hermes. Stage 2 `--tool` copied from that if/else will inherit the hole.
  - Severity: 4
  - Mitigation: `--tool` MUST fan out via `AdapterHandle` + `buildHandle` (extend registry). Test: every enabled `AgentKind` is queried. Do not clone `createSearchService` if/else. Existing `--text` gap = follow-up bug, not this ticket's inventory product.

- **G4.2 mcp-only does not escape bun-on-PATH**
  - What: `oas mcp` is still `#!/usr/bin/env bun`. MCP host spawn env is often stripped (no mise shims). Live bun = `~/.local/share/mise/installs/node/22.22.2/bin/bun`. Findings treated mcp as the no-bash escape hatch; that hatch dies the same PATH death, and the agent cannot shell to fix PATH.
  - Why missed: LD3 tied bun to shell surfaces only.
  - Severity: 4
  - Mitigation: MCP registration uses absolute interpreter (`<abs bun-or-shim> <abs>/bin/oas mcp`) or install wrapper with baked bun. Probe: `env -i` spawn still starts. Prefer mise shim `~/.local/share/mise/shims/bun` over version-pinned path (G2.3).

- **G4.3 SKILL.md in OAS repo is invisible until installed into a host pool**
  - What: Skill-only agents read host pools (`~/.pi/agent/skills`, hermes profiles, claude skills), not the OAS repo. `skills/oas-use/SKILL.md` in OAS reaches zero agents until symlink/copy. `~/.agents/skills` is the 5-leftover dir — forbidden as the shared pool (parent CA).
  - Why missed: OT2 named the repo file and waved "install is a one-liner". The load-bearing half is the install.
  - Severity: 4
  - Mitigation: OT2 resolution MUST name per-host symlink targets. OAS file = source of truth. Hosts point AT OAS (layer on top). Do not dump into cli-agent-skills git (LD2). Do not use `~/.agents/skills`.

- **G4.4 Updating `oas-use` cmd contradicts LD2**
  - What: Barely-fit said "update oas-use" (CA4 stale gotcha, `--tool`, cwd vs home). Canonical file is `cli-agent-cmd/cmds/pi/oas-use.md`. LD2: this slice lands in open-agent-sessions only.
  - Why missed: References listed the canonical path; never reconciled "update it" vs LD2.
  - Severity: 4
  - Mitigation: Do **not** edit cli-agent-cmd in BHD-145. Cmd stays as-is (still shells `oas`; `--tool` works once CLI has it). Stale gotcha text = parked follow-up. Skill SoT lives in OAS.

- **G4.5 MCP stdio stdout pollution**
  - What: JSON-RPC on stdout. `console.log`, bun startup, `[pi:omo] path not found` on stderr is OK; anything on stdout breaks the protocol. Reviewer B ranked this 4 (protocol-breaking).
  - Why missed: OpenClaw pattern cited without runtime hygiene.
  - Severity: 4
  - Mitigation: MCP server in-process; non-RPC → stderr only. Probe: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}' | oas mcp` yields clean JSON.

### Rank 3 (Moderate)

- **G3.1 cmd-only / skill-only silently redefined to include bash**
  - What: Ticket lists "cmd only" / "skill only". Turn1 decided these imply bash ("pi reality") and routes bash-denied to mcp-only. If issuer meant literal no-shell, Stage 2 as specced fails LD1 #1–2.
  - Why missed: Inline decision, no OT, no user lock.
  - Severity: 3
  - Mitigation: Lock as LD7. Cmd-only = cmd knowledge + bash allowed. Skill-only = skill present + bash allowed. Literal no-bash = mcp-only. Combinations named accordingly.

- **G3.2 MCP spawn cwd + config-once**
  - What: `loadConfig()` cwd-first. MCP server cwd = client project; config loaded once at spawn. Home config (after hermes patch) ≠ repo 9-agent config. Same tool, different results.
  - Why missed: Cwd-first analyzed for CLI, not MCP spawn.
  - Severity: 3
  - Mitigation: `OAS_CONFIG` (or `--config`) on MCP server. Document restart-on-config-change. Home config = curated subset; do not pretend it equals repo file.

- **G3.3 MCP registration is per-host config outside OAS**
  - What: mcp-only needs pi `mcp.json` / claude MCP config snippets. OAS-repo-only code cannot satisfy must-have #4 without a documented registration step.
  - Why missed: OT1 debated building the server, not how a host learns it.
  - Severity: 3
  - Mitigation: Plan includes registration snippets as docs in OAS (`USAGE` / findings). Applying them on this machine is Stage 2 probe, not a second product.

- **G3.4 JSON list timeout sits on MCP critical path**
  - What: CA2: `session list --format json --limit 1 --last 4h` timed out 20s; text returned ~15s. MCP returns JSON. OT1 smoke used the flaky path. n=1.
  - Why missed: Callout, not a design constraint.
  - Severity: 3
  - Mitigation: MCP tools call SDK in-process (not shell `oas`). Probe with `--format text` and/or `--limit 1 --last 4h` with 60s budget. Do not block DoD on unrooted JSON hang; file as follow-up if still >10s in-process.

- **G3.5 "shells existing CLI verbs" vs in-process**
  - What: Cited OpenClaw pattern is in-process wrap. Findings said "shells CLI" → bun cold start per call + stderr into stdio risk.
  - Why missed: Word "shells" in barely-fit table.
  - Severity: 3
  - Mitigation: MCP imports SDK services in-process. No `spawn oas` per tool.

- **G3.6 pi:omo dead path noise**
  - What: Repo config `pi:omo` path missing. Broken-adapter prints every list. MCP stderr-routing hazard.
  - Why missed: Treated as resolved behavior.
  - Severity: 3
  - Mitigation: Same live-config edit: disable or fix `pi:omo`. Optional `oas config --validate` already exists — use it in probe.

- **G3.7 install.sh wrapper vs live symlink**
  - What: Live `~/.local/bin/oas` is symlink to repo `bin/oas`, not install.sh wrapper. Wrapper still PATH-bun. Contention if installer reruns.
  - Why missed: Recorded, not decided.
  - Severity: 3
  - Mitigation: Canonical = keep symlink for this machine; MCP registration uses abs bun + abs bin. Do not re-run install.sh as the Stage 2 path.

### Rank 2 (Minor)

- **G2.1 hermes skill `cd` side-effect remains**
  - What: `axis-oas-work-discovery` cds into OAS repo. After home-config hermes enable, `cd` still mutates cwd and picks 9-agent repo config.
  - Mitigation: Do not rewrite that hermes skill (OT2 / parent research). Document: prefer `--config` / `OAS_CONFIG` later. Severity 2.

- **G2.2 long-lived MCP + process-global caches**
  - What: `detailCache` LRU no TTL. CLI process dies; MCP process lives → stale detail.
  - Mitigation: `clearDetailCache()` per MCP tool or short TTL. Severity 2.

- **G2.3 version-pinned bun path rot**
  - What: `.../node/22.22.2/bin/bun` breaks on mise bump.
  - Mitigation: mise shim or `~/.local/bin/bun` if present. Severity 2.

- **G2.4 combo coverage by construction**
  - What: Named 5 combos; others claimed to follow. Fan-out hole (G4.1) breaks that claim.
  - Mitigation: Stage 2 DoD = one probe per named surface + one named combo, not all 2^4. Severity 2.

- **G2.5 MCP inspector not named as verifier**
  - What: Reviewer B listed inspector as rank 5 then scored 2. Correct rank 2: verification method, not a product hole.
  - Mitigation: Stage 2 probe names `mcp-inspector` OR raw JSON-RPC stdin. Severity 2.

### Rank 1

none

## Cross-references

- G4.1 extends CA1 / LD3 (tool search) — registry, not bin if/else.
- G4.2 extends LD3 bun PATH — mcp spawn env.
- G4.3 extends OT2.
- G4.4 extends LD2.
- G4.5 / G3.5 extend OT1 thin mcp.
- G3.1 → new LD7.
- G3.2 / G3.3 / G3.4 / G3.6 / G3.7 → plan items.
- Parent BHD-141 matrix explore: still cited; heatmap stays OT3 deferred.

## Auto-decided (does not supersede user LDs)

- LD7 (new, auto): cmd-only and skill-only include bash; no-bash = mcp-only. See locked-decisions.yaml.
- No user LD invalidated. ASK not required.
