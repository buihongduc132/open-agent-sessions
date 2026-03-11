# open-agent-sessions

A unified session management library for AI coding agents. Access, search, and manage sessions across multiple AI agent platforms (OpenCode, Codex, Claude) through a single interface.

## Features

| Feature | CLI | Library | Notes |
|---------|:---:|:-------:|-------|
| **OpenCode Sessions** | ✅ | ✅ | Full support: list, search, detail, read |
| **Codex Sessions** | ⚠️ Clone only | ✅ | CLI: clone source only; Library: list |
| **Claude Sessions** | ❌ | ✅ | Library: list only; CLI: not supported |
| **Session Search** | ✅ OpenCode | ✅ | CLI: OpenCode only |
| **Clone Sessions** | ✅ Codex→OpenCode | ✅ | CLI: Codex source → OpenCode dest only |
| **TUI (Interactive)** | 📋 Planned | — | Code exists, not wired to CLI |

> **Note**: CLI is **OpenCode-only** (except clone). Codex/Claude adapters are library-only.
> See [docs/cli-feature-matrix.md](docs/cli-feature-matrix.md) for detailed feature status.

### Core Capabilities

- **Flexible Storage**: Support for SQLite databases and JSONL files
- **YAML Configuration**: Simple, declarative configuration for multiple agent instances
- **Session Operations**:
  - List sessions with filtering and sorting
  - Search sessions by content
  - View detailed session information with messages
  - Clone sessions between agents (Codex → OpenCode)
- **Multiple Interfaces**:
  - Programmatic API for library usage (all agents)
  - CLI commands for terminal workflows (OpenCode)
  - TUI (Terminal UI) for interactive browsing (planned)
- **Type-Safe**: Written in TypeScript with full type definitions

## Installation

This project requires [Bun](https://bun.sh) runtime.

```bash
# Install Bun if you haven't already
curl -fsSL https://bun.sh/install | bash

# Clone the repository
git clone https://github.com/buihongduc132/open-agent-sessions.git
cd open-agent-sessions

# Install dependencies
bun install

# Run tests
bun test
```

## Configuration

Create a YAML configuration file to define your agent instances:

> ⚠️ **For CLI usage**: Only enable `opencode` agents. Codex/Claude will cause CLI errors.

```yaml
agents:
  # OpenCode - CLI ready
  - agent: opencode
    alias: main
    enabled: true
    storage:
      mode: auto  # auto | db | jsonl
      db_path: ~/.opencode/sessions.db
      jsonl_path: ~/.opencode/sessions.jsonl

  - agent: opencode
    alias: work
    enabled: true
    storage:
      mode: db
      db_path: ~/work/.opencode/sessions.db

  # Codex - library only (disable for CLI use)
  # - agent: codex
  #   alias: default
  #   enabled: false
  #   path: ~/.codex

  # Claude - library only (disable for CLI use)
  # - agent: claude
  #   alias: desktop
  #   enabled: false
```

### Configuration Options

#### Storage Modes (OpenCode)

- `auto`: Automatically prefer DB if both DB and JSONL exist
- `db`: Use SQLite database storage
- `jsonl`: Use JSONL file storage

#### Agent Types

- `opencode`: OpenCode AI agent sessions
- `codex`: Codex agent sessions
- `claude`: Claude Desktop sessions

## Usage

### Programmatic API

```typescript
import { loadConfig, createRegistry, listAllSessions } from "open-agent-sessions";

// Load configuration
const config = await loadConfig("./config.yaml");

// Create adapter registry
const registry = createRegistry();

// Register adapters from config
for (const entry of config.agents) {
  if (entry.enabled) {
    const adapter = createAdapter(entry);
    registry.register(entry.agent, entry.alias, adapter);
  }
}

// List all sessions across all agents
const sessions = await listAllSessions(registry);

for (const session of sessions) {
  console.log(`[${session.agent}:${session.alias}] ${session.title}`);
  console.log(`  ID: ${session.id}`);
  console.log(`  Updated: ${session.updated_at}`);
  console.log(`  Messages: ${session.message_count}`);
}
```

### Session Detail

```typescript
import { getSessionDetail } from "open-agent-sessions";

const detail = await getSessionDetail(
  registry,
  {
    agent: "opencode",
    alias: "main",
    session_id: "abc123"
  },
  { mode: "all_no_tools" }
);

console.log(detail.title);
for (const message of detail.messages || []) {
  console.log(`${message.role}: ${message.parts[0].text}`);
}
```

### CLI Usage

> ⚠️ **CLI is OpenCode-only** (except `clone`). Codex/Claude adapters are library-only and will cause CLI errors if enabled in config.

```bash
# List Sessions
oas list [limit]            # List recent OpenCode sessions (default: 10)
oas recent [limit]          # Same as list
oas sessions [options]      # List with time filtering
oas list-new [options]      # List with agent/alias filters

# View Session
oas find <session-id>       # Show session details by ID
oas show <session-id>       # Same as find
oas detail [options]        # Show session detail view
oas read <session-id>       # Read session messages

# Search & Clone
oas search --text <query>   # Search sessions by title and content
oas clone --from <spec> --to <spec>  # Clone session (Codex→OpenCode)

# Utility
oas onboard                 # Initialize bd (beads) for project
```

#### Command Options

**sessions** - Time-based filtering:
- `--last DURATION` - Last duration (e.g., 4h, 2d, 1w)
- `--since TIMESTAMP` - Start time (ISO-8601)
- `--until TIMESTAMP` - End time (ISO-8601)
- `--limit N` - Maximum results (default: 50, 0 = all)
- `--format FORMAT` - Output format: text (default) or json

**list-new** - Agent/alias filtering:
- `--agent NAME` - Filter by agent (opencode, codex, claude)
- `--alias NAME` - Filter by agent alias
- `--q QUERY` - Filter by session ID or title

**detail** - Session spec (positional or flags):
- `<session-id>` - Positional: `agent:alias:session_id`
- `--session SPEC`, `--agent NAME`, `--alias NAME`, `--id SESSION_ID`

**search** - Content search:
- `--text QUERY` - Search text (required)

**clone** - Cross-agent copy:
- `--from SPEC` - Source (agent:session_id or agent:alias:session_id)
- `--to SPEC` - Destination (agent:alias)

### TUI (Planned)

A Terminal User Interface (TUI) is implemented in `src/tui/` but not wired to the `bin/oas` CLI. To run during development:

```bash
bun run src/tui/App.tsx
```

## Architecture

### Core Components

- **Config**: YAML configuration loading and validation
- **Registry**: Adapter registration and lookup
- **Adapters**: Platform-specific session access implementations
- **Normalization**: Unified SessionSummary format across adapters
- **CLI**: Command-line interface
- **TUI**: Terminal user interface

### Adapter Interface

Each adapter implements:

```typescript
interface Adapter {
  listSessions(): Promise<SessionSummary[]> | SessionSummary[];
  searchSessions?(query: SearchQuery): Promise<SessionSummary[]> | SessionSummary[];
  getSessionDetail?(sessionId: string, options: SessionReadOptions): Promise<SessionDetail>;
}
```

### Session Data Model

```typescript
interface SessionSummary {
  id: string;
  agent: "opencode" | "codex" | "claude";
  alias: string;
  title: string;
  created_at: string;  // ISO-8601
  updated_at: string;  // ISO-8601
  message_count: number;
  storage: "db" | "jsonl" | "other";
}
```

## Development

### Scripts

```bash
# Run tests
bun test                      # Run all tests
bun run test:coverage         # Run with coverage
bun run test:coverage:core    # Coverage excluding TUI

# Build and typecheck
bun run build                 # Build to ./dist
bun run typecheck             # TypeScript type checking
```

### Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test test/config.test.ts

# Watch mode
bun test --watch
```

### Project Structure

```
src/
├── adapters/       # Platform-specific adapters
│   ├── opencode.ts # OpenCode adapter (full: list, search, detail)
│   ├── codex.ts    # Codex adapter (list, clone source)
│   └── claude.ts   # Claude adapter (list)
├── cli/            # Command-line interface
│   ├── list.ts
│   ├── detail.ts
│   └── clone.ts
├── config/         # Configuration loading and validation
│   ├── load.ts
│   ├── validate.ts
│   └── types.ts
├── core/           # Core functionality
│   ├── registry.ts # Adapter registry
│   ├── list.ts     # List operations
│   ├── normalize.ts # Data normalization
│   └── types.ts
├── tui/            # Terminal UI
│   └── App.tsx
└── index.ts        # Public API exports

test/               # Test suite
```

### Testing Philosophy

This project follows Test-Driven Development (TDD):

1. Write tests first that describe expected behavior
2. Implement minimal code to make tests pass
3. Refactor while keeping tests green
4. All features must have test coverage

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

## Project Status

This project is in active development. Core functionality for OpenCode sessions is implemented and tested. See [ROADMAP.md](ROADMAP.md) for planned features and development direction.

### Current Status (as of 2026-03-10)

- **Beads Issues**: No open issues ready for work (`bd ready --json` returns `[]`)
- **Test Status**: 872 pass, 7 skip, 0 fail

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)

## Security

Please report security vulnerabilities via [GitHub Security Advisories](https://github.com/buihongduc132/open-agent-sessions/security/advisories). See [SECURITY.md](SECURITY.md) for details.

## Links

- [Issue Tracker](https://github.com/buihongduc132/open-agent-sessions/issues)
- [Changelog](CHANGELOG.md)
