# open-agent-sessions

A unified session management library for AI coding agents. Access, search, and manage sessions across multiple AI agent platforms (OpenCode, Codex, Claude) through a single interface.

## Features

- **Multi-Agent Support**: Unified interface for OpenCode, Codex, and Claude sessions
- **Flexible Storage**: Support for SQLite databases and JSONL files
- **YAML Configuration**: Simple, declarative configuration for multiple agent instances
- **Session Operations**:
  - List sessions with filtering and sorting
  - Search sessions by content
  - View detailed session information with messages
  - Clone sessions between agents (planned)
- **Multiple Interfaces**:
  - Programmatic API for library usage
  - CLI commands for terminal workflows
  - TUI (Terminal UI) for interactive browsing
- **Type-Safe**: Written in TypeScript with full type definitions

## Installation

This project requires [Bun](https://bun.sh) runtime.

```bash
# Install Bun if you haven't already
curl -fsSL https://bun.sh/install | bash

# Clone the repository
git clone https://github.com/bhd/open-agent-sessions.git
cd open-agent-sessions

# Install dependencies
bun install

# Run tests
bun test
```

## Configuration

Create a YAML configuration file to define your agent instances:

```yaml
agents:
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

  - agent: codex
    alias: default
    enabled: true
    path: ~/.codex

  - agent: claude
    alias: desktop
    enabled: false
```

### Configuration Options

#### Storage Modes (OpenCode)

- `auto`: Automatically prefer DB if both DB and JSONL exist
- `db`: Use SQLite database storage
- `jsonl`: Use JSONL file storage

#### Agent Types

- `opencode`: OpenCode AI agent sessions
- `codex`: Codex agent sessions (planned)
- `claude`: Claude Desktop sessions (planned)

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

### CLI Usage (Planned)

```bash
# List all sessions
oas list

# List sessions for specific agent
oas list --agent opencode --alias main

# Search sessions
oas search "bug fix"

# View session detail
oas detail opencode:main:abc123

# Clone session to another agent
oas clone opencode:main:abc123 codex:default
```

### TUI Usage (Planned)

```bash
# Launch interactive terminal UI
oas tui
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
│   ├── opencode.ts # OpenCode adapter (implemented)
│   ├── codex.ts    # Codex adapter (stub)
│   └── claude.ts   # Claude adapter (stub)
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

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)

## Security

<!-- TODO: Replace security@example.com with actual security contact -->
Please report security vulnerabilities to security@example.com. See [SECURITY.md](SECURITY.md) for details.

## Links

- [Issue Tracker](https://github.com/bhd/open-agent-sessions/issues)
- [Changelog](CHANGELOG.md)
