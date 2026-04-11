import { describe, expect, test } from "bun:test";
import type { AgentEntry } from "../src/config/types";
import type { SessionListResult } from "../src/core/list";
import {
  createListState,
  applyListData,
  applyKey,
  setViewportHeight,
  getEmptyState,
  formatFooter,
  getSelectedSession,
  type TuiListState,
} from "../src/tui/list-model";
import type { SessionSummary } from "../src/core/types";

function makeAgentEntry(
  agent: "opencode" | "codex" | "claude",
  alias: string,
  enabled = true
): AgentEntry {
  return {
    agent,
    alias,
    enabled,
    storage: { mode: "auto" },
  };
}

function makeSession(
  id: string,
  title: string,
  agent: "opencode" = "opencode",
  alias = "default"
): SessionSummary {
  return {
    id,
    agent,
    alias,
    title,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    message_count: 5,
    storage: "db",
  };
}

function makeSessionListResult(sessions: SessionSummary[]): SessionListResult {
  return {
    sessions,
    errors: [],
  };
}

describe("tui list model", () => {
  describe("createListState", () => {
    test("creates initial state with empty sessions", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = createListState(entries);

      expect(state.mode).toBe("list");
      expect(state.allSessions).toEqual([]);
      expect(state.filteredSessions).toEqual([]);
      expect(state.selectionIndex).toBeNull();
      expect(state.viewportHeight).toBe(10);
      expect(state.filter.query).toBe("");
      expect(state.filter.agent).toBe("all");
      expect(state.filter.alias).toBe("all");
    });

    test("extracts agent and alias options from entries", () => {
      const entries: AgentEntry[] = [
        makeAgentEntry("opencode", "default"),
        makeAgentEntry("codex", "work"),
        makeAgentEntry("opencode", "personal"),
      ];
      const state = createListState(entries);

      expect(state.agentOptions).toContain("opencode");
      expect(state.agentOptions).toContain("codex");
      expect(state.aliasOptions).toContain("default");
      expect(state.aliasOptions).toContain("work");
      expect(state.aliasOptions).toContain("personal");
      expect(state.opencodeDestinations).toContain("default");
      expect(state.opencodeDestinations).toContain("personal");
    });
  });

  describe("applyListData", () => {
    test("applies session list result to state", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = createListState(entries);
      const sessions = [
        makeSession("abc-123", "First session"),
        makeSession("def-456", "Second session"),
      ];
      const result = makeSessionListResult(sessions);

      const next = applyListData(state, result);

      expect(next.allSessions).toHaveLength(2);
      expect(next.filteredSessions).toHaveLength(2);
      expect(next.errors).toEqual([]);
    });

    test("sorts sessions by updated_at descending", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = createListState(entries);
      const sessions = [
        { ...makeSession("a", "a"), updated_at: "2026-01-01T00:00:00Z" },
        { ...makeSession("b", "b"), updated_at: "2026-01-02T00:00:00Z" },
        { ...makeSession("c", "c"), updated_at: "2026-01-03T00:00:00Z" },
      ];
      const result = makeSessionListResult(sessions);

      const next = applyListData(state, result);

      expect(next.filteredSessions[0].id).toBe("c");
      expect(next.filteredSessions[1].id).toBe("b");
      expect(next.filteredSessions[2].id).toBe("a");
    });
  });

  describe("applyKey", () => {
    test("q key exits", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = createListState(entries);
      const key = { name: "q" };

      const result = applyKey(state, key);

      expect(result.effects).toHaveLength(1);
      expect(result.effects[0].type).toBe("exit");
      expect(result.effects[0].reason).toBe("quit");
    });

    test("ctrl+c exits", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = createListState(entries);
      const key = { name: "c", ctrl: true };

      const result = applyKey(state, key);

      expect(result.effects).toHaveLength(1);
      expect(result.effects[0].type).toBe("exit");
      expect(result.effects[0].reason).toBe("ctrl-c");
    });

    test("j key moves selection down", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = createListState(
        entries,
        makeSessionListResult([
          makeSession("a", "A"),
          makeSession("b", "B"),
        ])
      );
      const key = { name: "j" };

      // Need to apply the data first
      let currentState = applyListData(state, makeSessionListResult([
        makeSession("a", "A"),
        makeSession("b", "B"),
      ]));

      const result = applyKey(currentState, key);

      expect(result.state.selectionIndex).toBe(1);
    });

    test("k key moves selection up", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const result = makeSessionListResult([
        makeSession("a", "A"),
        makeSession("b", "B"),
      ]);
      let state = applyListData(createListState(entries), result);
      state = applyKey(state, { name: "j" }).state; // Move to index 1

      const key = { name: "k" };
      const result2 = applyKey(state, key);

      expect(result2.state.selectionIndex).toBe(0);
    });

    test("g key jumps to top", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      let state = applyListData(
        createListState(entries),
        makeSessionListResult([
          makeSession("a", "A"),
          makeSession("b", "B"),
        ])
      );
      state = applyKey(state, { name: "j" }).state; // Move to index 1

      const result = applyKey(state, { name: "g" });

      expect(result.state.selectionIndex).toBe(0);
    });

    test("G key jumps to bottom", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = applyListData(
        createListState(entries),
        makeSessionListResult([
          makeSession("a", "A"),
          makeSession("b", "B"),
        ])
      );

      const result = applyKey(state, { name: "G" });

      expect(result.state.selectionIndex).toBe(1);
    });

    test("enter key opens detail when session selected", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const session = makeSession("abc-123", "Test session");
      const state = applyListData(
        createListState(entries),
        makeSessionListResult([session])
      );

      const result = applyKey(state, { name: "return" });

      expect(result.effects).toHaveLength(1);
      expect(result.effects[0].type).toBe("open-detail");
      expect(result.effects[0].session.id).toBe("abc-123");
    });

    test("? key opens help", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = createListState(entries);

      const result = applyKey(state, { name: "?" });

      expect(result.state.mode).toBe("help");
    });

    test("/ key enters filter mode", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = createListState(entries);

      const result = applyKey(state, { name: "/" });

      expect(result.state.mode).toBe("filter");
    });

    test("escape exits help mode", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = { ...createListState(entries), mode: "help" as const };

      const result = applyKey(state, { name: "escape" });

      expect(result.state.mode).toBe("list");
    });
  });

  describe("setViewportHeight", () => {
    test("updates viewport height and recomputes scroll", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const sessions = Array.from({ length: 20 }, (_, i) =>
        makeSession(`id-${i}`, `Session ${i}`)
      );
      let state = applyListData(
        createListState(entries),
        makeSessionListResult(sessions)
      );
      state = { ...state, selectionIndex: 15, scrollOffset: 10 };

      const result = setViewportHeight(state, 5);

      expect(result.viewportHeight).toBe(5);
    });

    test("handles invalid height gracefully", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = createListState(entries);

      const result = setViewportHeight(state, -1);

      expect(result.viewportHeight).toBe(1);
    });

    test("handles zero height gracefully", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = createListState(entries);

      const result = setViewportHeight(state, 0);

      expect(result.viewportHeight).toBe(1);
    });
  });

  describe("getEmptyState", () => {
    test("returns empty when no sessions", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = createListState(entries);

      const result = getEmptyState(state);

      expect(result.kind).toBe("empty");
    });

    test("returns nomatch when filters match nothing", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = applyListData(
        createListState(entries),
        makeSessionListResult([makeSession("a", "A")])
      );
      // Manually set filteredSessions to empty to simulate no matches
      const filtered = { 
        ...state, 
        filter: { ...state.filter, query: "nonexistent" },
        filteredSessions: [] 
      };

      const result = getEmptyState(filtered);

      expect(result.kind).toBe("nomatch");
    });

    test("returns none when sessions exist", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = applyListData(
        createListState(entries),
        makeSessionListResult([makeSession("a", "A")])
      );

      const result = getEmptyState(state);

      expect(result.kind).toBe("none");
    });
  });

  describe("getSelectedSession", () => {
    test("returns null when no selection", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const state = createListState(entries);

      const result = getSelectedSession(state);

      expect(result).toBeNull();
    });

    test("returns selected session", () => {
      const entries: AgentEntry[] = [makeAgentEntry("opencode", "default")];
      const session = makeSession("abc", "Test");
      const state = applyListData(
        createListState(entries),
        makeSessionListResult([session])
      );

      const result = getSelectedSession(state);

      expect(result?.id).toBe("abc");
    });
  });

  describe("filter by agent", () => {
    test("a key cycles through agents", () => {
      const entries: AgentEntry[] = [
        makeAgentEntry("opencode", "default"),
        makeAgentEntry("codex", "work"),
      ];
      const state = applyListData(
        createListState(entries),
        makeSessionListResult([
          makeSession("a", "A", "opencode"),
          makeSession("b", "B", "codex"),
        ])
      );

      const result = applyKey(state, { name: "a" });

      expect(result.state.filter.agent).toBe("opencode");
    });
  });
});