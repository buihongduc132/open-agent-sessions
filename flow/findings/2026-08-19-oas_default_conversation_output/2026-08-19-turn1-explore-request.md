# Explore Turn 1 — request: conversational default for `oas`

> Date: 2026-08-19
> Phase: explore-mode entry, codebase recon
> Status: complete (investigation only, no conclusions yet — pure tool work)

## User message

> **[user]** (verbatim — trust chain L1)
>
> make the default usage of oas to be showing user + sub agents message first only ; like the conversation , instead of verbose information ; ensure that it is not broken any of the downstream functionalities ; whenever need all information , user could add another flag into it ;

Remainder of the message was the `/opsx:explore` cmd template (explore-mode stance, search-strategies mandate, guardrails: no implementing, no artifact-formatting). Cmd family marker: `→ Family: ~/.pi/agent/cmd-family/ospx.yml (step 10/70)`. Template content not user-authored; not reproduced here.

**Request parsed into 3 constraints:**
1. Default output = conversation view (user + sub-agent messages first), not verbose info.
2. Downstream functionalities must NOT break.
3. Full information reachable via an additional flag.

## Assistant investigation (tool work — no prose this turn)

Command: `eza --git-ignore -T -L 2` + `-L 3 src/cli` produced the layout:

```
src/cli
├── children.ts
├── clone.ts
├── config.ts
├── detail.ts
├── export.ts
├── formatters
│  ├── json.ts
│  └── text.ts
├── list.ts
├── read.ts
├── search-boolean.ts
├── search.ts
├── sessions.ts
├── similar.ts
├── tree.ts
├── types.ts
└── utils
   ├── agents.ts
   ├── colors.ts
   ├── config.ts
   ├── format.ts
   └── time-parser.ts
```

`src/` top level: `adapters/` (acpx, antigravity, claude, codex, gemini, hermes, opencode, pi, zcode, content-utils, fs-utils, label), `cli/`, `config/`, `core/` (clone, constants, export, list, normalize, registry, search, subagents, types, utils), `index.ts`.

`package.json` (head): name `open-agent-sessions` v0.1.0, `"bin": { "oas": "./bin/oas" }`, scripts: `test` = `bun test`, `typecheck` = `tsc --noEmit`, `build` = bun build src/index.ts. Exports map `./adapters/*` per-agent.

### `src/cli/read.ts` — read in FULL (most load-bearing file of the session)

USAGE string reproduced verbatim (this defines the current CLI surface the change must extend):

```
Usage: oas read --session <session_id> [options]
       oas read --agent <agent> --alias <alias> --id <session_id> [options]

Options:
  --session S     Session ID (supports short forms: session_id, alias:session_id, or agent:alias:session_id)
  --agent A       Agent type (opencode, codex, claude)
  --alias L       Agent alias
  --id I          Session ID
  --first N       First N messages
  --last N        Last N messages (default: 10)
  --all           All messages
  --range S:E     Message range (1-indexed, inclusive)
  --user-only     Show only user messages (composable with --first/--last/--all/--range)
  --tools         Include tool messages (default: hide)
  --role R        Filter by role (user, assistant, system)
  --format F      Output format: text (default), json, csf, markdown, md
  --output FILE   Write output to file (recommended for large outputs)

Session ID formats:
  - session_id              Uses first enabled agent/alias from config
  - alias:session_id        Uses first agent with matching alias
  - agent:alias:session_id  Full format (explicit)

Output formats:
  text      Plain text (default)
  json      Structured JSON
  csf       Canonical Session Format (JSON) — cross-agent transfer
  markdown  Human-readable Markdown (alias: md)

Either --session or all of --agent, --alias, --id must be specified.
One of --first, --last, --all, --range is required (--user-only is optional and additive).
```

Key structural facts extracted from read.ts:

- `ReadService = (query, options: SessionReadOptions) => Promise<SessionDetail | null>`
- `runReadCommand` flow: validate `--format` ∈ {text,json,csf,markdown,md} → resolveConfig → resolveTarget (3 session-spec formats: bare id / `alias:id` / `agent:alias:id`) → `parseSelectionOptions` → role validation → build `SessionReadOptions` → fetch → format.
- Read mode wiring: `mode: options.tools ? "all_with_tools" : "all_no_tools"` — tools filtering happens at ADAPTER level, not formatter level, via the read mode.
- Format dispatch (exact code):

```typescript
  const formatterOptions: TextFormatterOptions = {
    showTools: options.tools,
  };
  let stdout: string;
  if (options.format === "json") {
    stdout = formatSessionDetailJson(detail, formatterOptions);
  } else if (options.format === "csf") {
    stdout = JSON.stringify(toCsf(detail), null, 2) + "\n";
  } else if (options.format === "markdown" || options.format === "md") {
    stdout = toMarkdown(detail) + "\n";
  } else if (options.format === "text") {
    stdout = toText(detail) + "\n";
  } else {
    // Default: text formatter (original behavior)
    stdout = formatSessionDetail(detail, target, formatterOptions) + "\n";
  }
```

Note the split: `--format text` → `toText()` (core/export.ts), NO flag → `formatSessionDetail()` (cli/formatters/text.ts). Two different "text" paths — only the no-flag default path is the change target.

- `parseSelectionOptions` rules: `--first/--last/--all/--range` mutually exclusive (error if >1); `--user-only` is ADDITIVE, not exclusive; `--user-only` alone ⇒ `{mode:"last",count:10,userOnly:true}`; no flags ⇒ `{mode:"last",count:10}`.
- `--output FILE` writes to disk, returns empty stdout + stderr note. `wrapLargeOutput` guards subprocess buffer truncation.

`wc -l`: formatters/text.ts 354, list.ts 219, detail.ts 284, tree.ts 86, children.ts 54, bin/oas 1093. `bin/oas` head: imports run{Sessions,Read,Search,List,Detail,Clone,Config,Export,Similar}Command from src/cli/*, TUI from src/tui/App, adapter registry from src/core/registry.

## Status at end of turn 1

Constraints captured (clean default / no downstream break / flag for full info). Read command surface + selection semantics mapped. No prose analysis emitted yet. → Turn 2 (`2026-08-19-turn2-continue-formatter-dispatch.md`) maps the formatter internals + CLI dispatch.
