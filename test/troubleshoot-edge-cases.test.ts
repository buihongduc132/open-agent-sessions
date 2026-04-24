import { describe, expect, test } from "bun:test";
import { applyKey, createListState, type TuiListState, type KeyInput } from "../src/tui/list-model";
import { applyDetailKey, createDetailState } from "../src/tui/detail-model";
import { listSessions } from "../src/core/list";
import { AgentKind, AgentEntry } from "../src/config/types";
import { SessionSummary, SessionDetail, AdapterRegistry } from "../src/core/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeAgentEntry(agent: AgentKind, alias: string, enabled = true): AgentEntry {
  return { agent, alias, enabled } as AgentEntry;
}

function makeListState(overrides: Partial<TuiListState> = {}): TuiListState {
  const agents: AgentEntry[] = [
    makeAgentEntry("opencode", "default"),
    makeAgentEntry("gemini", "default"),
    makeAgentEntry("antigravity", "default"),
  ];
  const base = createListState(agents);
  return {
    ...base,
    loading: false,
    allSessions: [
      { id: "s1", agent: "opencode", alias: "default", title: "Session 1", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", message_count: 1, storage: "db" as const },
      { id: "s2", agent: "gemini",   alias: "default", title: "Session 2", created_at: "2024-01-02T00:00:00Z", updated_at: "2024-01-02T00:00:00Z", message_count: 2, storage: "jsonl" as const },
    ],
    filteredSessions: [
      { id: "s1", agent: "opencode", alias: "default", title: "Session 1", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", message_count: 1, storage: "db" as const },
      { id: "s2", agent: "gemini",   alias: "default", title: "Session 2", created_at: "2024-01-02T00:00:00Z", updated_at: "2024-01-02T00:00:00Z", message_count: 2, storage: "jsonl" as const },
    ],
    selectionIndex: 0,
    selectedKey: "opencode:default:s1",
    viewportHeight: 20,
    ...overrides,
  };
}

function key(name: string): KeyInput {
  return { name };
}

// ── Edge Case 1: 'q' in Filter Mode ──────────────────────────────────────────

describe("Edge Case: 'q' in Filter Mode", () => {
  test("q should NOT exit the app when in filter mode", () => {
    const state = makeListState({ mode: "filter", filterInput: "search" });
    const { effects } = applyKey(state, key("q"));
    
    // RED: Currently applyKey handles 'q' globally before checking mode
    const hasExit = effects.some(e => e.type === "exit");
    expect(hasExit).toBe(false);
  });
});

// ── Edge Case 2: 'h' in Detail View ──────────────────────────────────────────

describe("Edge Case: 'h' in Detail View", () => {
  test("h should go back to list view", () => {
    const detail: SessionDetail = {
      id: "s1", agent: "opencode", alias: "default", title: "Session 1",
      created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
      message_count: 1, storage: "db", messages: []
    };
    const state = createDetailState(detail);
    const { effect } = applyDetailKey(state, key("h"));
    
    expect(effect?.type).toBe("back");
  });
});

// ── Edge Case 3: Search by Agent in Core ─────────────────────────────────────

describe("Edge Case: Search by Agent in Core", () => {
  test("Core listSessions should match by agent name", async () => {
    const sessions: SessionSummary[] = [
      { id: "s1", agent: "gemini", alias: "default", title: "My Session", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", message_count: 1, storage: "jsonl" },
    ];
    const mockRegistry: AdapterRegistry = {
      adapters: [
        {
          agent: "gemini",
          alias: "default",
          version: "1.0.0",
          listSessions: async () => sessions,
        }
      ]
    };
    
    const result = await listSessions(mockRegistry, { q: "gemini" });
    
    // RED: Currently core applyFilters only checks id and title
    expect(result.sessions).toHaveLength(1);
  });
});

// ── Edge Case 4: Search by Alias in Core ─────────────────────────────────────

describe("Edge Case: Search by Alias in Core", () => {
  test("Core listSessions should match by alias name", async () => {
    const sessions: SessionSummary[] = [
      { id: "s1", agent: "opencode", alias: "work", title: "My Session", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", message_count: 1, storage: "db" },
    ];
    const mockRegistry: AdapterRegistry = {
      adapters: [
        {
          agent: "opencode",
          alias: "work",
          version: "1.0.0",
          listSessions: async () => sessions,
        }
      ]
    };
    
    const result = await listSessions(mockRegistry, { q: "work" });
    
    // RED: Currently core applyFilters only checks id and title
    expect(result.sessions).toHaveLength(1);
  });
});

