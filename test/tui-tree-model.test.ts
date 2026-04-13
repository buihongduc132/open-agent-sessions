/**
 * test/tui-tree-model.test.ts
 *
 * TDD tests for bugs 1 & 6:
 *   Bug 1+6: `colorForAgent()` returns raw ANSI escape sequences that get
 *            embedded into `TreeRenderLine.text`, rendering as literal
 *            "\x1b[36m[opencode]\x1b[0m" in the @opentui/react <text> node.
 *
 * Expected (fixed) behaviour:
 *   - `colorForAgent()` returns a plain hex color string or CSS colour token,
 *     NOT ANSI escape sequences.
 *   - `renderForest()` output lines contain NO `\x1b` characters.
 *   - `TreeRenderLine.text` is plain, human-readable text.
 */

import { describe, expect, test } from "bun:test";
import {
  buildForest,
  colorForAgent,
  renderForest,
  truncateLabel,
  type TreeNode,
} from "../src/tui/tree-model";

// ---------------------------------------------------------------------------
// Helper: build a minimal forest for tests
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<TreeNode> & { agent: string; alias: string; key: string; sessionId: string; title: string; updatedAt: string }): TreeNode {
  return {
    key: "",
    sessionId: "",
    title: "",
    agent: "",
    alias: "",
    updatedAt: "",
    children: [],
    ...overrides,
  };
}

function makeForest(): TreeNode[] {
  return [
    makeNode({
      key: "opencode:default:abc",
      sessionId: "abc",
      title: "Test Session",
      agent: "opencode",
      alias: "default",
      updatedAt: "2024-01-01T00:00:00Z",
      children: [
        makeNode({
          key: "opencode:default:def",
          sessionId: "def",
          title: "Child Session",
          agent: "opencode",
          alias: "default",
          updatedAt: "2024-01-02T00:00:00Z",
          forkedAt: "2024-01-02T10:30:00Z",
        }),
      ],
    }),
    makeNode({
      key: "codex:work:xyz",
      sessionId: "xyz",
      title: "Codex Work",
      agent: "codex",
      alias: "work",
      updatedAt: "2024-01-03T00:00:00Z",
    }),
    makeNode({
      key: "claude:default:uvw",
      sessionId: "uvw",
      title: "Claude Session",
      agent: "claude",
      alias: "default",
      updatedAt: "2024-01-04T00:00:00Z",
    }),
    makeNode({
      key: "acpx:play:rst",
      sessionId: "rst",
      title: "ACPX Session",
      agent: "acpx",
      alias: "play",
      updatedAt: "2024-01-05T00:00:00Z",
    }),
    makeNode({
      key: "unknown:default:mno",
      sessionId: "mno",
      title: "Unknown Agent",
      agent: "unknown",
      alias: "default",
      updatedAt: "2024-01-06T00:00:00Z",
    }),
  ];
}

// ---------------------------------------------------------------------------
// Bug 1: colorForAgent must NOT return ANSI escape sequences
// ---------------------------------------------------------------------------

describe("colorForAgent", () => {
  test("returns expected hex color for 'opencode'", () => {
    expect(colorForAgent("opencode")).toBe("#4dd9ff");
  });

  test("returns expected hex color for 'codex'", () => {
    expect(colorForAgent("codex")).toBe("#ffcc00");
  });

  test("returns expected hex color for 'claude'", () => {
    expect(colorForAgent("claude")).toBe("#cc99ff");
  });

  test("returns expected hex color for 'acpx'", () => {
    expect(colorForAgent("acpx")).toBe("#99ff99");
  });

  test("returns a valid hex color for unknown agents", () => {
    const result = colorForAgent("sentinel");
    // Must be a valid hex color (no ANSI), non-empty string
    expect(result).not.toContain("\x1b");
    expect(result).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  test("result is a non-empty string for all known agents", () => {
    expect(colorForAgent("opencode").length).toBeGreaterThan(0);
    expect(colorForAgent("codex").length).toBeGreaterThan(0);
    expect(colorForAgent("claude").length).toBeGreaterThan(0);
    expect(colorForAgent("acpx").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Bug 1+6: renderForest output lines must not contain ANSI escape sequences
// ---------------------------------------------------------------------------

describe("renderForest — no ANSI in output", () => {
  const ANSI_ESC = "\x1b";

  test("output lines have no \\x1b characters", () => {
    const forest = makeForest();
    const lines = renderForest(forest);

    for (const line of lines) {
      expect(line.text).not.toContain(ANSI_ESC);
    }
  });

  test("output lines are human-readable plain text", () => {
    const forest = makeForest();
    const lines = renderForest(forest);

    for (const line of lines) {
      // Plain text should contain visible characters, not escape sequences
      // A line with ANSI embedded would be much longer and contain non-printable chars
      expect(line.text.trim().length).toBeGreaterThan(0);
    }
  });

  test("agent name appears verbatim in line text (not wrapped in ANSI)", () => {
    const forest = makeForest();
    const lines = renderForest(forest);

    const agentNames = ["opencode", "codex", "claude", "acpx", "unknown"];
    for (const agent of agentNames) {
      const matchingLines = lines.filter((l) => l.key.includes(agent));
      expect(matchingLines.length, `expected at least one line for agent '${agent}'`).toBeGreaterThan(0);

      for (const ln of matchingLines) {
        // The agent name should appear as readable text, not as "[opencode]"
        // wrapped in ANSI (which would look like "  \x1b[36m[opencode]\x1b[0m /default")
        expect(ln.text).not.toContain("\x1b[36m[opencode]");
        expect(ln.text).not.toContain("\x1b[33m[codex]");
        expect(ln.text).not.toContain("\x1b[35m[claude]");
        expect(ln.text).not.toContain("\x1b[32m[acpx]");
      }
    }
  });

  test("line text for selected node contains agent/alias — no ANSI", () => {
    const forest = makeForest();
    const lines = renderForest(forest, { selectedKey: "opencode:default:abc" });

    const selected = lines.find((l) => l.key === "opencode:default:abc");
    expect(selected).toBeDefined();
    expect(selected!.text).not.toContain(ANSI_ESC);
    // The readable text should contain something like "opencode/default"
    expect(selected!.text).toContain("opencode");
  });

  test("collapsed node lines have no ANSI codes", () => {
    const forest = makeForest();
    const collapsed = new Set(["opencode:default:abc"]);
    const lines = renderForest(forest, { collapsed });

    const collapsedLine = lines.find((l) => l.key === "opencode:default:abc");
    expect(collapsedLine).toBeDefined();
    expect(collapsedLine!.text).not.toContain(ANSI_ESC);
    expect(collapsedLine!.isCollapsed).toBe(true);
  });

  test("all lines from a multi-agent forest are ANSI-free", () => {
    const forest = makeForest();
    const lines = renderForest(forest);

    expect(lines.length).toBeGreaterThan(5); // at least root + some children
    for (const line of lines) {
      expect(line.text).not.toContain(ANSI_ESC);
    }
  });
});

// ---------------------------------------------------------------------------
// TreeRenderLine.text contract
// ---------------------------------------------------------------------------

describe("TreeRenderLine.text must be plain readable text", () => {
  test("text field is a string", () => {
    const forest = makeForest();
    const lines = renderForest(forest);

    for (const line of lines) {
      expect(typeof line.text).toBe("string");
    }
  });

  test("text field contains no control characters (ASCII < 0x20) except horizontal tab/space", () => {
    const forest = makeForest();
    const lines = renderForest(forest);

    for (const line of lines) {
      for (const ch of line.text) {
        const code = ch.charCodeAt(0);
        const isVisible = code === 9 || code === 10 || code === 13 || code >= 32;
        expect(isVisible, `non-printable char U+${code.toString(16).toUpperCase().padStart(4, "0")} in line: ${line.text}`).toBe(true);
      }
    }
  });

  test("text field for opencode root node is readable", () => {
    const forest = makeForest();
    const lines = renderForest(forest);

    const opencodeLine = lines.find((l) => l.key === "opencode:default:abc");
    expect(opencodeLine).toBeDefined();
    const text = opencodeLine!.text;

    // After the prefix (│   or ├── ), plain readable text should follow
    // e.g. "[opencode] opencode/default" or "opencode/default"
    // NOT: "  \x1b[36m[opencode]\x1b[0m /default"
    expect(text).not.toContain("\x1b");
    expect(text).toContain("opencode");
    expect(text).toContain("default");
  });

  test("line text is printable — no raw ANSI codes visible when stringified", () => {
    const forest = makeForest();
    const lines = renderForest(forest);

    for (const line of lines) {
      // If ANSI is embedded, JSON.stringify would show \u001b not \x1b —
      // but the real issue is that it renders as literal text in the UI.
      // The cleanest check: the text should NOT contain "\x1b[".
      expect(line.text).not.toContain("\x1b[");
    }
  });
});

// ---------------------------------------------------------------------------
// buildForest integration
// ---------------------------------------------------------------------------

describe("buildForest", () => {
  test("builds a forest from flat session list", () => {
    const sessions = [
      { id: "s1", agent: "opencode", alias: "default", title: "Root", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" },
      { id: "s2", agent: "opencode", alias: "default", title: "Child", created_at: "2024-01-02T00:00:00Z", updated_at: "2024-01-02T00:00:00Z", parentSessionId: "s1" },
    ];
    const forest = buildForest(sessions as any);

    expect(forest.length).toBeGreaterThan(0);
    const root = forest.find((n) => n.sessionId === "s1");
    expect(root).toBeDefined();
    expect(root!.children.length).toBeGreaterThan(0);
  });

  test("renderForest on buildForest output has no ANSI", () => {
    const sessions = [
      { id: "s1", agent: "claude", alias: "work", title: "Root", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" },
    ];
    const forest = buildForest(sessions as any);
    const lines = renderForest(forest);

    for (const line of lines) {
      expect(line.text).not.toContain("\x1b");
    }
  });
});

// ---------------------------------------------------------------------------
// Bug 2: Long tree labels must be truncated to terminal width
// ---------------------------------------------------------------------------

describe("truncateLabel", () => {
  test("returns original text when it fits within maxWidth", () => {
    expect(truncateLabel("hello", 10)).toBe("hello");
  });

  test("returns original text when it exactly equals maxWidth", () => {
    expect(truncateLabel("hello", 5)).toBe("hello");
  });

  test("truncates with ellipsis (…) when text exceeds maxWidth", () => {
    expect(truncateLabel("hello world", 8)).toBe("hello w…");
  });

  test("ellipsis is the single-character ellipsis character", () => {
    const result = truncateLabel("this is a very long string", 5);
    expect(result.endsWith("…")).toBe(true);
  });

  test("returns original text when maxWidth is undefined", () => {
    expect(truncateLabel("hello", undefined)).toBe("hello");
  });

  test("returns original text when maxWidth is 0", () => {
    expect(truncateLabel("hello", 0)).toBe("hello");
  });

  test("returns empty string when input is empty (regardless of maxWidth)", () => {
    expect(truncateLabel("", 10)).toBe("");
    expect(truncateLabel("", 0)).toBe("");
    expect(truncateLabel("", undefined)).toBe("");
  });

  test("handles maxWidth less than 3 (minimum meaningful content)", () => {
    // maxWidth=1 or 2: even the ellipsis alone is "truncation" but content is trivial
    expect(truncateLabel("hello", 1).length).toBeLessThanOrEqual(1);
    expect(truncateLabel("hello", 2).length).toBeLessThanOrEqual(2);
  });
});

describe("renderForest — label truncation respects max label width", () => {
  test("labels fit when maxLabelWidth >= longest label length", () => {
    const forest = makeForest();
    const lines = renderForest(forest, { maxLabelWidth: 200 });

    for (const line of lines) {
      // Strip tree-prefix (├── / └── / │   /     ) to get just the label
      const label = extractLabel(line.text);
      expect(label.length).toBeLessThanOrEqual(200);
    }
  });

  test("labels are truncated when maxLabelWidth is small", () => {
    const forest = makeForest();
    const lines = renderForest(forest, { maxLabelWidth: 20 });

    for (const line of lines) {
      const label = extractLabel(line.text);

      // Get the untruncated label by rendering without maxLabelWidth
      const untruncatedLines = renderForest(forest);
      const untruncatedLine = untruncatedLines.find((l) => l.key === line.key);
      const untruncatedLabel = untruncatedLine ? extractLabel(untruncatedLine.text) : label;

      expect(label.length, `label "${label}" exceeds 20`).toBeLessThanOrEqual(20);

      // If truncation actually happened, the result must end with ellipsis
      if (label !== untruncatedLabel) {
        expect(label.endsWith("…"), `truncated label "${label}" missing ellipsis`).toBe(true);
      }
    }
  });

  test("very long alias labels are truncated", () => {
    const veryLongAlias = "very-long-alias~abcdefghijklmnopqrstuvwxyz";
    const node = makeNode({
      key: "opencode:default:abc",
      sessionId: "abc",
      title: "Test",
      agent: "opencode",
      alias: veryLongAlias,
      updatedAt: "2024-01-01T00:00:00Z",
      forkedAt: "2024-01-02T10:30:00Z",
      children: [
        makeNode({
          key: "opencode:default:def",
          sessionId: "def",
          title: "Child",
          agent: "opencode",
          alias: veryLongAlias,
          updatedAt: "2024-01-02T00:00:00Z",
        }),
      ],
    });
    const forest = [node];
    const lines = renderForest(forest, { maxLabelWidth: 40 });

    for (const line of lines) {
      const label = extractLabel(line.text);
      expect(label.length).toBeLessThanOrEqual(40);
      if (line.key.includes(veryLongAlias) && label.length === 40) {
        expect(label.endsWith("…")).toBe(true);
      }
    }
  });

  test("collapsed node suffix (+N more) is preserved and not duplicated", () => {
    const forest = makeForest();
    const collapsed = new Set(["opencode:default:abc"]);
    const lines = renderForest(forest, { collapsed, maxLabelWidth: 80 });

    const collapsedLine = lines.find((l) => l.key === "opencode:default:abc");
    expect(collapsedLine).toBeDefined();
    const label = extractLabel(collapsedLine!.text);
    // Should contain the collapsed indicator exactly once
    expect(label.split("(+").length).toBeLessThanOrEqual(2);
    expect(label).toContain("(+1 more)");
  });

  test("maxLabelWidth is optional — renders fine without it", () => {
    const forest = makeForest();
    // Should not throw
    expect(() => renderForest(forest)).not.toThrow();
    const lines = renderForest(forest);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("maxLabelWidth=0 does not crash and returns labels as-is", () => {
    const forest = makeForest();
    const lines = renderForest(forest, { maxLabelWidth: 0 });
    expect(lines.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// ASCII tree-prefix constants — must match tree-model.ts exactly
const INDENT = "  ";
const PIPE   = "│   ";
const BRANCH = "├── ";
const LAST   = "└── ";

/** Strip the tree connector prefix to isolate the label portion of a render line. */
function extractLabel(text: string): string {
  // Peel off one level of indent/pipe, then the branch/last connector.
  if (text.startsWith(BRANCH)) return text.slice(BRANCH.length);
  if (text.startsWith(LAST))   return text.slice(LAST.length);
  // Handles indented children: "│   " or "  " prefix + connector
  if (text.startsWith(PIPE)) {
    const rest = text.slice(PIPE.length);
    if (rest.startsWith(BRANCH)) return rest.slice(BRANCH.length);
    if (rest.startsWith(LAST))   return rest.slice(LAST.length);
    return rest;
  }
  if (text.startsWith(INDENT)) {
    const rest = text.slice(INDENT.length);
    if (rest.startsWith(BRANCH)) return rest.slice(BRANCH.length);
    if (rest.startsWith(LAST))   return rest.slice(LAST.length);
    return rest;
  }
  return text;
}