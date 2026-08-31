/**
 * RED — turn engine tests (oas-export-turn-split).
 * Contracts: flow/plans/oas-export-turn-split-design.md
 * RED state: src/core/turns.ts stubs throw "not implemented".
 */
import { describe, test, expect } from "bun:test";
import { groupTurns, resolveRange, sliceTurn } from "../src/core/turns";
import type { SessionDetail, SessionMessage, SessionPart } from "../src/core/types";

function mkMsg(
  id: string,
  role: "user" | "assistant" | "system",
  parts: SessionPart[],
  created_at: string,
  index?: number
): SessionMessage {
  const m: SessionMessage = { id, role, parts, created_at };
  if (index !== undefined) m.index = index;
  return m;
}

const T = (text: string): SessionPart => ({ type: "text", text });
const TR = (name: string): SessionPart => ({
  type: "tool_result",
  tool: name,
  state: {},
});
const TOOL = (name: string): SessionPart => ({
  type: "tool",
  tool: name,
  state: {},
});
const REASON = (text: string): SessionPart => ({ type: "reasoning", text });

function mkDetail(msgs: SessionMessage[], title = "sess"): SessionDetail {
  return {
    id: "s1",
    agent: "pi",
    alias: "pi",
    title,
    created_at: msgs[0]?.created_at ?? "2026-01-01T00:00:00Z",
    updated_at: msgs[msgs.length - 1]?.created_at ?? "2026-01-01T00:01:00Z",
    message_count: msgs.length,
    storage: "jsonl",
    messages: msgs,
  };
}

describe("groupTurns — turn definition", () => {
  test("prologue assistant/system messages merge into turn 0", () => {
    const msgs = [
      mkMsg("m0", "system", [T("sys")], "2026-01-01T00:00:00Z", 1),
      mkMsg("m1", "assistant", [T("pre")], "2026-01-01T00:00:01Z", 2),
      mkMsg("m2", "user", [T("q1")], "2026-01-01T00:00:02Z", 3),
      mkMsg("m3", "assistant", [T("a1")], "2026-01-01T00:00:03Z", 4),
    ];
    const turns = groupTurns(msgs);
    expect(turns.length).toBe(1);
    expect(turns[0].index).toBe(0);
    expect(turns[0].messages.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3"]);
  });

  test("consecutive user text messages start separate turns", () => {
    const msgs = [
      mkMsg("m0", "user", [T("q1")], "2026-01-01T00:00:00Z", 1),
      mkMsg("m1", "assistant", [T("a1")], "2026-01-01T00:00:01Z", 2),
      mkMsg("m2", "user", [T("q2")], "2026-01-01T00:00:02Z", 3),
      mkMsg("m3", "user", [T("q3")], "2026-01-01T00:00:03Z", 4),
    ];
    const turns = groupTurns(msgs);
    expect(turns.length).toBe(3);
    expect(turns[1].messages.map((m) => m.id)).toEqual(["m2"]);
    expect(turns[2].messages.map((m) => m.id)).toEqual(["m3"]);
  });

  test("user message with ONLY tool_result parts is NOT a turn start", () => {
    const msgs = [
      mkMsg("m0", "user", [T("q1")], "2026-01-01T00:00:00Z", 1),
      mkMsg("m1", "assistant", [TOOL("bash")], "2026-01-01T00:00:01Z", 2),
      mkMsg("m2", "user", [TR("bash")], "2026-01-01T00:00:02Z", 3),
      mkMsg("m3", "assistant", [T("a1")], "2026-01-01T00:00:03Z", 4),
    ];
    const turns = groupTurns(msgs);
    expect(turns.length).toBe(1);
    expect(turns[0].messages.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3"]);
  });

  test("user message with text + tool_result IS a turn start", () => {
    const msgs = [
      mkMsg("m0", "user", [T("q1")], "2026-01-01T00:00:00Z", 1),
      mkMsg("m1", "assistant", [T("a1")], "2026-01-01T00:00:01Z", 2),
      mkMsg("m2", "user", [T("q2"), TR("bash")], "2026-01-01T00:00:02Z", 3),
    ];
    const turns = groupTurns(msgs);
    expect(turns.length).toBe(2);
    expect(turns[1].messages[0].id).toBe("m2");
  });

  test("empty message list → zero turns; assistant-only → single turn", () => {
    expect(groupTurns([]).length).toBe(0);
    expect(groupTurns([mkMsg("m0", "assistant", [T("x")], "2026-01-01T00:00:00Z")]).length).toBe(1);
  });
});

describe("groupTurns — sorting", () => {
  test("pre-sorts by index when present (stable), else by created_at", () => {
    const shuffled = [
      mkMsg("c", "user", [T("q2")], "2026-01-01T00:00:05Z", 3),
      mkMsg("b", "assistant", [T("a1")], "2026-01-01T00:00:04Z", 2),
      mkMsg("a", "user", [T("q1")], "2026-01-01T00:00:06Z", 1),
    ];
    const turns = groupTurns(shuffled);
    // index order: a(1,user) → b(2,assistant) → c(3,user)
    expect(turns.length).toBe(2);
    expect(turns[0].messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(turns[1].messages.map((m) => m.id)).toEqual(["c"]);

    const noIndex = [
      mkMsg("z", "user", [T("late")], "2026-01-01T00:00:09Z"),
      mkMsg("y", "user", [T("early")], "2026-01-01T00:00:01Z"),
    ];
    const turns2 = groupTurns(noIndex);
    expect(turns2[0].messages[0].id).toBe("y");
    expect(turns2.length).toBe(2);
  });
});

describe("resolveRange — pandas model (T=5, indices 0..4)", () => {
  const T5 = 5;
  test("relative 0 = current (abs 4); -1 = prev (abs 3); -4 = first (abs 0)", () => {
    expect(resolveRange({ fromRelative: "0" }, T5)).toEqual({ ok: true, value: { from: 4, to: 4 } });
    expect(resolveRange({ fromRelative: "-1", toRelative: "-1" }, T5)).toEqual({
      ok: true,
      value: { from: 3, to: 3 },
    });
    expect(resolveRange({ fromRelative: "-4", toRelative: "0" }, T5)).toEqual({
      ok: true,
      value: { from: 0, to: 4 },
    });
  });

  test("single bound implies missing end (from→to=T-1; to→from=0)", () => {
    expect(resolveRange({ fromRelative: "-2" }, T5)).toEqual({ ok: true, value: { from: 2, to: 4 } });
    expect(resolveRange({ toRelative: "-2" }, T5)).toEqual({ ok: true, value: { from: 0, to: 2 } });
    expect(resolveRange({ from: "1" }, T5)).toEqual({ ok: true, value: { from: 1, to: 4 } });
    expect(resolveRange({ to: "1" }, T5)).toEqual({ ok: true, value: { from: 0, to: 1 } });
  });

  test("absolute bounds; equal bounds", () => {
    expect(resolveRange({ from: "1", to: "3" }, T5)).toEqual({ ok: true, value: { from: 1, to: 3 } });
    expect(resolveRange({ fromRelative: "-2", toRelative: "-2" }, T5)).toEqual({
      ok: true,
      value: { from: 2, to: 2 },
    });
  });

  test("mixed relative+absolute inverted → inversion error", () => {
    const r = resolveRange({ fromRelative: "-2", to: "1" }, T5); // from=2 > to=1
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("2");
      expect(r.error).toContain("1");
    }
  });

  test("mixed range that resolves valid: fromRelative -3 → abs 1, to=2", () => {
    expect(resolveRange({ fromRelative: "-3", to: "2" }, T5)).toEqual({
      ok: true,
      value: { from: 1, to: 2 },
    });
  });

  test("inverted range → error showing BOTH resolved absolute values", () => {
    const r = resolveRange({ from: "3", to: "1" }, T5);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("3");
      expect(r.error).toContain("1");
    }
  });

  test("non-integer values rejected (strict /^-?\\d+$/)", () => {
    for (const bad of ["x", "1.5", "", " ", "1e2", "+1", "--1"]) {
      expect(resolveRange({ fromRelative: bad }, T5).ok).toBe(false);
      expect(resolveRange({ from: bad }, T5).ok).toBe(false);
    }
  });

  test("positive relative rejected with --from hint; negative absolute rejected", () => {
    const r1 = resolveRange({ fromRelative: "1" }, T5);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.toLowerCase()).toContain("--from");
    expect(resolveRange({ from: "-1" }, T5).ok).toBe(false);
  });

  test("zero-sign: -0 rejected, 0 valid", () => {
    expect(resolveRange({ fromRelative: "-0" }, T5).ok).toBe(false);
    expect(resolveRange({ fromRelative: "0" }, T5).ok).toBe(true);
  });

  test("T=0: any bound → error echoing total", () => {
    const r = resolveRange({ fromRelative: "0" }, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("0");
  });

  test("post-resolve OOR distinct from inversion (relative -5 when T=5 → abs -1)", () => {
    const r = resolveRange({ fromRelative: "-5" }, T5);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.toLowerCase()).toContain("range");
      expect(r.error).toContain("5");
    }
    // abs beyond T-1 also OOR
    expect(resolveRange({ from: "5", to: "5" }, T5).ok).toBe(false);
  });
});

describe("sliceTurn", () => {
  function fiveTurns(): { detail: SessionDetail; turns: ReturnType<typeof groupTurns> } {
    const msgs: SessionMessage[] = [];
    for (let i = 0; i < 5; i++) {
      msgs.push(mkMsg(`u${i}`, "user", [T(`q${i}`)], `2026-01-01T00:0${i}:00Z`, i * 2 + 1));
      msgs.push(mkMsg(`a${i}`, "assistant", [T(`ans${i}`)], `2026-01-01T00:0${i}:30Z`, i * 2 + 2));
    }
    const detail = mkDetail(msgs, "five turns");
    return { detail, turns: groupTurns(msgs) };
  }

  test("slice 1..3 rewrites message_count, title suffix 1-based N/M, timestamps from slice edges", () => {
    const { detail, turns } = fiveTurns();
    const s = sliceTurn(detail, turns, { from: 1, to: 3 });
    expect(s.message_count).toBe(6); // 3 turns × 2 msgs
    expect(s.title.endsWith("— turn 2/4")).toBe(true); // 1-based N=2 of M=4 slice turns
    expect(s.created_at).toBe("2026-01-01T00:01:00Z"); // first slice msg (u1)
    expect(s.updated_at).toBe("2026-01-01T00:03:30Z"); // last slice msg (a3)
  });

  test("title suffix idempotent — pre-existing suffix stripped, not doubled", () => {
    const { detail, turns } = fiveTurns();
    const once = sliceTurn(detail, turns, { from: 1, to: 3 });
    const twice = sliceTurn(once, turns, { from: 1, to: 3 });
    const occurrences = twice.title.split("— turn").length - 1;
    expect(occurrences).toBe(1);
    expect(twice.title.endsWith("— turn 2/4")).toBe(true);
  });

  test("messages keep global index AND gain slice-local index", () => {
    const { detail, turns } = fiveTurns();
    const s = sliceTurn(detail, turns, { from: 1, to: 3 });
    const first = s.messages![0];
    expect(first.index).toBe(3); // global preserved (u1 = index 3)
    const local = (first as unknown as { slice_index?: number }).slice_index;
    expect(local).toBe(1);
    const last = s.messages![5];
    expect(last.index).toBe(8); // a3 global
    expect((last as unknown as { slice_index?: number }).slice_index).toBe(6);
  });

  test("full-range slice still appends suffix", () => {
    const { detail, turns } = fiveTurns();
    const s = sliceTurn(detail, turns, { from: 0, to: 4 });
    expect(s.title.endsWith("— turn 1/5")).toBe(true);
  });

  test("single-turn slice suffix N=M", () => {
    const { detail, turns } = fiveTurns();
    const s = sliceTurn(detail, turns, { from: 2, to: 2 });
    expect(s.title.endsWith("— turn 3/3")).toBe(true);
  });
});
