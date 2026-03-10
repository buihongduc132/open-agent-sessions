# CLI Agent Feature Support Matrix

This document shows which features are usable **now in CLI** vs **library-only** vs **planned**.

## Key Distinction: CLI vs Library

| Status | Meaning |
|:------:|---------|
| ✅ **CLI Ready** | Works in `oas` CLI commands today |
| 📦 **Library Only** | Adapter exists in `src/adapters/` but NOT wired to CLI |
| 📋 **Planned** | On roadmap, not yet implemented |
| ❌ **Not Supported** | Technical limitation, not planned |

---

## CLI Reality Check

**The CLI wires only OpenCode adapters.** Evidence from `bin/oas`:

| CLI Command | Adapter Factory Wired | Evidence |
|-------------|----------------------|----------|
| `sessions` | `{ opencode: ... }` only | `bin/oas:185-187` |
| `list-new` | `{ opencode: ... }` only | `bin/oas:299-301` |
| `detail` | `createOpenCodeAdapter` only | `bin/oas:316` |
| `read` | `{ opencode: ... }` only | `bin/oas:235-237` |
| `search` | `createOpenCodeAdapter` only | `bin/oas:276` |
| `clone --from` | Codex only | `bin/oas:331-343` |
| `clone --to` | OpenCode only | `bin/oas:346-360` |

**Registry throws error if factory missing** (`src/core/registry.ts:59-61`):
```typescript
if (!factory) {
  throw new Error(`${context} adapter factory not found for agent "${entry.agent}"`);
}
```

**Result**: Config with `agent: codex` or `agent: claude` will **fail** on all CLI commands except clone.

---

## Feature Matrix: CLI Usable Now

| Feature | OpenCode | Codex | Claude |
|---------|:--------:|:-----:|:------:|
| **List Sessions** | ✅ CLI Ready | 📦 Library Only | 📦 Library Only |
| **Time Range Filter** | ✅ CLI Ready | ❌ N/A | ❌ N/A |
| **Search Sessions** | ✅ CLI Ready | ❌ N/A | ❌ N/A |
| **Session Detail** | ✅ CLI Ready | ❌ N/A | ❌ N/A |
| **Read Messages** | ✅ CLI Ready | ❌ N/A | ❌ N/A |
| **Clone Source** | ❌ N/A | ✅ CLI Ready | ❌ Not Supported |
| **Clone Destination** | ✅ CLI Ready | ❌ N/A | ❌ N/A |
| **TUI (Interactive)** | 📋 Planned | 📋 Planned | 📋 Planned |

---

## Command Support: CLI Reality

| Command | OpenCode | Codex | Claude | CLI Status |
|---------|:--------:|:-----:|:------:|------------|
| `oas list` | ✅ | ❌ | ❌ | OpenCode-only |
| `oas recent` | ✅ | ❌ | ❌ | OpenCode-only |
| `oas find` | ✅ | ❌ | ❌ | OpenCode-only |
| `oas show` | ✅ | ❌ | ❌ | OpenCode-only |
| `oas sessions` | ✅ | ❌ | ❌ | OpenCode-only |
| `oas list-new` | ✅ | ❌ | ❌ | **Wired OpenCode only** (despite name) |
| `oas detail` | ✅ | ❌ | ❌ | OpenCode-only |
| `oas read` | ✅ | ❌ | ❌ | OpenCode-only |
| `oas search` | ✅ | ❌ | ❌ | OpenCode-only |
| `oas clone --from` | ❌ | ✅ | ❌ | Codex source only |
| `oas clone --to` | ✅ | ❌ | ❌ | OpenCode dest only |
| `oas onboard` | ✅ | ✅ | ✅ | Agent-agnostic (runs `bd onboard`) |

---

## Library Adapters: What Exists

| Adapter | File | Methods | CLI Wired? |
|---------|------|---------|------------|
| OpenCode | `src/adapters/opencode.ts` | `listSessions`, `listSessionsByTimeRange`, `searchSessions`, `getSessionDetail` | ✅ Yes |
| Codex | `src/adapters/codex.ts` | `listSessions` only | ❌ No (except clone source) |
| Claude | `src/adapters/claude.ts` | `listSessions` only | ❌ No |

### Evidence

**OpenCode adapter** (`src/adapters/opencode.ts`):
- Lines 136-188: Full adapter with all methods
- Lines 153-155: `listSessionsByTimeRange` (DB mode)
- Lines 153, 183: `searchSessions` (DB and JSONL modes)
- Lines 154-155, 184-185: `getSessionDetail` (DB and JSONL modes)

**Codex adapter** (`src/adapters/codex.ts`):
- Lines 28-41: Only exports `listSessions`
- No `searchSessions`, no `getSessionDetail`

**Claude adapter** (`src/adapters/claude.ts`):
- Lines 30-43: Only exports `listSessions`
- No `searchSessions`, no `getSessionDetail`

---

## Why CLI is OpenCode-Only

### Evidence: CLI Service Creation

All CLI services wire only OpenCode:

```typescript
// bin/oas:184-187 - sessions command
function createSessionsService(config: Config): SessionsService {
  const registry = createAdapterRegistry(config, {
    opencode: (entry) => createOpenCodeAdapter(entry, { cwd: process.cwd() }),
    // No codex, no claude
  });
```

```typescript
// bin/oas:298-301 - list-new command
function createListServiceFromConfig(config: Config): ListService {
  const registry = createAdapterRegistry(config, {
    opencode: (entry) => createOpenCodeAdapter(entry, { cwd: process.cwd() }),
    // No codex, no claude
  });
```

```typescript
// bin/oas:269-296 - search command
function createSearchService(config: Config): SearchService {
  // ...
  const adapter = createOpenCodeAdapter(entry as any, ...);  // Only OpenCode
```

### Why Codex/Claude Not Wired

1. **Limited adapter capabilities**: Codex/Claude only have `listSessions`
2. **JSONL storage limitations**: No efficient search, no time-range queries
3. **Clone is special case**: Codex clone source uses separate adapter (`createCodexCloneSourceAdapter`)

---

## Roadmap: What's Planned

**Source**: [ROADMAP.md](../ROADMAP.md)

| Phase | Status | CLI-Relevant Features |
|-------|--------|----------------------|
| Phase 1 | ✅ Complete | OpenCode adapter, core CLI |
| Phase 2 | 🔄 In Progress | search, detail, read commands |
| Phase 3 | 📋 Planned | Codex/Claude detail, cross-agent search |
| Phase 4 | 📋 Planned | Session cloning, TUI, export/import |
| Phase 5 | 📋 Planned | Performance, caching |
| Phase 6 | 📋 Planned | VS Code extension, Web UI |

### Phase 3 Quote (ROADMAP.md L42-54):
```markdown
## Phase 3: Additional Adapters

**Goal**: Extend support to Codex and Claude agents

**Key Deliverables**:
- Codex adapter with session listing and detail retrieval
- Claude Desktop adapter with JSONL parsing
- Unified operations across all three agents
- Cross-agent search functionality
- Adapter compatibility matrix documentation
```

---

## Configuration Example

```yaml
agents:
  # OpenCode - CLI ready
  - agent: opencode
    alias: default
    enabled: true
    storage:
      mode: auto

  # Codex - library only (will cause CLI errors if enabled)
  # - agent: codex
  #   alias: work
  #   enabled: false  # Keep disabled for CLI use
  #   path: ~/.codex

  # Claude - library only (will cause CLI errors if enabled)
  # - agent: claude
  #   alias: desktop
  #   enabled: false  # Keep disabled for CLI use
  #   path: ~/.claude/transcripts
```

---

## Summary

| Aspect | Status |
|--------|--------|
| **CLI Today** | OpenCode-only (except clone: Codex→OpenCode) |
| **Library Today** | All three agents, but Codex/Claude list-only |
| **Planned** | Phase 3: Codex/Claude detail, cross-agent search |
| **TUI** | Phase 4: Code exists, not wired to CLI |
