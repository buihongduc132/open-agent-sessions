/**
 * test/tui-tree-forest.test.ts
 *
 * TDD tests for Bug 3: the tree shows 23 identical entries when
 * `parentSessionId` is absent on all sessions.
 *
 * Root cause (tree-model.ts:63-164):
 *
 *   Phase 1  – builds nodeMap and parentMap from sessions.
 *              If no session has parentSessionId, parentMap stays empty.
 *
 *   Phase 2  – only processes entries from parentMap (skipped when empty).
 *
 *   Phase 3  – lines 146-158:
 *              const childKeys = new Set(parentMap.keys()); // empty!
 *              for (const node of nodeMap.values()) {
 *                if (!childKeys.has(node.sessionId)) {          // true for all
 *                  if (!parentMap.has(node.sessionId)) {       // true for all
 *                    if (!roots.includes(node)) roots.push(node);
 *                  }
 *                }
 *              }
 *              → ALL nodes are pushed to roots when parentMap is empty.
 *
 * Expected (fixed) behaviour:
 *   - Every distinct session becomes a root tree — not deduplicated away.
 *   - The forest length equals the number of sessions.
 *   - Each root has a unique key.
 *   - Sessions with the same agent:alias appear as SEPARATE root entries
 *     (not merged into one), each rendered with its own sessionId/title so
 *     the UI can distinguish them.
 *   - Calling buildForest twice with the same session list is idempotent
 *     (no double-counting).
 */

import { describe, expect, test } from "bun:test";
import {
  buildForest,
  findNode,
  renderForest,
  countNodes,
  type TreeNode,
  type TreeRenderLine,
} from "../src/tui/tree-model";

// ---------------------------------------------------------------------------
// Helper: minimal SessionSummary with optional parentSessionId
// ---------------------------------------------------------------------------

function session(overrides: {
  id: string;
  agent: string;
  alias: string;
  title?: string;
  parentSessionId?: string;
  updated_at?: string;
  created_at?: string;
  storage?: string;
}): {
  id: string;
  agent: string;
  alias: string;
  title?: string;
  parentSessionId?: string;
  updated_at: string;
  created_at: string;
  storage: string;
} {
  return {
    ...overrides,
    id: overrides.id ?? `s-${Math.random().toString(36).slice(2, 6)}`,
    agent: overrides.agent ?? "opencode",
    alias: overrides.alias ?? "default",
    updated_at: overrides.updated_at ?? "2024-01-01T00:00:00Z",
    created_at: overrides.created_at ?? "2024-01-01T00:00:00Z",
    storage: overrides.storage ?? "jsonl",
  };
}

// ---------------------------------------------------------------------------
// Bug 3.1 – all sessions without parentSessionId → all are roots
// ---------------------------------------------------------------------------

describe("Bug 3 – buildForest with no parentSessionId", () => {
  test("N sessions without parentSessionId → N root trees (no deduplication)", () => {
    const sessions = [
      session({ id: "s1", agent: "opencode", alias: "default" }),
      session({ id: "s2", agent: "opencode", alias: "default" }),
      session({ id: "s3", agent: "opencode", alias: "default" }),
    ];

    const forest = buildForest(sessions as any);

    // Each distinct session must appear as a separate root
    expect(forest.length).toBe(sessions.length);
    expect(forest.length).toBe(3);
  });

  test("forest length equals session count when all sessions are flat (no parentSessionId)", () => {
    const sessions = Array.from({ length: 23 }, (_, i) =>
      session({ id: `s${i}`, agent: "opencode", alias: "default" })
    );

    const forest = buildForest(sessions as any);

    // The bug would collapse N sessions to 1 root (or wrong count)
    // Fixed behaviour: one root per session
    expect(forest.length).toBe(23);
  });

  test("each root has a unique key (agent:alias:sessionId)", () => {
    const sessions = [
      session({ id: "aaa", agent: "opencode", alias: "dev" }),
      session({ id: "bbb", agent: "opencode", alias: "dev" }),
      session({ id: "ccc", agent: "opencode", alias: "dev" }),
    ];

    const forest = buildForest(sessions as any);
    const keys = forest.map((n) => n.key);

    // Keys must all be unique
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
    expect(uniqueKeys.size).toBe(3);

    // Each key must follow the agent:alias:sessionId pattern
    for (const key of keys) {
      expect(key).toMatch(/^[^:]+:[^:]+:[^:]+$/);
    }
  });

  test("each root has a unique sessionId", () => {
    const sessions = [
      session({ id: "x1", agent: "claude", alias: "work" }),
      session({ id: "x2", agent: "claude", alias: "work" }),
      session({ id: "x3", agent: "claude", alias: "work" }),
    ];

    const forest = buildForest(sessions as any);
    const ids = forest.map((n) => n.sessionId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("x1");
    expect(ids).toContain("x2");
    expect(ids).toContain("x3");
  });

  test("countNodes equals number of input sessions when all are flat", () => {
    const sessions = [
      session({ id: "n1", agent: "opencode", alias: "alpha" }),
      session({ id: "n2", agent: "opencode", alias: "alpha" }),
      session({ id: "n3", agent: "codex",   alias: "beta"  }),
      session({ id: "n4", agent: "claude",  alias: "gamma" }),
      session({ id: "n5", agent: "opencode", alias: "alpha" }),
    ];

    const forest = buildForest(sessions as any);
    expect(countNodes(forest)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Bug 3.2 – findNode must locate any session as a root
// ---------------------------------------------------------------------------

describe("Bug 3 – findNode locates flat sessions correctly", () => {
  test("findNode finds a session that is a root (no parentSessionId)", () => {
    const sessions = [
      session({ id: "root-a", agent: "opencode", alias: "main" }),
      session({ id: "root-b", agent: "opencode", alias: "main" }),
    ];

    const forest = buildForest(sessions as any);
    const node = findNode(forest, "opencode:main:root-a");

    expect(node).toBeDefined();
    expect(node!.sessionId).toBe("root-a");
  });

  test("findNode finds all sessions when none have parentSessionId", () => {
    const sessions = [
      session({ id: "r1", agent: "opencode", alias: "default" }),
      session({ id: "r2", agent: "opencode", alias: "default" }),
      session({ id: "r3", agent: "opencode", alias: "default" }),
    ];

    const forest = buildForest(sessions as any);

    for (const s of sessions) {
      const key = `opencode:default:${s.id}`;
      expect(findNode(forest, key)).toBeDefined();
    }
  });

  test("findNode returns undefined for a sessionId that does not exist", () => {
    const sessions = [session({ id: "exists", agent: "opencode", alias: "default" })];
    const forest = buildForest(sessions as any);

    expect(findNode(forest, "opencode:default:nonexistent")).toBeUndefined();
    expect(findNode(forest, "codex:default:exists")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bug 3.3 – renderForest must output one line per root when flat
// ---------------------------------------------------------------------------

describe("Bug 3 – renderForest with no parentSessionId", () => {
  test("renders one line per root session (no extra duplication)", () => {
    const sessions = [
      session({ id: "p1", agent: "opencode", alias: "default" }),
      session({ id: "p2", agent: "opencode", alias: "default" }),
      session({ id: "p3", agent: "opencode", alias: "default" }),
    ];

    const forest = buildForest(sessions as any);
    const lines = renderForest(forest);

    // One line per root session
    expect(lines.length).toBe(3);
  });

  test("each rendered line has a unique key", () => {
    const sessions = [
      session({ id: "k1", agent: "claude", alias: "default" }),
      session({ id: "k2", agent: "claude", alias: "default" }),
    ];

    const forest = buildForest(sessions as any);
    const lines = renderForest(forest);
    const keys = lines.map((l) => l.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  test("rendered lines have depth 0 (all are top-level roots)", () => {
    const sessions = [
      session({ id: "d1", agent: "opencode", alias: "a" }),
      session({ id: "d2", agent: "opencode", alias: "a" }),
      session({ id: "d3", agent: "opencode", alias: "a" }),
    ];

    const forest = buildForest(sessions as any);
    const lines = renderForest(forest);

    for (const line of lines) {
      expect(line.depth).toBe(0);
    }
  });

  test("hasChildren is false for all root sessions when flat", () => {
    const sessions = [
      session({ id: "h1", agent: "opencode", alias: "default" }),
      session({ id: "h2", agent: "opencode", alias: "default" }),
    ];

    const forest = buildForest(sessions as any);
    const lines = renderForest(forest);

    for (const line of lines) {
      expect(line.hasChildren).toBe(false);
    }
  });

  test("line text is non-empty and contains agent name", () => {
    const sessions = [
      session({ id: "t1", agent: "opencode", alias: "default" }),
    ];

    const forest = buildForest(sessions as any);
    const lines = renderForest(forest);

    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line.text.trim().length).toBeGreaterThan(0);
    expect(line.text).toContain("opencode");
    expect(line.text).not.toContain("\x1b"); // no ANSI (Bug 1 guard)
  });

  // ---------------------------------------------------------------------------
  // Bug 3 – session ID suffix so same-agent:alias sessions are distinguishable
  // ---------------------------------------------------------------------------

  test("label contains ~sessionId suffix so identical agent:alias sessions differ", () => {
    const sessions = [
      session({ id: "aaa111", agent: "opencode", alias: "default" }),
      session({ id: "bbb222", agent: "opencode", alias: "default" }),
      session({ id: "ccc333", agent: "opencode", alias: "default" }),
    ];

    const forest = buildForest(sessions as any);
    const lines = renderForest(forest);

    expect(lines.length).toBe(3);

    const labels = lines.map((l) => l.text);

    // Each label ends with ~XXXX (first up-to-8 chars of sessionId)
    for (const label of labels) {
      expect(label).toMatch(/~[a-z0-9]{1,8}/);
    }

    // The three labels are all different (the ~XXXX suffix is the distinguisher)
    const uniqueLabels = new Set(labels);
    expect(uniqueLabels.size).toBe(3);
  });

  test("short session ID suffix uses first 8 chars of sessionId", () => {
    const sessions = [
      session({ id: "abcdefghijkl", agent: "claude", alias: "work" }),
    ];

    const forest = buildForest(sessions as any);
    const lines = renderForest(forest);

    expect(lines.length).toBe(1);
    // Label contains ~abcdefgh (first 8 chars only)
    expect(lines[0].text).toContain("~abcdefgh");
    // Does NOT contain the 9th+ char
    expect(lines[0].text).not.toContain("~abcdefghi");
  });

  test("keys are still unique and parseable as agent:alias:sessionId", () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      session({ id: `id${i}xxxxx`, agent: "opencode", alias: "default" })
    );

    const forest = buildForest(sessions as any);
    const lines = renderForest(forest);

    for (const line of lines) {
      const parts = line.key.split(":");
      expect(parts.length).toBe(3);
      expect(parts[0]).toBe("opencode");
      expect(parts[1]).toBe("default");
      expect(parts[2]).toMatch(/^id[0-4]xxxxx$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug 3.4 – mixed: some with parentSessionId, some without
// ---------------------------------------------------------------------------

describe("Bug 3 – mixed fork relationships and flat sessions", () => {
  test("forked child sessions are not duplicated as extra roots", () => {
    const sessions = [
      session({ id: "parent", agent: "opencode", alias: "default" }),
      session({ id: "child",  agent: "opencode", alias: "default", parentSessionId: "parent" }),
      session({ id: "orphan", agent: "opencode", alias: "default" }),
    ];

    const forest = buildForest(sessions as any);

    // Should have exactly 2 roots: "parent" (also has child) and "orphan"
    expect(forest.length).toBe(2);

    // The parent must have the child attached
    const parentNode = findNode(forest, "opencode:default:parent");
    expect(parentNode).toBeDefined();
    expect(parentNode!.children.length).toBe(1);
    expect(parentNode!.children[0].sessionId).toBe("child");

    // The orphan root has no children
    const orphanNode = findNode(forest, "opencode:default:orphan");
    expect(orphanNode).toBeDefined();
    expect(orphanNode!.children.length).toBe(0);
  });

  test("N sessions all flat + 1 forked → N+1 roots total", () => {
    const sessions = [
      session({ id: "r1", agent: "opencode", alias: "default" }),
      session({ id: "r2", agent: "opencode", alias: "default" }),
      session({ id: "r3", agent: "opencode", alias: "default" }),
      session({ id: "fork", agent: "opencode", alias: "default", parentSessionId: "r1" }),
    ];

    const forest = buildForest(sessions as any);

    // 3 flat roots + 1 child (not a root) = 3 roots
    expect(forest.length).toBe(3);
    expect(countNodes(forest)).toBe(4);
  });

  test("session with non-existent parentSessionId is treated as root", () => {
    const sessions = [
      session({ id: "alone", agent: "opencode", alias: "default", parentSessionId: "nonexistent" }),
      session({ id: "solo",  agent: "opencode", alias: "default" }),
    ];

    const forest = buildForest(sessions as any);

    // Both sessions are roots (parent not found + no parentSessionId)
    expect(forest.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Bug 3.5 – idempotency: calling buildForest twice is safe
// ---------------------------------------------------------------------------

describe("Bug 3 – idempotency (no double-counting on repeated calls)", () => {
  test("buildForest called twice with same sessions returns same length each time", () => {
    const sessions = [
      session({ id: "id1", agent: "opencode", alias: "default" }),
      session({ id: "id2", agent: "opencode", alias: "default" }),
      session({ id: "id3", agent: "opencode", alias: "default" }),
    ];

    const forest1 = buildForest(sessions as any);
    const forest2 = buildForest(sessions as any);

    expect(forest1.length).toBe(forest2.length);
    expect(forest1.length).toBe(3);
  });

  test("each buildForest call is independently correct (no cross-call interference)", () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      session({ id: `dup${i}`, agent: "opencode", alias: "default" })
    );

    const forest1 = buildForest(sessions as any);
    const forest2 = buildForest(sessions as any);

    // Each call is correct in isolation: 5 unique roots, 5 unique keys
    expect(forest1.length).toBe(5);
    expect(forest2.length).toBe(5);

    // Keys within each forest are unique (no duplicates in a single call)
    const keys1 = forest1.map((n) => n.key);
    const keys2 = forest2.map((n) => n.key);
    expect(new Set(keys1).size).toBe(keys1.length);
    expect(new Set(keys2).size).toBe(keys2.length);

    // Cross-call: the two forests are separate object instances
    // (each call creates fresh node objects — this is expected/correct)
    expect(forest1[0]).not.toBe(forest2[0]);
  });
});

// ---------------------------------------------------------------------------
// Bug 3.6 – sessions with same agent:alias but different ids are NOT merged
// ---------------------------------------------------------------------------

describe("Bug 3 – sessions sharing agent:alias are separate trees (not merged)", () => {
  test("two sessions with same agent:alias but different ids → two roots", () => {
    const sessions = [
      session({ id: "abc", agent: "opencode", alias: "default" }),
      session({ id: "xyz", agent: "opencode", alias: "default" }),
    ];

    const forest = buildForest(sessions as any);

    expect(forest.length).toBe(2);

    const keys = forest.map((n) => n.key);
    expect(keys).toContain("opencode:default:abc");
    expect(keys).toContain("opencode:default:xyz");
  });

  test("23 sessions with same agent:alias → 23 roots, not 1 collapsed root", () => {
    const sessions = Array.from({ length: 23 }, (_, i) =>
      session({ id: `s${String(i).padStart(3, "0")}`, agent: "opencode", alias: "default" })
    );

    const forest = buildForest(sessions as any);

    // Core assertion: no deduplication of distinct sessions
    expect(forest.length).toBe(23);

    const keys = new Set(forest.map((n) => n.key));
    expect(keys.size).toBe(23);
  });

  test("renderForest output has 23 lines for 23 flat sessions", () => {
    const sessions = Array.from({ length: 23 }, (_, i) =>
      session({ id: `r${String(i).padStart(3, "0")}`, agent: "opencode", alias: "default" })
    );

    const forest = buildForest(sessions as any);
    const lines = renderForest(forest);

    // One line per root session
    expect(lines.length).toBe(23);

    // All lines have unique keys
    const keys = lines.map((l) => l.key);
    expect(new Set(keys).size).toBe(23);
  });

  test("every line text contains the agent name", () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      session({ id: `t${i}`, agent: "claude", alias: "work" })
    );

    const forest = buildForest(sessions as any);
    const lines = renderForest(forest);

    for (const line of lines) {
      expect(line.text).toContain("claude");
    }
  });
});
