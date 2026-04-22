# open-agent-sessions

> Unified session management for AI coding agents. Browse, search, read, and clone sessions across OpenCode, Codex, Claude, and acpx — through a single CLI or TypeScript SDK.

```
Session List              Session Detail           Fork Tree
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│ ● Sessions          │  │ ● Session Detail   │  │ ● Fork Tree         │
│   opencode:default  │  │ Session: abc-123   │  │   ● 0e87 ─┬─ 0e88
│   codex:sessions     │  │ Title:   Fix bug  │  │   │        └─ 0e89
│   claude:default     │  │ Agent:   opencode  │  │   ● 0e86
│                      │  │ Alias:   default   │  │
│   [j/k] move        │  │ Updated: 2h ago   │  │
│   [h] drill agent   │  │ Messages: 24      │  │
│   [/] filter        │  │ ─────────────────  │  │
│   [l] open detail   │  │ user: Can you...   │  │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

## Features

| Feature | CLI | SDK | Notes |
|---|:---:|:---:|---|
| **OpenCode sessions** — list, search, detail, read | ✅ | ✅ | Full SQLite + JSONL support |
| **Codex sessions** — list, detail | ✅ | ✅ | Reads `~/.codex/state_5.sqlite` |
| **Claude Desktop sessions** — list, detail | ❌ | ✅ | JSONL-based |
| **acpx sessions** — list, search, detail | ❌ | ✅ | `~/.acpx/sessions/*.json` |
| **Session cloning** — Codex → OpenCode | ✅ | ✅ | Preserves conversation history |
| **Session forking** — fork across agents | ❌ | ✅ | R-39, CSF format |
| **Interactive TUI** — browse sessions, clone | ✅ | — | VIM-style keybindings (`j/k/h/l`) |
| **Export** — CSF, Markdown, plain text | ✅ | ✅ | Canonical Session Format (CSF) |
| **Cursor pagination** | ✅ | ✅ | `oas sessions --limit 20 --after <cursor>` |
| **Content search** | ✅ | ✅ | OpenCode, Codex, Claude, acpx |
| **Tool/MCP usage search** | ❌ | ✅ | `toolSearchSessions()` (R-41) |
| **Performance caching** | ✅ | ✅ | QuickLRU cache (20 list entries, 50 detail entries) |

---

## TL;DR — Quick Start

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/buihongduc132/open-agent-sessions/main/scripts/install.sh | bash

# Or: clone + mise
git clone https://github.com/buihongduc132/open-agent-sessions.git
cd open-agent-sessions && mise install

# List sessions (last 24h)
oas session list

# List with time filter
oas session list --last 4h
oas session list --since 2026-01-01 --limit 20

# Read session messages
oas session read <session-id>
oas session read opencode:default:<session-id>
oas session read <session-id> --last 20 --format json

# Search (titles + content, with boolean operators)
oas session search --text "fix authentication bug"
oas session search --text "ast-grep AND comby"
oas session search --text "error OR warning" --format json
oas session search --text "config NOT testing"

# Filtered list
oas session list --agent opencode --alias default --q "bug"
oas session list --roots-only --full --format json

# Clone (Codex → OpenCode)
oas session clone --from codex:work:<session-id> --to opencode:default

# Export session
oas session export opencode:default:<session-id> --format markdown
oas session export opencode:default:<session-id> --format csf --output session.csf.json

# Interactive TUI
oas tui

# TypeScript SDK
import { createRegistry, loadConfig } from "open-agent-sessions";
```

---

## Architecture

```
open-agent-sessions
├── bin/oas                         # CLI entry point (shebang: bun)
├── src/
│   ├── config/                     # YAML config loading + validation
│   │   └── types.ts               # AgentKind, AgentEntry, Config, Storage modes
│   ├── core/
│   │   ├── registry.ts             # Adapter registry (register + lookup)
│   │   ├── list.ts                # List operations + cursor pagination + cache
│   │   ├── normalize.ts           # Unified SessionSummary format
│   │   ├── clone.ts              # Cross-agent session cloning (CSF)
│   │   ├── export.ts             # CSF / Markdown / text export
│   │   ├── subagents.ts         # Sub-agent extraction from messages (R-41)
│   │   └── types.ts             # SessionSummary, SessionDetail, Adapter interface
│   ├── adapters/
│   │   ├── opencode.ts          # OpenCode: SQLite + JSONL, full CRUD
│   │   ├── codex.ts             # Codex: SQLite + JSONL
│   │   ├── claude.ts           # Claude Desktop: JSONL
│   │   └── acpx.ts             # acpx: `~/.acpx/sessions/*.json` (R-31)
│   ├── cli/                      # CLI command handlers
│   │   ├── sessions.ts          # oas sessions: time-filtered list
│   │   ├── list.ts             # oas list-new: agent/alias/q filtered list
│   │   ├── read.ts             # oas read: message retrieval + filtering
│   │   ├── search.ts           # oas search: content search across adapters
│   │   ├── detail.ts           # oas detail: session detail view
│   │   ├── clone.ts            # oas clone: Codex → OpenCode copy
│   │   ├── export.ts           # oas session export: CSF/Markdown/text export
│   │   ├── config.ts           # oas config: config inspection
│   │   └── formatters/         # Output formatters (text, JSON, ANSI colors)
│   └── tui/                    # Interactive terminal UI (Ink/React)
│       ├── App.tsx             # Main TUI orchestrator + view router
│       ├── list-model.ts       # List view state: selection, filters, navHistory
│       ├── detail-model.ts     # Detail view state: scrolling, message lines
│       ├── timeline-model.ts  # Timeline view: sub-agent + tool + reasoning
│       └── tree-model.ts       # Fork tree view: parent-child session graph
└── test/                       # 1000+ tests (bun test)
```

### Adapter Interface

Every adapter implements the `Adapter` interface:

```typescript
interface Adapter {
  readonly version: string;
  listSessions(): Promise<SessionSummary[]>;
  listSessionsByTimeRange?(options: TimeRangeOptions): Promise<SessionSummary[]>;
  searchSessions?(query: SearchQuery): Promise<SessionSummary[]>;
  toolSearchSessions?(query: ToolSearchQuery): Promise<SessionSummary[]>; // R-41
  getSessionDetail?(sessionId: string, options: SessionReadOptions): Promise<SessionDetail>;
  forkSession?(sourceId: string, destAgent: string, destAlias: string): Promise<ForkResult>; // R-39
}
```

### Session Data Model

```typescript
interface SessionSummary {
  id: string;                          // UUID
  agent: "opencode" | "codex" | "claude" | "acpx";
  alias: string;                      // e.g. "default", "work", "~/repos/backend"
  title: string;                       // Session title or "(untitled)"
  created_at: string;                  // ISO-8601
  updated_at: string;                  // ISO-8601
  message_count: number;
  storage: "db" | "jsonl" | "other";
}

interface SessionDetail extends SessionSummary {
  clone?: { src?: { agent; session_id; version };  // R-39: parent session link
  messages?: SessionMessage[];
  warning?: string;                   // e.g. "tools hidden by default"
  parentSessionId?: string;            // R-39: fork source
}

interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  created_at: string;
  parts: SessionPart[];
  modelID?: string;
  agent?: string;                     // Sub-agent name (R-41)
}

type SessionPart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; state: Record<string, unknown> }
  | { type: "reasoning"; text: string }  // o1/o3 chain-of-thought
  | { type: string; [key: string]: unknown };
```

---

## Configuration

Config file resolution order (first found wins):

```
oas.config.yaml        # project root (committed)
oas.config.yml         # project root
~/.config/oas/config.yaml   # user home
```

```yaml
# oas.config.yaml
agents:
  # OpenCode — CLI-ready
  - agent: opencode
    alias: default
    enabled: true
    storage:
      mode: auto       # auto | db | jsonl
      db_path: ~/.opencode/sessions.db
      jsonl_path: ~/.opencode/sessions.jsonl

  - agent: opencode
    alias: work
    enabled: true
    storage:
      mode: db
      db_path: ~/work/.opencode/sessions.db

  # Codex — library-only, CLI will skip if disabled
  - agent: codex
    alias: sessions
    enabled: true
    path: ~/.codex/state_5.sqlite

  # Claude Desktop — library-only
  - agent: claude
    alias: desktop
    enabled: false

  # acpx — library-only (R-31)
  - agent: acpx
    alias: default
    enabled: false
```

### Storage Modes (OpenCode)

| Mode | Description |
|---|---|
| `auto` | Prefer SQLite if both DB and JSONL exist |
| `db` | SQLite only (`~/.opencode/sessions.db`) |
| `jsonl` | JSONL only (`~/.opencode/sessions.jsonl`) |

---

## CLI Reference

### `oas session list` — List sessions

```bash
oas session list                          # last 24h, limit 50
oas session list --last 4h                # last 4 hours
oas session list --last 2d --limit 20    # last 2 days, 20 results
oas session list --since 2026-01-01T00:00:00Z
oas session list --until 2026-03-01       # up to March 2026
oas session list --format json            # machine-readable output
oas session list --limit 0                # all matching sessions
oas session list --agent opencode         # filter by agent
oas session list --alias default          # filter by alias
oas session list --q "bug fix"           # title/ID contains "bug fix"
oas session list --roots-only             # only root sessions (no sub-agents)
oas session list --sub-only               # only sub-agent sessions
oas session list --children-of <id>       # direct children of a session
oas session list --full                   # show full titles
oas session list --show-alias             # show all aliases including 'default'
```

Time formats: `4h`, `2d`, `1w`, `1M` (relative); ISO-8601 (absolute).

### `oas session read` — Read session messages

```bash
oas session read <session-id>                           # last 10 messages
oas session read opencode:default:<session-id>          # explicit agent:alias:id
oas session read <id> --session <session-id>            # --session flag form
oas session read --id <session-id> --agent opencode     # --id + --agent

# Message selection
oas session read <id> --last 5           # last 5 messages (default)
oas session read <id> --first 3        # first 3 messages
oas session read <id> --all            # all messages
oas session read <id> --range 5:10     # messages 5–10 (1-indexed, inclusive)
oas session read <id> --user-only      # only user messages (composable with --last/--first/--all/--range)

# Output
oas session read <id> --format text    # plain text (default)
oas session read <id> --format json     # structured JSON
oas session read <id> --output file.md   # write to file
oas session read <id> --all --tools     # include tool messages
oas session read <id> --role assistant  # filter by role
```

### `oas session search` — Content search

```bash
oas session search --text "fix authentication bug"    # searches across all enabled agents
oas session search --text "error" --format json       # JSON output

# Boolean operators (AND / OR / NOT)
oas session search --text "ast-grep AND comby"        # both terms required
oas session search --text "ast-grep comby"            # implicit AND
oas session search --text "ast-grep OR comby"         # either term
oas session search --text "ast-grep NOT comby"        # exclude term
oas session search --text "(ast-grep OR comby) AND session"  # grouping

# Regex patterns
oas session search --text "/gritql|ast-grep/"

# Pipe to jq
oas session search --text "error" --format json | jq -r '.[].id'
```

Searches session **titles and message content** across all enabled adapters.
Operator precedence: `NOT` > `AND` > `OR`.

### `oas session detail` — Session detail view

```bash
oas session detail opencode:default:<session-id>   # positional spec
oas session detail --session opencode:<session-id>  # --session flag
oas session detail --agent codex --alias work --id <session-id>
oas session detail <id> --format json               # JSON output
```

### `oas session clone` — Clone session (Codex → OpenCode)

```bash
oas session clone --from codex:sessions:<session-id> --to opencode:default
```

Direction enforced: Codex source → OpenCode destination. Cloning reads all messages from Codex, reformats to CSF, and writes as a new OpenCode session.

### `oas session export` — Export session

```bash
oas session export opencode:default:<session-id>              # CSF (default)
oas session export <id> --format markdown                    # Human-readable Markdown
oas session export <id> --format text                        # Plain text
oas session export <id> --output session.csf.json          # Write to file
```

Session ref formats: `session-id` · `alias:session-id` · `agent:alias:session-id`

### `oas tui` — Interactive TUI

```bash
oas tui
```

VIM-style navigation (`j/k` up/down, `h/H` agent drill, `a/L` alias drill, `l` open detail). See [TUI Reference](#tui-reference) below.

### `oas session similar` — Find similar sessions

```bash
oas session similar <session-id>              # top 5 similar sessions
oas session similar <session-id> --top 10     # top 10 results
oas session similar <session-id> --format json # JSON output
```

Uses hybrid FTS5 + vector similarity (RRF fusion) to find sessions with related content.

### `oas config` — Config inspection

```bash
oas config          # show resolved config
oas config paths     # list all config file paths searched
oas config validate # validate config without running commands
```

---

## TUI Reference

The TUI (`oas tui`) has four views: **List**, **Detail**, **Fork Tree**, **Timeline**.

### Views

| View | Description |
|---|---|
| **List** | Paginated session list, filterable by agent/alias/text |
| **Detail** | Session metadata + full message thread, scrollable |
| **Fork Tree** | ASCII tree of parent → child session relationships |
| **Timeline** | Chronological view with sub-agent + tool + reasoning filters |

### Keybindings

| Key | List View | Detail View | Fork Tree | Timeline |
|---|---|---|---|---|
| `j` / `↓` | Move down | Scroll down | Move down | Scroll message |
| `k` / `↑` | Move up | Scroll up | Move up | Scroll message |
| `g` | Jump to top | Jump to top | Jump to top | — |
| `G` | Jump to bottom | Jump to bottom | Jump to bottom | — |
| `l` / `→` / `Enter` | Open session detail | — | Open node detail | — |
| `h` / `←` | Drill into agent filter | Back to list | Collapse node | Back to detail |
| `H` | Back out of agent drill | — | — | — |
| `a` | Drill into alias filter | — | — | — |
| `L` | Back out of alias drill | — | — | — |
| `/` | Enter filter mode | — | — | — |
| `Esc` / `0` | Clear filters | Back to list | Back to list | Back to detail |
| `t` | Open timeline | — | Open timeline | — |
| `Tab` | Cycle: list → tree | — | Back to list | — |
| `c` | Clone session (codex only) | — | — | — |
| `m` | — | — | — | Toggle tool messages |
| `r` | — | — | — | Toggle reasoning |
| `P` | Toggle perf overlay | — | — | Toggle perf overlay |
| `?` | Help overlay | Help overlay | — | — |
| `q` | Quit | Back to list | Back to list | Back to list |

### TUI Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OAS_DEBUG_PERF=1` | `0` | Emit `[PERF]` timing lines to stderr |
| `OAS_LIST_TIMEOUT_MS` | `8000` | Timeout for list operations |

---

## TypeScript SDK

### Programmatic Setup

```typescript
import { createOpenCodeAdapter, createCodexAdapter, createClaudeAdapter, createAcpxAdapter } from "open-agent-sessions/adapters";
import { createRegistry } from "open-agent-sessions/core/registry";
import type { AgentEntry } from "open-agent-sessions/config/types";

// Register all agents
const entries: AgentEntry[] = [
  { agent: "opencode", alias: "default", enabled: true, storage: { mode: "auto" } },
  { agent: "codex", alias: "sessions", enabled: true, path: "~/.codex" },
];

const registry = createRegistry(entries, {
  opencode: (entry) => createOpenCodeAdapter(entry, { cwd: process.cwd() }),
  codex: (entry) => createCodexAdapter(entry, { defaultPath: (entry as any).path }),
  claude: (entry) => createClaudeAdapter(entry, {}),
  acpx: (entry) => createAcpxAdapter(entry, {}),
});
```

### List Sessions

```typescript
import { listSessions } from "open-agent-sessions/core/list";

// All sessions (no filter)
const { sessions, errors } = await listSessions(registry);

// Filtered list
const result = await listSessions(registry, {
  agent: "opencode",
  alias: "default",
  q: "authentication",
});

// Cursor pagination
const page1 = await listSessions(registry, { limit: 20 });
if (page1.nextCursor) {
  const page2 = await listSessions(registry, {
    limit: 20,
    after: page1.nextCursor,
  });
}
```

### Read Session

```typescript
import { getSessionDetail } from "open-agent-sessions/core/detail";

const detail = await getSessionDetail(registry, {
  agent: "opencode",
  alias: "default",
  session_id: "<id>",
}, {
  mode: "all_no_tools",       // or "all_with_tools", "last_message"
  selection: {
    mode: "last",             // or "first", "all", "range", "user-only"
    count: 10,
  },
});

for (const msg of detail.messages ?? []) {
  for (const part of msg.parts) {
    if (part.type === "text") console.log(`${msg.role}: ${part.text}`);
  }
}
```

### Content Search

```typescript
import { searchSessions } from "open-agent-sessions/core/search";

const { sessions, errors } = await searchSessions(registry, {
  text: "fix authentication bug",
});
```

### Clone Session (Codex → OpenCode)

```typescript
import { createCloneService, type CloneRegistry } from "open-agent-sessions/core/clone";

const cloneService = createCloneService({
  getSource: (src) => src.agent === "codex" && src.alias
    ? createCodexCloneSourceAdapter(entry, { cwd: process.cwd() })
    : undefined,
  getDestination: (dst) => dst.agent === "opencode" && dst.alias
    ? createOpenCodeCloneDestinationAdapter(entry, { cwd: process.cwd() })
    : undefined,
});

const result = await cloneService({
  source: { agent: "codex", alias: "sessions", session_id: "<codex-id>" },
  destination: { agent: "opencode", alias: "default" },
});

console.log(result.destinationId); // new OpenCode session ID
```

### Export (CSF / Markdown / Text)

```typescript
import { toCsf, toMarkdown, toText } from "open-agent-sessions/core/export";
import { getSessionDetail } from "open-agent-sessions/core/detail";

const detail = await getSessionDetail(registry, { agent: "opencode", alias: "default", session_id: "<id>" }, {});

const csf = toCsf(detail);           // Structured JSON
const md = toMarkdown(detail);       // Human-readable Markdown
const txt = toText(detail);          // Plain text
```

---

## Performance

All list operations are fast (<100ms) after recent optimizations:

| Operation | Before | After | Fix |
|---|---|---|---|
| `oas list --agent opencode` | 14,867ms | 65ms | Agent filter routes to matching adapter only |
| `oas list --agent codex` | 17,418ms | 29ms | Codex SQLite backend (was loading 6185 JSONL entries) |
| Pagination page 2 | 28,275ms | 99ms | `skipSessionId` wired through to adapters |
| Repeated list calls | 14,552ms each | ~0ms | QuickLRU list cache (20 entries) |

**Caching**: `QuickLRU` cache — 20 list entries (agent+alias+q keyed), 50 detail entries. Cleared on fork/clone.

---

## Installation

### curl | bash (users)

```bash
curl -fsSL https://raw.githubusercontent.com/buihongduc132/open-agent-sessions/main/scripts/install.sh | bash
```

Options: `OAS_INSTALL_DIR`, `OAS_BIN_DIR`, `OAS_BRANCH`, `OAS_SKIP_BUN`

### mise (developers)

```bash
git clone https://github.com/buihongduc132/open-agent-sessions.git
cd open-agent-sessions
mise install          # installs Bun 1.1.0 (from mise.toml)
bun install
bun test             # run tests
```

### Manual (Bun required)

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/buihongduc132/open-agent-sessions.git
cd open-agent-sessions
bun install
```

---

## Development

```bash
bun test                     # all tests
bun test --watch           # watch mode
bun test test/list-core     # specific file
bun run typecheck           # tsc --noEmit
bun run build               # build to ./dist
bun run ci                  # typecheck + build + test
```

### mise tasks

```bash
mise run test               # bun test
mise run test:coverage      # with coverage
mise run test:coverage:core # coverage excluding TUI
mise run typecheck / mise run tc
mise run build / mise run b
mise run dev / mise run d   # watch mode
mise run ci                 # full pipeline
mise run clean              # remove dist/
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). This project follows TDD — write tests first, implement to pass, refactor while green.

---

## Project Status

| Component | Status |
|---|---|
| OpenCode adapter | ✅ Stable |
| Codex adapter | ✅ Stable |
| Claude adapter | ✅ Stable |
| acpx adapter (R-31) | ✅ Stable |
| CLI (`bin/oas`) | ✅ Stable |
| Interactive TUI (`oas tui`) | ✅ Stable |
| Session forking (R-39) | ✅ Stable |
| Session cloning (Codex→OpenCode) | ✅ Stable |
| CSF Export (R-16) | ✅ Stable |
| Tool/MCP search (R-41) | ✅ Stable |
| Cursor pagination | ✅ Stable |
| Performance optimizations | ✅ Stable |

> Tests: 1089 pass, 0 fail (as of PR #9, `feat/vim-navigation-perf`)
