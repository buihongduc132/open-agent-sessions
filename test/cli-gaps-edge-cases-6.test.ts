/**
 * test/cli-gaps-edge-cases-6.test.ts
 *
 * RED tests for edge cases NOT covered by ANY existing test suite:
 *   - test/cli-read.test.ts         (AC1-AC14, range clamping, JSON, output)
 *   - test/cli-read-composable.test.ts  (acpx adapter userOnly with --last, --range)
 *   - test/cli-tree.test.ts         (tree command, children command, list filters, Zone 1-3)
 *   - test/cli-gaps-edge-cases.test.ts through test/cli-gaps-edge-cases-5.test.ts
 *
 * All tests below MUST fail with the current code. Each targets a specific
 * untested edge case that reveals a real bug or missing behavior.
 *
 * Focus areas (from _16apr_gaps.md):
 *   - Area 5: Tree/children command edge cases
 *   - Area 4: Composable read flags
 */

import { describe, expect, test } from "bun:test";
import { type Config } from "../src/config/types";
import {
  type SessionDetail,
  type SessionReadOptions,
  type SessionMessage,
  type SessionSummary,
} from "../src/core/types";
import { type ForkChainNode } from "../src/core/subagents";
import type { ListService } from "../src/cli/list";

// ============================================================================
// Shared fixtures
// ============================================================================

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
    { agent: "claude", alias: "team", enabled: false },
  ],
};

// SessionItem is SessionSummary with optional parentSessionId
type SessionItem = SessionSummary & { parentSessionId?: string };

// ============================================================================
// GAP 1: Tree command — newline in title breaks one-line-per-node format
// ============================================================================
// Root cause: tree.ts line 76-80 includes the title verbatim:
//   const title = node.title?.trim() || node.sessionId;
//   lines.push(`${indent}${label} ${title} (${node.sessionId})`);
//
// If title contains \n, the output row spans multiple lines, breaking the
// one-node-per-line contract. The list command (list.ts line 215) sanitizes
// titles with `rawTitle.replace(/[\r\n]+/g, " ")`, but tree.ts does not.
//
// Expected fix: tree.ts should sanitize newlines in titles before rendering:
//   const rawTitle = node.title?.trim() || node.sessionId;
//   const title = rawTitle === node.sessionId ? rawTitle : rawTitle.replace(/[\r\n]+/g, " ");
// ============================================================================

describe("GAP 1: Tree command — newline in title breaks one-line-per-node format", () => {

  /**
   * WHY RED: A session title "Hello\nWorld" contains a literal newline.
   * The tree output becomes:
   *   [opencode:main] Hello
   *   World (newline-session)
   * This breaks the one-line-per-node contract. Two lines for one node.
   * The list command already sanitizes this (list.ts line 215) but tree.ts does not.
   *
   * After fix: tree.ts should sanitize newlines in titles before rendering:
   *   const rawTitle = node.title?.trim() || node.sessionId;
   *   const title = rawTitle === node.sessionId ? rawTitle : rawTitle.replace(/[\r\n]+/g, " ");
   */
  test("tree_newline_in_title_does_not_break_one_line_per_node", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");

    const chain: ForkChainNode[] = [
      {
        sessionId: "nl-tree-001",
        title: "Hello\nWorld",
        agent: "opencode",
        alias: "main",
        depth: 0,
      },
      {
        sessionId: "nl-tree-002",
        title: "Normal title",
        agent: "codex",
        alias: "work",
        depth: 1,
        parentSessionId: "nl-tree-001",
      },
    ];

    const getForkChain = async (): Promise<ForkChainNode[]> => chain;

    const result = await runTreeCommand({
      session: "nl-tree-002",
      config: baseConfig,
      getForkChain,
    });

    expect(result.exitCode).toBe(0);

    // Two nodes should produce exactly 2 non-empty output lines
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);

    // RED: Currently 3 lines because the \n in "Hello\nWorld" splits line 1
    // After fix: newline is replaced with space → 2 lines
    expect(lines.length).toBe(2);

    // Both session IDs must appear
    expect(result.stdout).toContain("nl-tree-001");
    expect(result.stdout).toContain("nl-tree-002");
  });

  /**
   * WHY RED: Carriage return + newline (\r\n) in title also breaks format.
   * Same root cause as above — no sanitization of control characters.
   */
  test("tree_carriage_return_in_title_does_not_break_output", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");

    const chain: ForkChainNode[] = [
      {
        sessionId: "cr-tree-001",
        title: "Line1\r\nLine2\r\nLine3",
        agent: "opencode",
        alias: "main",
        depth: 0,
      },
    ];

    const getForkChain = async (): Promise<ForkChainNode[]> => chain;

    const result = await runTreeCommand({
      session: "cr-tree-001",
      config: baseConfig,
      getForkChain,
    });

    expect(result.exitCode).toBe(0);

    const lines = result.stdout.split("\n").filter((l) => l.length > 0);

    // RED: \r\n produces 3 lines instead of 1
    // After fix: all control chars replaced with space → 1 line
    expect(lines.length).toBe(1);
  });
});

// ============================================================================
// GAP 2: Children command — newline in title breaks one-line-per-node format
// ============================================================================
// Same root cause as GAP 1 but in children.ts lines 49-57:
//   const title = child.title?.trim() || child.id;
//   lines.push(`${label} ${title} (${child.id})`);
//
// No sanitization of newlines in titles. The list command sanitizes this
// but children.ts does not.
// ============================================================================

describe("GAP 2: Children command — newline in title breaks one-line-per-node format", () => {

  /**
   * WHY RED: A child session with title "Title\nwith\nnewlines" produces
   * 3 output lines instead of 1, breaking one-child-per-line format.
   * Consumers (TUI, piping, grep) depend on one-line-per-session.
   *
   * After fix: children.ts should sanitize newlines in titles:
   *   const rawTitle = child.title?.trim() || child.id;
   *   const title = rawTitle === child.id ? rawTitle : rawTitle.replace(/[\r\n]+/g, " ");
   */
  test("children_newline_in_title_does_not_break_one_line_per_child", async () => {
    const { runChildrenCommand } = await import("../src/cli/children");

    const children: SessionItem[] = [
      {
        id: "child-nl-001",
        agent: "opencode" as const,
        alias: "personal" as const,
        title: "Title\nwith\nnewlines",
        created_at: "2024-01-01T01:00:00Z",
        updated_at: "2024-01-01T02:00:00Z",
        message_count: 1,
        storage: "db" as const,
        parentSessionId: "root-001",
      },
      {
        id: "child-nl-002",
        agent: "codex" as const,
        alias: "work" as const,
        title: "Normal child",
        created_at: "2024-01-01T01:30:00Z",
        updated_at: "2024-01-01T02:30:00Z",
        message_count: 2,
        storage: "db" as const,
        parentSessionId: "root-001",
      },
    ];

    const getChildren = async (): Promise<SessionItem[]> => children;

    const result = await runChildrenCommand({
      parentSessionId: "root-001",
      config: baseConfig,
      getChildren,
    });

    expect(result.exitCode).toBe(0);

    // Two children should produce exactly 2 non-empty output lines
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);

    // RED: Currently 4 lines (3 from first child's title, 1 from second child)
    // After fix: newline replaced with space → 2 lines
    expect(lines.length).toBe(2);

    // Both session IDs must appear
    expect(result.stdout).toContain("child-nl-001");
    expect(result.stdout).toContain("child-nl-002");
  });
});

// ============================================================================
// GAP 3: Tree command — error message missing session ID
// ============================================================================
// Root cause: tree.ts line 43:
//   stderr: `Error fetching fork chain: ${error instanceof Error ? error.message : String(error)}\n`
//
// The error message does NOT include the session ID. When multiple tree commands
// fail (e.g., in a script), users can't tell which session caused the error.
//
// The "session not found" path (line 51) correctly includes the session ID:
//   `Session not found: ${options.session}\n`
// But the error path does not.
//
// Expected fix:
//   stderr: `Error fetching fork chain for ${options.session}: ${...}\n`
// ============================================================================

describe("GAP 3: Tree command — error message missing session ID", () => {

  /**
   * WHY RED: When getForkChain throws, the error message should include the
   * session ID for debugging. Currently it says:
   *   "Error fetching fork chain: Database connection refused"
   * User can't tell which session caused the failure.
   *
   * After fix: include session ID in the error:
   *   "Error fetching fork chain for ses-abc-123: Database connection refused"
   */
  test("tree_service_error_includes_session_id_in_error_message", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");

    const getForkChain = async (): Promise<ForkChainNode[]> => {
      throw new Error("Database connection refused");
    };

    const SESSION_ID = "ses-error-target-abc";

    const result = await runTreeCommand({
      session: SESSION_ID,
      config: baseConfig,
      getForkChain,
    });

    // Should return error
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);

    // RED: The error message should include the session ID for debugging
    // Currently: "Error fetching fork chain: Database connection refused"
    // Expected:  "Error fetching fork chain for ses-error-target-abc: Database connection refused"
    expect(result.stderr).toContain(SESSION_ID);

    // The original error message should also be present
    expect(result.stderr).toContain("Database connection refused");
  });
});

// ============================================================================
// GAP 4: Children command — error message missing parent session ID
// ============================================================================
// Root cause: children.ts line 32-37:
//   stderr: `${error instanceof Error ? error.message : String(error)}\n`
//
// The error message is just the raw error text with no prefix or context.
// Compare to tree.ts which at least has "Error fetching fork chain:" prefix.
// Children command has NO prefix at all — just the raw error message.
//
// Expected fix:
//   stderr: `Error fetching children for ${options.parentSessionId}: ${...}\n`
// ============================================================================

describe("GAP 4: Children command — error message missing parent session ID and context", () => {

  /**
   * WHY RED: When getChildren throws, the error message is just the raw error
   * text with no prefix or session ID context. Currently:
   *   "DB connection failed\n"
   * User doesn't know this came from the children command or which parent was queried.
   *
   * After fix: include parent session ID and command context:
   *   "Error fetching children for my-parent-session: DB connection failed"
   */
  test("children_service_error_includes_parent_session_id_in_error_message", async () => {
    const { runChildrenCommand } = await import("../src/cli/children");

    const getChildren = async (): Promise<SessionItem[]> => {
      throw new Error("DB connection failed");
    };

    const PARENT_ID = "my-parent-session-xyz";

    const result = await runChildrenCommand({
      parentSessionId: PARENT_ID,
      config: baseConfig,
      getChildren,
    });

    // Should return error
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);

    // RED: The error message should include the parent session ID
    // Currently: "DB connection failed\n" — no prefix, no session ID
    // Expected: "Error fetching children for my-parent-session-xyz: DB connection failed"
    expect(result.stderr).toContain(PARENT_ID);

    // The original error message should also be present
    expect(result.stderr).toContain("DB connection failed");
  });
});

// ============================================================================
// GAP 5: Tree JSON format — circular dedup removes legitimate duplicate IDs
// ============================================================================
// Root cause: tree.ts lines 55-63 deduplicates by sessionId:
//   const seen = new Set<string>();
//   for (const node of chain) {
//     if (!seen.has(node.sessionId)) { ... }
//   }
//
// This dedup is meant for circular references, but it also removes legitimate
// cases where the same session ID appears multiple times in a chain. For
// example, if agent A forks to B, and B forks back to A (legitimate re-entry),
// the dedup silently drops the second occurrence.
//
// More importantly, the JSON format should preserve the full chain (including
// duplicates) so the consumer can detect and handle cycles. The dedup should
// only apply to the text format, or be opt-in.
//
// No test exists for JSON format + circular chain interaction.
// ============================================================================

describe("GAP 5: Tree JSON format — dedup removes entries from circular chain", () => {

  /**
   * WHY RED: When the fork chain has a circular reference (A→B→C→A), the
   * text format dedup is correct (avoid infinite indentation). But the JSON
   * format should preserve ALL entries so consumers can detect the cycle.
   * Currently, JSON output also deduplicates, losing the cycle information.
   *
   * After fix: JSON output should include all chain nodes (even duplicates)
   * so consumers can detect circular references. Text format can keep dedup
   * to prevent runaway indentation.
   */
  test("tree_json_format_preserves_all_chain_entries_including_cycles", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");

    // Circular chain: A→B→C→A (cycle back to A)
    const circularChain: ForkChainNode[] = [
      { sessionId: "node-a", title: "Node A", agent: "opencode", alias: "main", depth: 2, parentSessionId: "node-c" },
      { sessionId: "node-b", title: "Node B", agent: "codex", alias: "work", depth: 1, parentSessionId: "node-a" },
      { sessionId: "node-c", title: "Node C", agent: "opencode", alias: "main", depth: 0, parentSessionId: "node-b" },
      { sessionId: "node-a", title: "Node A (re-entry)", agent: "opencode", alias: "main", depth: 0, parentSessionId: "node-c" },
    ];

    const getForkChain = async (): Promise<ForkChainNode[]> => circularChain;

    const result = await runTreeCommand({
      session: "node-c",
      config: baseConfig,
      getForkChain,
      format: "json",
    });

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);

    // RED: The chain has 4 entries (including the duplicate node-a re-entry),
    // but dedup reduces it to 3. JSON consumers lose the cycle signal.
    // After fix: JSON output should preserve all 4 entries.
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(4);

    // The duplicate node-a should appear twice in the JSON array
    const nodeAEntries = parsed.filter((n: any) => n.sessionId === "node-a");
    expect(nodeAEntries.length).toBe(2);
  });
});
