import { describe, expect, test } from "bun:test";
import { applyDetailKey, createDetailState, type TuiDetailState, type KeyInput } from "../src/tui/detail-model";
import { SessionDetail } from "../src/core/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "test-session",
    agent: "opencode",
    alias: "default",
    title: "Test Session",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    message_count: 1,
    storage: "sqlite",
    ...overrides,
  };
}

function makeDetailState(overrides: Partial<TuiDetailState> = {}): TuiDetailState {
  const base = createDetailState(makeDetail({ message_count: 50 }));
  return { ...base, ...overrides };
}

function key(name: string, ctrl = false): KeyInput {
  return { name, ctrl };
}

// ── h: go back to list ────────────────────────────────────────────────────────

describe("h goes back to list", () => {
  test("h emits back effect", () => {
    const state = makeDetailState();
    const { effect } = applyDetailKey(state, key("h"));
    expect(effect).toEqual({ type: "back" });
  });

  test("h does not change scrollOffset (returns state unchanged)", () => {
    const state = makeDetailState({ scrollOffset: 10 });
    const { state: next } = applyDetailKey(state, key("h"));
    expect(next.scrollOffset).toBe(10);
  });

  test("h works in detail mode (not help mode)", () => {
    const state = makeDetailState({ mode: "detail" });
    const { effect } = applyDetailKey(state, key("h"));
    expect(effect).toEqual({ type: "back" });
  });
});

// ── Esc/q: also go back ──────────────────────────────────────────────────────

describe("Esc and q go back", () => {
  test("Esc emits back effect", () => {
    const state = makeDetailState();
    const { effect } = applyDetailKey(state, key("escape"));
    expect(effect).toEqual({ type: "back" });
  });

  test("q emits back effect", () => {
    const state = makeDetailState();
    const { effect } = applyDetailKey(state, key("q"));
    expect(effect).toEqual({ type: "back" });
  });
});

// ── l: reserved (no-op) ──────────────────────────────────────────────────────

describe("l is reserved (no-op)", () => {
  test("l does not emit any effect", () => {
    const state = makeDetailState();
    const { effect } = applyDetailKey(state, key("l"));
    expect(effect).toBeNull();
  });

  test("l does not change state", () => {
    const state = makeDetailState({ scrollOffset: 5 });
    const { state: next } = applyDetailKey(state, key("l"));
    expect(next.scrollOffset).toBe(5);
    expect(next.mode).toBe("detail");
  });
});

// ── j/k: scroll down/up ───────────────────────────────────────────────────────

describe("j/k scroll", () => {
  test("j increases scrollOffset by 1", () => {
    const state = makeDetailState({ scrollOffset: 0 });
    const { state: next } = applyDetailKey(state, key("j"));
    expect(next.scrollOffset).toBe(1);
  });

  test("k decreases scrollOffset by 1", () => {
    const state = makeDetailState({ scrollOffset: 5 });
    const { state: next } = applyDetailKey(state, key("k"));
    expect(next.scrollOffset).toBe(4);
  });

  test("j does not scroll past the bottom", () => {
    const state = makeDetailState({ scrollOffset: 0, viewportHeight: 5 });
    // maxScrollOffset = max(0, lines.length - viewportHeight)
    // lines includes: 9 header + 6 clone = 15 lines
    // maxScrollOffset = max(0, 15 - 5) = 10
    // Scroll to bottom first
    const bottomState = makeDetailState({ scrollOffset: 10, viewportHeight: 5 });
    const { state: next } = applyDetailKey(bottomState, key("j"));
    expect(next.scrollOffset).toBe(10); // clamped to max
  });

  test("k does not scroll above 0", () => {
    const state = makeDetailState({ scrollOffset: 0 });
    const { state: next } = applyDetailKey(state, key("k"));
    expect(next.scrollOffset).toBe(0);
  });

  test("down alias works like j", () => {
    const state = makeDetailState({ scrollOffset: 2 });
    const { state: next } = applyDetailKey(state, key("down"));
    expect(next.scrollOffset).toBe(3);
  });

  test("up alias works like k", () => {
    const state = makeDetailState({ scrollOffset: 2 });
    const { state: next } = applyDetailKey(state, key("up"));
    expect(next.scrollOffset).toBe(1);
  });
});

// ── g/G: jump to top/bottom ───────────────────────────────────────────────────

describe("g/G jump", () => {
  test("g sets scrollOffset to 0", () => {
    const state = makeDetailState({ scrollOffset: 10 });
    const { state: next } = applyDetailKey(state, key("g"));
    expect(next.scrollOffset).toBe(0);
  });

  test("G sets scrollOffset to max", () => {
    const state = makeDetailState({ scrollOffset: 0 });
    const { state: next } = applyDetailKey(state, key("G"));
    // maxScrollOffset = max(0, 15 lines - viewportHeight 10) = 5
    expect(next.scrollOffset).toBe(5);
  });

  test("g when already at top is a no-op", () => {
    const state = makeDetailState({ scrollOffset: 0 });
    const { state: next } = applyDetailKey(state, key("g"));
    expect(next.scrollOffset).toBe(0);
  });

  test("G when already at bottom is a no-op", () => {
    const state = makeDetailState({ scrollOffset: 5 });
    const { state: next } = applyDetailKey(state, key("G"));
    expect(next.scrollOffset).toBe(5);
  });
});

// ── ?: toggle help ───────────────────────────────────────────────────────────

describe("? toggles help", () => {
  test("? switches mode to help", () => {
    const state = makeDetailState({ mode: "detail" });
    const { state: next } = applyDetailKey(state, key("?"));
    expect(next.mode).toBe("help");
  });

  test("? in help mode closes help", () => {
    const state = makeDetailState({ mode: "help" });
    const { state: next } = applyDetailKey(state, key("?"));
    expect(next.mode).toBe("detail");
  });
});

// ── Ctrl+C: exit ─────────────────────────────────────────────────────────────

describe("Ctrl+C exits", () => {
  test("Ctrl+C emits exit effect", () => {
    const state = makeDetailState();
    const { effect } = applyDetailKey(state, key("c", true));
    expect(effect).toEqual({ type: "exit", reason: "ctrl-c" });
  });
});

// ── viewport height clamping ─────────────────────────────────────────────────

describe("scroll respects viewportHeight", () => {
  test("viewportHeight of 5 limits scroll", () => {
    const state = makeDetailState({ scrollOffset: 0, viewportHeight: 5 });
    const { state: next } = applyDetailKey(state, key("G"));
    // lines = 15, viewportHeight = 5 → maxOffset = 10
    expect(next.scrollOffset).toBe(10);
  });

  test("viewportHeight of 1 allows max offset of lines-1", () => {
    const state = makeDetailState({ scrollOffset: 0, viewportHeight: 1 });
    const { state: next } = applyDetailKey(state, key("G"));
    // lines = 15, viewportHeight = 1 → maxOffset = 14
    expect(next.scrollOffset).toBe(14);
  });
});

// ── createDetailState initialises correctly ──────────────────────────────────

describe("createDetailState", () => {
  test("sets scrollOffset to 0 initially", () => {
    const state = createDetailState(makeDetail());
    expect(state.scrollOffset).toBe(0);
  });

  test("sets mode to 'detail' initially", () => {
    const state = createDetailState(makeDetail());
    expect(state.mode).toBe("detail");
  });

  test("builds lines from detail", () => {
    const state = createDetailState(makeDetail());
    expect(state.lines.length).toBeGreaterThan(0);
    expect(state.lines[0]).toContain("opencode");
  });
});
