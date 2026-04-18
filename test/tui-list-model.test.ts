import { describe, expect, test } from "bun:test";
import { DEFAULT_LIST_LIMIT, applyKey, createListState, type TuiListState, type KeyInput } from "../src/tui/list-model";
import { AgentEntry } from "../src/config/types";
import { AgentKind } from "../src/config/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeAgentEntry(agent: "opencode", alias: string, enabled?: boolean): import("../src/config/types").OpenCodeAgentEntry;
function makeAgentEntry(agent: "codex" | "claude", alias: string, enabled?: boolean): import("../src/config/types").OtherAgentEntry;
function makeAgentEntry(agent: AgentKind, alias: string, enabled = true): import("../src/config/types").AgentEntry {
  return { agent, alias, enabled } as import("../src/config/types").AgentEntry;
}

function makeState(overrides: Partial<TuiListState> = {}): TuiListState {
  const agents: AgentEntry[] = [
    makeAgentEntry("opencode", "default"),
    makeAgentEntry("codex", "default"),
    makeAgentEntry("claude", "default"),
  ];
  const base = createListState(agents);
  return {
    ...base,
    loading: false,
    allSessions: [
      { id: "s1", agent: "opencode", alias: "default", title: "Session 1", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", message_count: 1, storage: "db" as const },
      { id: "s2", agent: "codex",    alias: "default", title: "Session 2", created_at: "2024-01-02T00:00:00Z", updated_at: "2024-01-02T00:00:00Z", message_count: 2, storage: "db" as const },
      { id: "s3", agent: "claude",   alias: "default", title: "Session 3", created_at: "2024-01-03T00:00:00Z", updated_at: "2024-01-03T00:00:00Z", message_count: 3, storage: "db" as const },
    ],
    filteredSessions: [
      { id: "s1", agent: "opencode", alias: "default", title: "Session 1", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", message_count: 1, storage: "db" as const },
      { id: "s2", agent: "codex",    alias: "default", title: "Session 2", created_at: "2024-01-02T00:00:00Z", updated_at: "2024-01-02T00:00:00Z", message_count: 2, storage: "db" as const },
      { id: "s3", agent: "claude",   alias: "default", title: "Session 3", created_at: "2024-01-03T00:00:00Z", updated_at: "2024-01-03T00:00:00Z", message_count: 3, storage: "db" as const },
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

// ── j/k: move selection down/up ────────────────────────────────────────────────

describe("j/k navigation", () => {
  test("j moves selection down", () => {
    const state = makeState({ selectionIndex: 0 });
    const { state: next } = applyKey(state, key("j"));
    expect(next.selectionIndex).toBe(1);
  });

  test("k moves selection up", () => {
    const state = makeState({ selectionIndex: 1 });
    const { state: next } = applyKey(state, key("k"));
    expect(next.selectionIndex).toBe(0);
  });

  test("j at bottom stays at bottom", () => {
    const state = makeState({ selectionIndex: 2 });
    const { state: next } = applyKey(state, key("j"));
    expect(next.selectionIndex).toBe(2);
  });

  test("k at top stays at top", () => {
    const state = makeState({ selectionIndex: 0 });
    const { state: next } = applyKey(state, key("k"));
    expect(next.selectionIndex).toBe(0);
  });
});

// ── g/G: jump to top/bottom ─────────────────────────────────────────────────────

describe("g/G jump", () => {
  test("g jumps to top (index 0)", () => {
    const state = makeState({ selectionIndex: 2 });
    const { state: next } = applyKey(state, key("g"));
    expect(next.selectionIndex).toBe(0);
  });

  test("G jumps to bottom (last index)", () => {
    const state = makeState({ selectionIndex: 0 });
    const { state: next } = applyKey(state, key("G"));
    expect(next.selectionIndex).toBe(2);
  });
});

// ── h/H: agent filter drill-in / back-out ─────────────────────────────────────

describe("h (agent drill-in)", () => {
  test("h advances agent filter from 'all' to first agent option", () => {
    const state = makeState({ filter: { query: "", agent: "all", alias: "all" } });
    const { state: next } = applyKey(state, key("h"));
    // agents are sorted by AGENT_ORDER: claude=2, codex=1, opencode=0
    // but agentOptions from entries is built from a Set then sorted with compareAgents
    // entries: opencode, codex, claude → set: [opencode, codex, claude]
    // compareAgents: AGENT_ORDER[opencode]=0, AGENT_ORDER[codex]=1, AGENT_ORDER[claude]=2
    // sorted: [opencode, codex, claude]
    expect(next.filter.agent).toBe("opencode");
  });

  test("h cycles through agent options", () => {
    const state = makeState({ filter: { query: "", agent: "opencode", alias: "all" } });
    const { state: next } = applyKey(state, key("h"));
    expect(next.filter.agent).toBe("codex");
  });

  test("h from last agent cycles back to 'all'", () => {
    const state = makeState({ filter: { query: "", agent: "claude", alias: "all" } });
    const { state: next } = applyKey(state, key("h"));
    expect(next.filter.agent).toBe("all");
  });

  test("h saves current filter to navHistory before changing", () => {
    const state = makeState({ filter: { query: "", agent: "all", alias: "all" }, navHistory: [] });
    const { state: next } = applyKey(state, key("h"));
    expect(next.navHistory).toContainEqual({ agent: "all", alias: "all" });
  });

  test("h pushes to navHistory when cycling (additive)", () => {
    const state = makeState({
      filter: { query: "", agent: "opencode", alias: "all" },
      navHistory: [{ agent: "all" as const, alias: "all" as const }],
    });
    const { state: next } = applyKey(state, key("h"));
    expect(next.navHistory).toHaveLength(2);
  });
});

describe("H (agent back-out via navHistory)", () => {
  test("H pops navHistory and restores previous agent filter", () => {
    const history = [
      { agent: "all" as const, alias: "all" as const },
      { agent: "opencode" as const, alias: "all" as const },
    ];
    const state = makeState({
      filter: { query: "", agent: "codex", alias: "all" },
      navHistory: history,
    });
    const { state: next } = applyKey(state, key("H"));
    // Should have popped the top entry (codex→opencode) and restored to opencode
    expect(next.navHistory).toHaveLength(1);
    expect(next.filter.agent).toBe("opencode");
  });

  test("H with empty navHistory resets agent to 'all'", () => {
    const state = makeState({
      filter: { query: "", agent: "claude", alias: "all" },
      navHistory: [],
    });
    const { state: next } = applyKey(state, key("H"));
    expect(next.filter.agent).toBe("all");
  });

  test("H with single-entry navHistory clears history", () => {
    const state = makeState({
      filter: { query: "", agent: "opencode", alias: "all" },
      navHistory: [{ agent: "all" as const, alias: "all" as const }],
    });
    const { state: next } = applyKey(state, key("H"));
    expect(next.navHistory).toHaveLength(0);
    expect(next.filter.agent).toBe("all");
  });
});

// ── a (alias drill-in) ─────────────────────────────────────────────────────────

describe("a (alias drill-in)", () => {
  test("a advances alias filter from 'all' to first alias option", () => {
    const state = makeState({
      filter: { query: "", agent: "all", alias: "all" },
      aliasOptions: ["default", "work", "play"],
    });
    const { state: next } = applyKey(state, key("a"));
    expect(next.filter.alias).toBe("default");
  });

  test("a cycles through alias options", () => {
    const state = makeState({
      filter: { query: "", agent: "all", alias: "default" },
      aliasOptions: ["default", "work", "play"],
    });
    const { state: next } = applyKey(state, key("a"));
    expect(next.filter.alias).toBe("work");
  });

  test("a from last alias cycles back to 'all'", () => {
    const state = makeState({
      filter: { query: "", agent: "all", alias: "play" },
      aliasOptions: ["default", "work", "play"],
    });
    const { state: next } = applyKey(state, key("a"));
    expect(next.filter.alias).toBe("all");
  });

  test("a saves current filter to navHistory before changing", () => {
    const state = makeState({
      filter: { query: "", agent: "all", alias: "all" },
      navHistory: [],
      aliasOptions: ["default", "work"],
    });
    const { state: next } = applyKey(state, key("a"));
    expect(next.navHistory).toContainEqual({ agent: "all", alias: "all" });
  });
});

// ── L: alias back-out via navHistory ─────────────────────────────────────────

describe("L (alias back-out via navHistory)", () => {
  test("L pops navHistory and restores previous alias", () => {
    const state = makeState({
      filter: { query: "", agent: "all", alias: "play" },
      navHistory: [
        { agent: "all" as const, alias: "all" as const },
        { agent: "all" as const, alias: "default" as const },
      ],
    });
    const { state: next } = applyKey(state, key("L"));
    expect(next.filter.alias).toBe("default");
    expect(next.navHistory).toHaveLength(1);
  });

  test("L with empty navHistory resets alias to 'all'", () => {
    const state = makeState({
      filter: { query: "", agent: "all", alias: "work" },
      navHistory: [],
    });
    const { state: next } = applyKey(state, key("L"));
    expect(next.filter.alias).toBe("all");
  });

  test("L with single-entry navHistory clears history", () => {
    const state = makeState({
      filter: { query: "", agent: "all", alias: "work" },
      navHistory: [{ agent: "all" as const, alias: "all" as const }],
    });
    const { state: next } = applyKey(state, key("L"));
    expect(next.navHistory).toHaveLength(0);
    expect(next.filter.alias).toBe("all");
  });
});

// ── Enter: drill into session detail ──────────────────────────────────────────

describe("Enter in list view opens detail", () => {
  test("Enter emits open-detail effect", () => {
    const state = makeState({ selectionIndex: 0 });
    const { effects } = applyKey(state, key("return"));
    expect(effects).toContainEqual(expect.objectContaining({ type: "open-detail" }));
  });
});

// ── Esc in filter mode exits filter ─────────────────────────────────────────

describe("Esc in filter mode", () => {
  test("Esc exits filter mode and restores previous query", () => {
    const state = makeState({
      mode: "filter",
      filterInput: "foobar",
      filter: { query: "foobar", agent: "all", alias: "all" },
      previousQuery: "",
    });
    const { state: next } = applyKey(state, key("escape"));
    expect(next.mode).toBe("list");
    expect(next.filter.query).toBe("");
  });
});

// ── / enters filter mode ─────────────────────────────────────────────────────

describe("/ enters filter mode", () => {
  test("/ switches mode to filter and saves previous query", () => {
    const state = makeState({ filter: { query: "abc", agent: "all", alias: "all" } });
    const { state: next } = applyKey(state, key("/"));
    expect(next.mode).toBe("filter");
    expect(next.previousQuery).toBe("abc");
    expect(next.filterInput).toBe("abc");
  });
});

// ── t jumps to timeline ──────────────────────────────────────────────────────

describe("t opens detail for selected session", () => {
  test("t emits open-detail for the selected session", () => {
    const state = makeState({ mode: "list" });
    const { effects } = applyKey(state, key("t"));
    expect(effects).toContainEqual(expect.objectContaining({ type: "open-detail" }));
  });
});

// ── Tab cycles views ─────────────────────────────────────────────────────────

describe("Tab cycles views", () => {
  test("Tab from list goes to tree", () => {
    const state = makeState({ mode: "list" });
    const { effects } = applyKey(state, key("tab"));
    expect(effects).toContainEqual({ type: "switch-view", view: "tree" });
  });

  test("Tab from tree goes to timeline", () => {
    const state = makeState({ mode: "tree" });
    const { effects } = applyKey(state, key("tab"));
    expect(effects).toContainEqual({ type: "switch-view", view: "timeline" });
  });

  test("Tab from timeline goes to list", () => {
    const state = makeState({ mode: "timeline" });
    const { effects } = applyKey(state, key("tab"));
    expect(effects).toContainEqual({ type: "switch-view", view: "list" });
  });
});

// ── ? toggles help overlay ───────────────────────────────────────────────────

describe("? toggles help", () => {
  test("? switches mode to help", () => {
    const state = makeState({ mode: "list" });
    const { state: next } = applyKey(state, key("?"));
    expect(next.mode).toBe("help");
  });

  test("? in help mode closes help", () => {
    const state = makeState({ mode: "help" });
    const { state: next } = applyKey(state, key("?"));
    expect(next.mode).toBe("list");
  });
});

// ── q quits ──────────────────────────────────────────────────────────────────

describe("q quits", () => {
  test("q emits exit quit effect", () => {
    const state = makeState();
    const { effects } = applyKey(state, key("q"));
    expect(effects).toContainEqual({ type: "exit", reason: "quit" });
  });
});

// ── navHistory full cycle ─────────────────────────────────────────────────────

describe("navHistory full cycle", () => {
  test("pressing h 3 times then H once leaves 2 history entries", () => {
    let state = makeState({
      filter: { query: "", agent: "all", alias: "all" },
      navHistory: [],
    });

    state = applyKey(state, key("h")).state; // all → opencode  (push: all)
    state = applyKey(state, key("h")).state; // opencode → codex  (push: opencode)
    state = applyKey(state, key("h")).state; // codex → claude    (push: codex)

    expect(state.navHistory).toHaveLength(3);
    expect(state.filter.agent).toBe("claude");

    const { state: afterH } = applyKey(state, key("H"));
    expect(afterH.navHistory).toHaveLength(2);
  });

  test("H restores the correct previous agent filter", () => {
    let state = makeState({
      filter: { query: "", agent: "all", alias: "all" },
      navHistory: [],
    });

    state = applyKey(state, key("h")).state; // all → opencode  (push all)
    state = applyKey(state, key("h")).state; // opencode → codex (push opencode)

    const { state: afterH } = applyKey(state, key("H"));
    // should restore to "opencode" (the entry before current "codex")
    expect(afterH.filter.agent).toBe("opencode");
    expect(afterH.navHistory).toHaveLength(1);
  });
});

// ── navHistory field must exist on state ─────────────────────────────────────

describe("navHistory field", () => {
  test("createListState initialises navHistory as empty array", () => {
    const agents: AgentEntry[] = [makeAgentEntry("opencode", "default")];
    const state = createListState(agents);
    expect(Array.isArray(state.navHistory)).toBe(true);
    expect(state.navHistory).toHaveLength(0);
  });

  test("navHistory is present on state after key handling", () => {
    const state = makeState({ navHistory: [] });
    const { state: next } = applyKey(state, key("h"));
    expect("navHistory" in next).toBe(true);
  });
});

// F3: DEFAULT_LIST_LIMIT constant
describe("DEFAULT_LIST_LIMIT", () => {
  test("is exported and equals 50", () => {
    expect(DEFAULT_LIST_LIMIT).toBe(50);
  });

  test("createListState initial state does not embed a default limit", () => {
    // createListState produces initial state — the limit is applied by the caller
    // (App.tsx) when it calls timedList({ limit: DEFAULT_LIST_LIMIT }).
    // The state itself stores sessions, not the limit.
    const agents: AgentEntry[] = [makeAgentEntry("opencode", "default")];
    const state = createListState(agents);
    expect(state.loading).toBe(true);
    expect(state.allSessions).toHaveLength(0);
  });
});
