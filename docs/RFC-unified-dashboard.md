# RFC: Unified Session Dashboard — Thread Tree, Timeline & Sub-Agent View

**File:** `docs/RFC-unified-dashboard.md`
**Status:** Draft
**Created:** 2026-04-10

---

## Problem Statement

`open-agent-sessions` manages sessions across opencode, codex, claude, and acpx.
Currently, the TUI (`src/tui/`) provides:
- A **list view** (sessions grouped by agent/alias)
- A **detail view** (flat message log)

Missing:
1. **Fork tree view** — sessions form fork chains (`parentSessionId`); no visual tree
2. **Timeline view** — messages lack a chronological timeline with model/sub-agent markers
3. **Sub-agent inference** — `modelID` and tool-usage patterns can identify which sub-agents ran, but this is not surfaced
4. **Unified agent dashboard** — no cross-agent view showing all agents' sessions in a single pane

---

## What Already Exists

### Session Data Model
```
SessionDetail
  ├── id: string
  ├── agent: AgentKind  ("opencode" | "codex" | "claude" | "acpx")
  ├── alias: string
  ├── title: string
  ├── created_at / updated_at: string
  ├── parentSessionId?: string   ← fork chain link
  ├── clone?: SessionCloneMetadata
  └── messages?: SessionMessage[]
        ├── role: "user" | "assistant" | "system"
        ├── modelID?: string     ← LLM model (e.g. "claude-sonnet-4-20250514")
        ├── agent?: string       ← sub-agent label (e.g. "o3", "claude-3-5-sonnet")
        ├── created_at: string
        └── parts: SessionPart[]
              ├── { type: "text";     text: string }
              ├── { type: "tool";     tool: string; state: Record<string, unknown> }
              └── { type: "reasoning"; text: string }
```

### Existing Infrastructure
- `forkSession()` in `src/sdk/session.ts` — resolves fork chain via `parentSessionId`
- `listSessions()` per adapter — returns `SessionSummary[]` with `updated_at`
- `getSessionDetail()` — full message log per session
- `toolSearchSessions()` — search messages by tool name (opencode DB + JSONL)
- TUI `list-model.ts` — filter/group state machine
- TUI `detail-model.ts` — detail rendering

---

## Design

### 1. Fork Tree View

**Purpose:** Visualise the session genealogy — which session forked from which.

**Data source:** Walk the `parentSessionId` chain via `getSessionDetail()` for each ancestor.

**Algorithm:**
```
function buildForkTree(rootSessionId: string): ForkTreeNode {
  // 1. Start at rootSessionId — query adapter by (agent, alias, id)
  // 2. Call getSessionDetail(id) → read parentSessionId
  // 3. Recurse upward until parentSessionId is null (root session)
  // 4. Render tree from newest → oldest (or oldest → newest, user toggle)
}

type ForkTreeNode = {
  sessionId: string;
  title: string;
  agent: AgentKind;
  forkedAt?: string;       // from ForkResult.forkedAt
  parentSessionId?: string;
  children: ForkTreeNode[]; // sessions that forked FROM this one
  isLeaf: boolean;
};
```

**Rendering in TUI (ASCII tree):**
```
Session: "Add user auth" — opencode:main
│
├── Session: "Fix auth bug" — opencode:main  [2026-04-10 14:22]
│   ├── Session: "Fix CORS" — opencode:main  [2026-04-10 15:01]
│   │   └── Session: "Write tests" — opencode:main  [2026-04-10 16:30]
│   └── Session: "Update deps" — codex:prod  [2026-04-10 15:45]
│
└── Session: "Refactor router" — opencode:main  [2026-04-10 13:10]
```

**Navigation:**
- `Enter` on a node → enter that session's detail view
- `Tab` → cycle: list → detail → tree → timeline
- `↑/↓` → navigate tree nodes
- `←/→` → collapse/expand subtrees
- `t` key → toggle tree view from detail view

---

### 2. Timeline View

**Purpose:** Chronological message timeline with model, sub-agent, and tool markers.

**Data source:** `SessionDetail.messages[]` sorted by `created_at`.

**Layout (one row per message):**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ● user                            2026-04-10 14:22:01                     │
│   "Write a login form with JWT auth"                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ ● assistant  claude-sonnet-4-20250514  [sub-agent: claude-3-5-sonnet]     │
│   "I'll create a React login form..."                                      │
│   📎 Tool: WebFetch   GET https://api.example.com/login                   │
│   📎 Tool: Edit        src/pages/login.tsx                                 │
│   📎 Tool: Bash        npm install jsonwebtoken                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ ● assistant  claude-sonnet-4-20250514  [sub-agent: o3-preview]             │
│   💭 Thinking: "Need to add CSRF token..."                                │
│   "Added CSRF protection..."                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Visual markers:**
| Icon | Meaning |
|------|---------|
| `●` | Message role indicator (user/assistant/system) |
| `📎` | Tool call |
| `💭` | Reasoning/thinking block |
| `[sub-agent: ...]` | Inferred sub-agent (see §3) |

**Navigation:**
- `↑/↓` → scroll through messages
- `l` → toggle line-wrapped vs. truncated view
- `m` → filter: show only messages with tools
- `r` → filter: show only reasoning
- `t` → back to tree view

---

### 3. Sub-Agent Inference

**Purpose:** Identify which sub-agents (LLMs, tools, skills) participated in a session.

**Inference rules:**

```
INFER sub-agents FROM SessionDetail.messages[]:

1. Model agents (from modelID):
   - Extract from SessionMessage.modelID per assistant message
   - Group identical modelIDs → list of LLMs used

2. Tool-pattern sub-agents:
   // Tool names → known agent capability mapping
   "WebFetch"     → infer sub-agent: "WebSearch" or "Researcher"
   "Bash"         → infer sub-agent: "Shell/CLI"
   "Read" / "Write" / "Edit" → infer sub-agent: "FileSystem"
   "git_*"        → infer sub-agent: "GitOperator"
   "SearchCode"   → infer sub-agent: "CodeSearch"
   "MCP_*"        → infer sub-agent: "MCP/Plugin: <tool-name>"
   "unknown_tool" → infer sub-agent: "CustomTool: <tool-name>"

3. Role-labeled agents:
   - If SessionMessage.agent is populated → use that as sub-agent label

4. Build SessionSubAgentSummary:
   type SessionSubAgentSummary = {
     models:        string[];           // unique modelIDs seen
     tools:         { name: string; callCount: number }[];
     mcpPlugins:    string[];         // tools with prefix "MCP_"
     customTools:   string[];          // uncategorised tool names
     reasoningUsed: boolean;           // any reasoning/thinking blocks?
   };
```

**Render in TUI detail header:**
```
┌─ Session: "Add user auth" ──────────────────────────────────┐
│ Agent: opencode:main    Created: 2026-04-10 14:00            │
│ Models: claude-sonnet-4-20250514, o3-preview                 │
│ Sub-agents: WebSearch, Shell/CLI, FileSystem, GitOperator      │
│ Tools: 12 calls across 8 types | Reasoning: yes               │
└──────────────────────────────────────────────────────────────┘
```

---

### 4. Unified Dashboard Layout

**Purpose:** Single-pane view across all agents with fork tree + timeline.

**TUI Views (cycle with Tab):**

```
View 0: Agent List  — sessions grouped by agent
View 1: Detail      — current session message log
View 2: Fork Tree   — session genealogy tree
View 3: Timeline   — chronological timeline with sub-agent markers
View 4: Search     — tool/MCP search across all sessions (R-41)
```

**Status bar (always visible):**
```
[opencode:main] [codex:prod] [claude:default] [acpx:cli]   ← active agents
● 14:22 | 12 msgs | 8 tools | claude-sonnet-4-20250514    ← current session
```

---

## Implementation Plan

### Phase 1 — Fork Tree (src/tui/tree-model.ts, src/tui/views/tree.tsx)
- [ ] `src/tui/tree-model.ts` — `ForkTreeBuilder` class:
  - `buildTree(rootSessionId, registry)` → `ForkTreeNode`
  - `buildForest(allSessions)` → `ForkTreeNode[]` (one root per session without parent)
  - `renderTree(node, depth)` → `string[]` (ASCII lines)
  - `collapseNode(node)` / `expandNode(node)` state
- [ ] `src/tui/views/tree.tsx` — React component rendering ASCII tree
- [ ] Key bindings: `↑↓` navigate, `←→` collapse/expand, `Enter` open detail
- [ ] Wire from `App.tsx` — add `"tree"` to TuiMode union

### Phase 2 — Timeline View (src/tui/timeline-model.ts, src/tui/views/timeline.tsx)
- [ ] `src/tui/timeline-model.ts`:
  - `inferSubAgents(messages: SessionMessage[])` → `SessionSubAgentSummary`
  - `buildTimeline(messages: SessionMessage[])` → `TimelineEntry[]`
  - `filterByRole(entries, role)` / `filterByTool(entries, toolName)`
- [ ] `src/tui/views/timeline.tsx` — React component:
  - Header with sub-agent summary
  - Chronological message rows with role icon, timestamp, model, tools, reasoning
- [ ] Key bindings: `↑↓` scroll, `m` tool filter, `r` reasoning filter, `t` back to tree

### Phase 3 — Sub-Agent Summary (src/core/subagents.ts)
- [ ] `src/core/subagents.ts`:
  - `inferSubAgents(detail: SessionDetail)` → `SessionSubAgentSummary`
  - Tool → agent inference map (configurable)
  - `formatSubAgentSummary(summary)` → display strings
- [ ] Export from `src/core/index.ts` and `src/sdk/index.ts`

### Phase 4 — Dashboard Shell (src/tui/App.tsx)
- [ ] Add `TuiMode = "list" | "detail" | "tree" | "timeline" | "help"`
- [ ] Status bar: agent pills + session meta
- [ ] Tab key cycles views
- [ ] Update `handleKey()` for new key bindings

### Phase 5 — Cross-Agent Fork Tree
- [ ] `buildForest(allSessions: SessionSummary[])` — group by parentSessionId
- [ ] Sessions without parent = tree roots
- [ ] Show fork chains that span agents (e.g., opencode → codex fork)

---

## Files to Create / Modify

| File | Action | Description |
|------|--------|-------------|
| `src/core/subagents.ts` | **Create** | Sub-agent inference engine |
| `src/tui/tree-model.ts` | **Create** | Fork tree builder + renderer |
| `src/tui/views/tree.tsx` | **Create** | Tree view component |
| `src/tui/timeline-model.ts` | **Create** | Timeline builder + filter |
| `src/tui/views/timeline.tsx` | **Create** | Timeline view component |
| `src/tui/App.tsx` | **Modify** | Add tree + timeline to view cycle; status bar |
| `src/tui/list-model.ts` | **Modify** | Add `TuiMode = "tree" \| "timeline"` |
| `src/core/index.ts` | **Modify** | Export `inferSubAgents` |
| `src/sdk/index.ts` | **Modify** | Re-export subagent types |
| `test/tui-tree.test.ts` | **Create** | Fork tree builder tests |
| `test/tui-timeline.test.ts` | **Create** | Sub-agent inference + timeline tests |
| `test/subagents.test.ts` | **Create** | Unit tests for tool→agent inference |

---

## Out of Scope (for this RFC)

- Real-time session updates (WebSocket / polling)
- Editing messages in the TUI
- Exporting the tree as a graph image
- Per-message diff view between fork branches
