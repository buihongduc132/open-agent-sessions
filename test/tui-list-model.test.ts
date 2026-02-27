import { describe, expect, test } from "bun:test";
import {
  applyKey,
  applyListData,
  createListState,
  formatFooter,
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
});
