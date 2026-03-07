import { describe, expect, test } from "bun:test";
import {
  applyKey,
  applyListData,
  createListState,
  formatFooter,
  formatSessionLabel,
  getEmptyState,
  type TuiListState,
} from "../src/tui/list-model";
import { type AgentEntry } from "../src/config/types";
import { type SessionSummary } from "../src/core/types";

const entries: AgentEntry[] = [
  { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
  { agent: "codex", alias: "work", enabled: true },
  { agent: "claude", alias: "lab", enabled: true },
];

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s1",
    agent: "codex",
    alias: "work",
    title: "Session",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 1,
    storage: "other",
    ...overrides,
  };
}

function withSessions(state: TuiListState, sessions: SessionSummary[]): TuiListState {
  return applyListData(state, { sessions, errors: [] });
}

describe("tui list model", () => {
  test("help overlay is modal and does not move selection", () => {
    let state = withSessions(createListState(entries), [
      makeSession({ id: "a" }),
      makeSession({ id: "b" }),
    ]);

    let result = applyKey(state, { name: "?" });
    state = result.state;
    expect(state.mode).toBe("help");

    result = applyKey(state, { name: "j" });
    state = result.state;
    expect(state.selectionIndex).toBe(0);
  });

  test("filter input Enter applies and Esc restores previous query", () => {
    let state = withSessions(createListState(entries), [makeSession({ id: "a" })]);
    let result = applyKey(state, { name: "/" });
    state = result.state;
    expect(state.mode).toBe("filter");

    result = applyKey(state, { name: "x", sequence: "x" });
    state = result.state;
    expect(state.filter.query).toBe("x");

    result = applyKey(state, { name: "escape" });
    state = result.state;
    expect(state.mode).toBe("list");
    expect(state.filter.query).toBe("");

    result = applyKey(state, { name: "/" });
    state = result.state;
    result = applyKey(state, { name: "a", sequence: "a" });
    state = result.state;
    result = applyKey(state, { name: "return" });
    state = result.state;
    expect(state.filter.query).toBe("a");
    expect(state.mode).toBe("list");
  });

  test("toggle cycles agent order and clears with 0", () => {
    let state = withSessions(createListState(entries), [makeSession({ id: "a" })]);
    let result = applyKey(state, { name: "a" });
    state = result.state;
    expect(state.filter.agent).toBe("opencode");

    result = applyKey(state, { name: "a" });
    state = result.state;
    expect(state.filter.agent).toBe("codex");

    result = applyKey(state, { name: "a" });
    state = result.state;
    expect(state.filter.agent).toBe("claude");

    result = applyKey(state, { name: "0" });
    state = result.state;
    expect(state.filter.agent).toBe("all");
    expect(state.filter.alias).toBe("all");
  });

  test("enter on empty list shows hint", () => {
    let state = createListState(entries);
    const result = applyKey(state, { name: "return" });
    state = result.state;
    expect(state.statusMessage).toBe("No session selected.");
  });

  test("footer joins errors with context", () => {
    const state = applyListData(createListState(entries), {
      sessions: [],
      errors: [
        { agent: "codex", alias: "work", message: "adapter failed" },
        { agent: "claude", alias: "lab", message: "missing path" },
      ],
    });
    const footer = formatFooter(state);
    expect(footer).toContain("[codex:work]");
    expect(footer).toContain("adapter failed");
    expect(footer).toContain(" | ");
  });

  test("session row label formats [agent:alias]", () => {
    const session = makeSession({ id: "s1", agent: "codex", alias: "work" });
    const label = formatSessionLabel(session);
    expect(label).toBe("[codex:work]");
  });

  test("session row label uses different agent and alias", () => {
    const session = makeSession({ id: "s2", agent: "claude", alias: "lab" });
    const label = formatSessionLabel(session);
    expect(label).toBe("[claude:lab]");
  });

  test("no-match empty state is distinct from no-sessions", () => {
    const base = withSessions(createListState(entries), [
      makeSession({ id: "cx-1", title: "Alpha" }),
    ]);
    const filtered = applyKey(base, { name: "/", sequence: "/" }).state;
    const afterInput = applyKey(filtered, { name: "z", sequence: "z" }).state;
    const empty = getEmptyState(afterInput);
    expect(empty.kind).toBe("nomatch");
  });

  test("enter on no-match empty list has no effect", () => {
    let state = withSessions(createListState(entries), [
      makeSession({ id: "cx-1", title: "Alpha" }),
    ]);
    state = applyKey(state, { name: "/", sequence: "/" }).state;
    state = applyKey(state, { name: "z", sequence: "z" }).state;
    state = applyKey(state, { name: "return" }).state;
    const result = applyKey(state, { name: "return" });
    expect(result.state.statusMessage).toBeUndefined();
  });

  describe("clone mode", () => {
    test("c on codex session opens clone prompt", () => {
      let state = withSessions(createListState(entries), [
        makeSession({ id: "cx-1", agent: "codex", alias: "work" }),
      ]);
      const result = applyKey(state, { name: "c" });
      state = result.state;
      expect(state.mode).toBe("clone");
      expect(state.clonePrompt).toBeDefined();
      expect(state.clonePrompt?.sourceSession.id).toBe("cx-1");
      expect(state.clonePrompt?.destinations).toContain("personal");
      expect(state.clonePrompt?.selectedIndex).toBe(0);
    });

    test("c on non-codex session shows not supported message", () => {
      let state = withSessions(createListState(entries), [
        makeSession({ id: "s1", agent: "claude", alias: "lab" }),
      ]);
      const result = applyKey(state, { name: "c" });
      state = result.state;
      expect(state.mode).toBe("list");
      expect(state.statusMessage).toBe("Clone not supported for this session type.");
    });

    test("c on empty list has no effect", () => {
      const state = createListState(entries);
      const result = applyKey(state, { name: "c" });
      expect(result.state.mode).toBe("list");
      expect(result.state.clonePrompt).toBeUndefined();
    });

    test("clone prompt j/k navigates destinations", () => {
      const multiEntries: AgentEntry[] = [
        { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
        { agent: "opencode", alias: "work", enabled: true, storage: { mode: "auto" } },
        { agent: "codex", alias: "dev", enabled: true },
      ];
      let state = withSessions(createListState(multiEntries), [
        makeSession({ id: "cx-1", agent: "codex", alias: "dev" }),
      ]);
      state = applyKey(state, { name: "c" }).state;
      expect(state.clonePrompt?.destinations.length).toBe(2);
      expect(state.clonePrompt?.selectedIndex).toBe(0);

      state = applyKey(state, { name: "j" }).state;
      expect(state.clonePrompt?.selectedIndex).toBe(1);

      state = applyKey(state, { name: "j" }).state;
      expect(state.clonePrompt?.selectedIndex).toBe(1); // clamped

      state = applyKey(state, { name: "k" }).state;
      expect(state.clonePrompt?.selectedIndex).toBe(0);

      state = applyKey(state, { name: "k" }).state;
      expect(state.clonePrompt?.selectedIndex).toBe(0); // clamped
    });

    test("clone prompt Enter emits clone effect", () => {
      let state = withSessions(createListState(entries), [
        makeSession({ id: "cx-1", agent: "codex", alias: "work" }),
      ]);
      state = applyKey(state, { name: "c" }).state;
      const result = applyKey(state, { name: "return" });
      expect(result.effects).toHaveLength(1);
      expect(result.effects[0]).toEqual({
        type: "clone",
        source: { id: "cx-1", agent: "codex", alias: "work", title: "Session", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-02T00:00:00Z", message_count: 1, storage: "other" },
        destination: "personal",
      });
      expect(result.state.clonePrompt).toBeUndefined();
    });

    test("clone prompt Esc cancels and returns to list", () => {
      let state = withSessions(createListState(entries), [
        makeSession({ id: "cx-1", agent: "codex", alias: "work" }),
      ]);
      state = applyKey(state, { name: "c" }).state;
      expect(state.mode).toBe("clone");

      const result = applyKey(state, { name: "escape" });
      expect(result.state.mode).toBe("list");
      expect(result.state.clonePrompt).toBeUndefined();
      expect(result.state.statusMessage).toBeUndefined();
    });

    test("clone prompt shows only opencode destinations", () => {
      const mixedEntries: AgentEntry[] = [
        { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
        { agent: "codex", alias: "work", enabled: true },
        { agent: "claude", alias: "lab", enabled: true },
      ];
      let state = withSessions(createListState(mixedEntries), [
        makeSession({ id: "cx-1", agent: "codex", alias: "work" }),
      ]);
      state = applyKey(state, { name: "c" }).state;
      expect(state.clonePrompt?.destinations).toEqual(["personal"]);
    });

    test("c with no opencode destinations shows message", () => {
      const noOpenCode: AgentEntry[] = [
        { agent: "codex", alias: "work", enabled: true },
        { agent: "claude", alias: "lab", enabled: true },
      ];
      let state = withSessions(createListState(noOpenCode), [
        makeSession({ id: "cx-1", agent: "codex", alias: "work" }),
      ]);
      const result = applyKey(state, { name: "c" });
      expect(result.state.mode).toBe("list");
      expect(result.state.statusMessage).toBe("No opencode destinations available.");
    });
  });
});
