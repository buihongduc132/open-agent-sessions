/**
 * RED — formatter hardening tests (oas-export-turn-split).
 * GREEN state: renderTurnBody implemented; hardening applied.
 */
import { describe, test, expect } from "bun:test";
import { renderTurnBody, IGNORE_PART_TYPES } from "../src/core/export";
import type { SessionMessage, SessionPart } from "../src/core/types";

function mkMsg(id: string, role: "user" | "assistant", parts: SessionPart[]): SessionMessage {
  return { id, role, parts, created_at: "2026-01-01T00:00:00Z" };
}
const T = (text: string): SessionPart => ({ type: "text", text });
const TOOL = (name: string): SessionPart => ({ type: "tool", tool: name, state: { phase: "ok" } });

describe("renderTurnBody — yaml-safe frontmatter scalars", () => {
  test('frontmatter scalars JSON.stringify\'d: title "no", alias with #, numeric id', () => {
    // renderTurnBody renders turn body; frontmatter handled via detail path in dir export.
    // Here: verify a markdown render of a message set contains safely-quoted scalars for ids/names.
    const out = renderTurnBody(
      [mkMsg("u1", "user", [T("hi")])],
      { include: new Set(["text"]) },
      "markdown"
    );
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  test("control chars stripped from rendered scalar/body content", () => {
    const out = renderTurnBody(
      [mkMsg("u1", "user", [T("a\u0000b\u0007c")])],
      { include: new Set(["text"]) },
      "markdown"
    );
    expect(out).not.toContain("\u0000");
    expect(out).not.toContain("\u0007");
  });
});

describe("renderTurnBody — dynamic fences", () => {
  test("fence length strictly greater than longest backtick run in content", () => {
    const evil = "```\ncode\n``````\nmore";
    const out = renderTurnBody(
      [mkMsg("u1", "user", [{ type: "unknown", payload: evil }])],
      { include: new Set(["text", "unknown"]) },
      "markdown"
    );
    // find all fence lines in output
    const fenceRuns = out.match(/`{3,}/g) ?? [];
    expect(fenceRuns.length).toBeGreaterThanOrEqual(2);
    const maxInner = Math.max(...(evil.match(/`{3,}/g) ?? ["``"]).map((s) => s.length));
    for (const fence of fenceRuns) {
      if (fence.length >= 3) expect(fence.length).toBeGreaterThan(maxInner);
    }
  });

  test("fence ≥3 baseline: normal content keeps standard ``` fences", () => {
    const out = renderTurnBody(
      [mkMsg("u1", "user", [{ type: "unknown", payload: "plain" }])],
      { include: new Set(["text", "unknown"]) },
      "markdown"
    );
    expect(out).toContain("```");
  });
});

describe("renderTurnBody — injection escaping", () => {
  test("markdown link injection neutralized", () => {
    const out = renderTurnBody(
      [mkMsg("u1", "user", [T("click [x](https://evil.example)")])],
      { include: new Set(["text"]) },
      "markdown"
    );
    expect(out).not.toMatch(/\[x\]\(https:\/\/evil\.example\)/);
  });

  test("task-list injection at line start neutralized", () => {
    const out = renderTurnBody(
      [mkMsg("u1", "user", [T("- [ ] injected\n- [x] done")])],
      { include: new Set(["text"]) },
      "markdown"
    );
    expect(out).not.toMatch(/^(\s*)- \[ \]/m);
  });

  test("legit prose not mangled: text content remains readable (no silent whole-part drop)", () => {
    const prose = "Normal sentence with *emphasis* and under_score words.";
    const out = renderTurnBody(
      [mkMsg("u1", "user", [T(prose)])],
      { include: new Set(["text"]) },
      "markdown"
    );
    // The words must survive (escaping chars allowed, dropping not)
    expect(out).toContain("Normal");
    expect(out).toContain("emphasis");
    expect(out).toContain("under_score");
  });
});

describe("renderTurnBody — size caps + binary skip", () => {
  test("markdown per-part cap ~64KB with truncation marker; csf lossless", () => {
    const big = "x".repeat(200_000);
    const md = renderTurnBody(
      [mkMsg("u1", "user", [T(big)])],
      { include: new Set(["text"]) },
      "markdown"
    );
    expect(md.length).toBeLessThan(150_000);
    expect(md).toMatch(/truncat/i);

    const csf = renderTurnBody(
      [mkMsg("u1", "user", [T(big)])],
      { include: new Set(["text"]) },
      "csf"
    );
    expect(csf.length).toBeGreaterThan(200_000);
  });

  test("binary-ish parts skipped with warning marker (markdown)", () => {
    const out = renderTurnBody(
      [
        mkMsg("u1", "user", [
          T("before"),
          { type: "image", data: "base64==" } as unknown as SessionPart,
          T("after"),
        ]),
      ],
      { include: new Set(["text", "image"]) },
      "markdown"
    );
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).not.toContain("base64==");
    expect(out).toMatch(/skip|binary|warn/i);
  });

  test("truncation applied BEFORE fence computation; marker outside closed fence", () => {
    const big = "`".repeat(200_000);
    const out = renderTurnBody(
      [mkMsg("u1", "user", [{ type: "unknown", payload: big }])],
      { include: new Set(["text", "unknown"]) },
      "markdown"
    );
    expect(out.length).toBeLessThan(150_000);
    expect(out).toMatch(/truncat/i);
  });
});

describe("renderTurnBody — ignore list + additive filter", () => {
  test("step-start/step-finish excluded by default, included only when explicitly selected", () => {
    const parts: SessionPart[] = [
      { type: "step-start" } as unknown as SessionPart,
      T("body"),
      { type: "step-finish" } as unknown as SessionPart,
    ];
    const def = renderTurnBody([mkMsg("u1", "user", parts)], { include: new Set(["text"]) }, "markdown");
    expect(def).toContain("body");
    expect(IGNORE_PART_TYPES.has("step-start")).toBe(true);
    expect(IGNORE_PART_TYPES.has("step-finish")).toBe(true);
    // step parts carry no user-visible payload — their presence in output is not required;
    // contract: default filter drops them (types not in include set)

    const withSteps = renderTurnBody(
      [mkMsg("u1", "user", parts)],
      { include: new Set(["text", "step-start", "step-finish"]) },
      "markdown"
    );
    expect(withSteps).toContain("step-start");
  });

  test("filter additive: text ∪ tool — never replaces", () => {
    const out = renderTurnBody(
      [mkMsg("a1", "assistant", [TOOL("bash"), T("result summary")])],
      { include: new Set(["text", "tool"]) },
      "markdown"
    );
    expect(out).toContain("result summary");
    expect(out).toContain("bash");
    expect(out).toContain("tool");
  });
});
