/**
 * test/cli-tree.test.ts
 *
 * RED tests for Gap 5: Agent hierarchy / delegation relationship visibility.
 *
 * These tests MUST FAIL until the following are implemented:
 *  - `oas tree <session-id>` command  (show fork chain from root)
 *  - `oas children <session-id>` command (list direct child sessions)
 *  - `oas list --roots-only` filter    (only root/main sessions)
 *  - `oas list --children-of <id>` filter (sessions with given parent)
 *  - `oas read` output includes parent info when present
 *
 * Infrastructure already in place:
 *  - `src/core/types.ts` already has `parentSessionId?: string` on SessionDetail
 *  - `src/core/subagents.ts` has `ForkChainNode` and `buildForkChain` (unused by CLI)
 *  - `src/core/types.ts` SessionSummary needs `parentSessionId?: string` added
 */

import { describe, expect, test } from "bun:test";
import { type Config } from "../src/config/types";
import { type SessionDetail } from "../src/core/types";
import { type ForkChainNode } from "../src/core/subagents";
// Static type-only import -- erased at runtime, no runtime cost.
// Allows TypeScript to resolve the ListService type for annotations.
import type { ListService } from "../src/cli/list";

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "main", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
    { agent: "claude", alias: "team", enabled: false },
  ],
};

// ---------------------------------------------------------------------------
// Fork-chain tree fixture
//  root-sess-001  (opencode:main, root -- no parent)
//      |
//      +-- child-001  (codex:work, parent=root-sess-001)
//            |
//            +-- grandchild-001  (opencode:main, parent=child-001)
// ---------------------------------------------------------------------------

const ROOT_SESSION: SessionDetail = {
  id: "root-sess-001",
  agent: "opencode",
  alias: "main",
  title: "Root orchestration session",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T01:00:00Z",
  message_count: 3,
  storage: "db",
  messages: [],
};

const CHILD_SESSION: SessionDetail = {
  id: "child-001",
  agent: "codex",
  alias: "work",
  title: "Verifier sub-session",
  created_at: "2024-01-01T01:30:00Z",
  updated_at: "2024-01-01T02:00:00Z",
  message_count: 2,
  storage: "db",
  messages: [],
  parentSessionId: "root-sess-001",
};

const GRANDCHILD_FORK_CHAIN: ForkChainNode[] = [
  {
    sessionId: "root-sess-001",
    title: "Root orchestration session",
    agent: "opencode",
    alias: "main",
    depth: 0,
    parentSessionId: undefined,
  },
  {
    sessionId: "child-001",
    title: "Verifier sub-session",
    agent: "codex",
    alias: "work",
    depth: 1,
    parentSessionId: "root-sess-001",
  },
  {
    sessionId: "grandchild-001",
    title: "Deep verifier fork",
    agent: "opencode",
    alias: "main",
    depth: 2,
    parentSessionId: "child-001",
  },
];

// Infer the session item type from ListService return so fixture types stay
// in sync with whatever the service returns (includes parentSessionId once added).
type SessionItem = ListService extends (q: unknown) => Promise<infer R>
  ? R extends { sessions: (infer S)[] } ? S : never
  : never;

const ROOT_DIRECT_CHILDREN: SessionItem[] = [
  {
    id: "child-001",
    agent: "codex" as const,
    alias: "work" as const,
    title: "Verifier sub-session",
    created_at: "2024-01-01T01:30:00Z",
    updated_at: "2024-01-01T02:00:00Z",
    message_count: 2,
    storage: "db" as const,
    parentSessionId: "root-sess-001",
  },
  {
    id: "child-002",
    agent: "claude" as const,
    alias: "team" as const,
    title: "Another fork",
    created_at: "2024-01-01T01:45:00Z",
    updated_at: "2024-01-01T02:10:00Z",
    message_count: 1,
    storage: "other" as const,
    parentSessionId: "root-sess-001",
  },
];

const MIXED_SESSIONS: SessionItem[] = [
  {
    id: "root-sess-001",
    agent: "opencode" as const,
    alias: "main" as const,
    title: "Root session",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    message_count: 3,
    storage: "db" as const,
  },
  {
    id: "child-001",
    agent: "codex" as const,
    alias: "work" as const,
    title: "Verifier",
    created_at: "2024-01-01T01:00:00Z",
    updated_at: "2024-01-01T01:00:00Z",
    message_count: 2,
    storage: "db" as const,
    parentSessionId: "root-sess-001",
  },
  {
    id: "unrelated-001",
    agent: "opencode" as const,
    alias: "main" as const,
    title: "Unrelated root",
    created_at: "2024-01-01T02:00:00Z",
    updated_at: "2024-01-01T02:00:00Z",
    message_count: 5,
    storage: "db" as const,
  },
  {
    id: "grandchild-001",
    agent: "opencode" as const,
    alias: "main" as const,
    title: "Nested fork",
    created_at: "2024-01-01T03:00:00Z",
    updated_at: "2024-01-01T03:00:00Z",
    message_count: 1,
    storage: "db" as const,
    parentSessionId: "child-001",
  },
];

// ============================================================================
// RED imports -- modules do not exist yet.
// Dynamic import defers the error to runtime (MODULE_NOT_FOUND) rather than
// compile-time, keeping TypeScript errors focused on the real gaps.
// ============================================================================
//
// Target signatures to be implemented:
//
//   src/cli/tree.ts
//     export type TreeService = (sessionId: string) => Promise<ForkChainNode[]>;
//     export async function runTreeCommand(opts: {
//       session: string;
//       config?: Config;
//       getForkChain: TreeService;
//     }): Promise<CliResult>
//
//   src/cli/children.ts
//     export type ChildrenService = (parentSessionId: string) => Promise<SessionItem[]>;
//     export async function runChildrenCommand(opts: {
//       parentSessionId: string;
//       config?: Config;
//       getChildren: ChildrenService;
//     }): Promise<CliResult>
//
//   src/cli/list.ts -- extend SessionListQuery with rootsOnly and childrenOf
//
//   src/cli/read.ts -- formatSessionDetail emits parent: <id> when present
//
// ============================================================================

// ============================================================================
// Tests -- oas tree <session-id>
// ============================================================================
describe("oas tree command", () => {

  test("test_tree_command_shows_fork_chain_from_root", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");
    const getForkChain = async (): Promise<ForkChainNode[]> => GRANDCHILD_FORK_CHAIN;

    const result = await runTreeCommand({
      session: "grandchild-001",
      config: baseConfig,
      getForkChain,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("root-sess-001");
    expect(result.stdout).toContain("child-001");
    expect(result.stdout).toContain("grandchild-001");
    expect(result.stdout).toContain("Root orchestration session");
    expect(result.stdout).toContain("Verifier sub-session");
    expect(result.stdout).toContain("Deep verifier fork");
  });

  test("test_tree_command_shows_depth_indentation", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");
    const getForkChain = async (): Promise<ForkChainNode[]> => GRANDCHILD_FORK_CHAIN;

    const result = await runTreeCommand({
      session: "grandchild-001",
      config: baseConfig,
      getForkChain,
    });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);

    const indentCounts = lines.map((line) => {
      const match = line.match(/^(\s*)/);
      return match ? match[1].length : 0;
    });

    // Indentation increases monotonically: root shallowest, leaf deepest
    for (let i = 1; i < indentCounts.length; i++) {
      expect(indentCounts[i]).toBeGreaterThanOrEqual(indentCounts[i - 1]);
    }
    expect(indentCounts[indentCounts.length - 1]).toBeGreaterThan(indentCounts[0]);
  });

  test("test_tree_command_shows_agent_alias_on_each_line", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");
    const getForkChain = async (): Promise<ForkChainNode[]> => GRANDCHILD_FORK_CHAIN;

    const result = await runTreeCommand({
      session: "grandchild-001",
      config: baseConfig,
      getForkChain,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[opencode:main]");
    expect(result.stdout).toContain("[codex:work]");
  });

  test("test_tree_command_shows_session_id_on_each_line", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");
    const getForkChain = async (): Promise<ForkChainNode[]> => GRANDCHILD_FORK_CHAIN;

    const result = await runTreeCommand({
      session: "grandchild-001",
      config: baseConfig,
      getForkChain,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("root-sess-001");
    expect(result.stdout).toContain("child-001");
    expect(result.stdout).toContain("grandchild-001");
  });

  test("test_tree_command_single_node_shows_root_line", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");
    const singleChain: ForkChainNode[] = [
      {
        sessionId: "root-sess-001",
        title: "Root orchestration session",
        agent: "opencode",
        alias: "main",
        depth: 0,
      },
    ];
    const getForkChain = async (): Promise<ForkChainNode[]> => singleChain;

    const result = await runTreeCommand({
      session: "root-sess-001",
      config: baseConfig,
      getForkChain,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("root-sess-001");
    expect(result.stdout).toContain("Root orchestration session");
  });

  test("test_tree_command_returns_error_when_session_not_found", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");
    const getForkChain = async (): Promise<ForkChainNode[]> => [];

    const result = await runTreeCommand({
      session: "does-not-exist",
      config: baseConfig,
      getForkChain,
    });

    expect(result.exitCode).not.toBe(0);
  });

});

// ============================================================================
// Tests -- oas children <session-id>
// ============================================================================
describe("oas children command", () => {

  test("test_children_command_lists_direct_children", async () => {
    const { runChildrenCommand } = await import("../src/cli/children");
    const getChildren = async (): Promise<SessionItem[]> => ROOT_DIRECT_CHILDREN;

    const result = await runChildrenCommand({
      parentSessionId: "root-sess-001",
      config: baseConfig,
      getChildren,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("child-001");
    expect(result.stdout).toContain("child-002");
    expect(result.stdout).toContain("[codex:work]");
    expect(result.stdout).toContain("[claude:team]");
    expect(result.stdout).toContain("Verifier sub-session");
    expect(result.stdout).toContain("Another fork");
  });

  test("test_children_command_empty_when_no_children", async () => {
    const { runChildrenCommand } = await import("../src/cli/children");
    const getChildren = async (): Promise<SessionItem[]> => [];

    const result = await runChildrenCommand({
      parentSessionId: "leaf-session-no-kids",
      config: baseConfig,
      getChildren,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  test("test_children_command_shows_agent_alias_and_title_for_each_child", async () => {
    const { runChildrenCommand } = await import("../src/cli/children");
    const getChildren = async (): Promise<SessionItem[]> => ROOT_DIRECT_CHILDREN;

    const result = await runChildrenCommand({
      parentSessionId: "root-sess-001",
      config: baseConfig,
      getChildren,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[codex:work]");
    expect(result.stdout).toContain("[claude:team]");
    expect(result.stdout).toContain("child-001");
    expect(result.stdout).toContain("child-002");
  });

  test("test_children_command_returns_error_when_parent_not_found", async () => {
    const { runChildrenCommand } = await import("../src/cli/children");
    const getChildren = async (): Promise<SessionItem[]> => {
      throw new Error("Session not found");
    };

    const result = await runChildrenCommand({
      parentSessionId: "nonexistent-parent",
      config: baseConfig,
      getChildren,
    });

    expect(result.exitCode).not.toBe(0);
  });

});

// ============================================================================
// Tests -- oas list --roots-only
//
// The new rootsOnly parameter does not exist in runListCommand yet.
// @ts-ignore defers the TS(2353) compile error until the parameter is added.
// At runtime the call will return unfiltered results (not failing on rootsOnly
// yet), so the assertion on stdout content is what fails -- correct RED signal.
// ============================================================================
describe("oas list --roots-only", () => {

  test("test_list_roots_only_filters_to_root_sessions", async () => {
    const { runListCommand } = await import("../src/cli/list");
    const listService: ListService = async () => ({
      sessions: MIXED_SESSIONS,
      errors: [],
    });

    // @ts-ignore -- rootsOnly does not exist in runListCommand yet
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      rootsOnly: true,
    });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.some((l) => l.includes("root-sess-001"))).toBe(true);
    expect(lines.some((l) => l.includes("unrelated-001"))).toBe(true);
    expect(lines.some((l) => l.includes("child-001"))).toBe(false);
    expect(lines.some((l) => l.includes("grandchild-001"))).toBe(false);
  });

  test("test_list_roots_only_filters_correctly_when_mixed_roots_and_children", async () => {
    const { runListCommand } = await import("../src/cli/list");
    // FIX: mixed roots AND children — this ensures rootsOnly actually filters.
    // Previous test had only roots (no children) so unfiltered==filtered (false pass).
    const mixed: SessionItem[] = [
      {
        id: "root-a", agent: "opencode" as const, alias: "main" as const,
        title: "Session A (root)",
        created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
        message_count: 1, storage: "db" as const,
      },
      {
        id: "child-x", agent: "codex" as const, alias: "work" as const,
        title: "Child X",
        created_at: "2024-01-01T01:00:00Z", updated_at: "2024-01-01T01:00:00Z",
        message_count: 1, storage: "db" as const,
        parentSessionId: "root-a",
      },
    ];
    const listService: ListService = async () => ({ sessions: mixed, errors: [] });

    // @ts-ignore -- rootsOnly does not exist yet
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      rootsOnly: true,
    });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    // Should include root-a only (it's a root), exclude child-x (has parentSessionId)
    expect(lines.some((l) => l.includes("root-a"))).toBe(true);
    expect(lines.some((l) => l.includes("child-x"))).toBe(false);
  });

  test("test_list_roots_only_empty_when_all_are_subagents", async () => {
    const { runListCommand } = await import("../src/cli/list");
    const allSubagents: SessionItem[] = [
      {
        id: "child-x", agent: "codex" as const, alias: "work" as const,
        title: "Child X",
        created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
        message_count: 1, storage: "db" as const,
        parentSessionId: "some-parent",
      },
    ];
    const listService: ListService = async () => ({ sessions: allSubagents, errors: [] });

    // @ts-ignore -- rootsOnly does not exist yet
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      rootsOnly: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No sessions");
  });

});

// ============================================================================
// Tests -- oas list --children-of <session-id>
// ============================================================================
describe("oas list --children-of", () => {

  test("test_list_children_of_filters_correctly", async () => {
    const { runListCommand } = await import("../src/cli/list");
    const listService: ListService = async () => ({
      sessions: MIXED_SESSIONS,
      errors: [],
    });

    // @ts-ignore -- childrenOf does not exist in runListCommand yet
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      childrenOf: "root-sess-001",
    });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.some((l) => l.includes("child-001"))).toBe(true);
    expect(lines.some((l) => l.includes("grandchild-001"))).toBe(false);
    expect(lines.some((l) => l.includes("unrelated-001"))).toBe(false);
    expect(lines.some((l) => l.includes("root-sess-001"))).toBe(false);
  });

  test("test_list_children_of_empty_when_no_children", async () => {
    const { runListCommand } = await import("../src/cli/list");
    const listService: ListService = async () => ({
      sessions: MIXED_SESSIONS,
      errors: [],
    });

    // @ts-ignore -- childrenOf does not exist yet
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      childrenOf: "unrelated-001",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No sessions");
  });

  test("test_list_children_of_returns_only_direct_children_not_grandchildren", async () => {
    const { runListCommand } = await import("../src/cli/list");
    const allSessions: SessionItem[] = [
      { id: "root-001", agent: "opencode" as const, alias: "main" as const,
        title: "Root",
        created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
        message_count: 1, storage: "db" as const },
      { id: "depth-1-a", agent: "codex" as const, alias: "work" as const,
        title: "Depth 1 A",
        created_at: "2024-01-01T01:00:00Z", updated_at: "2024-01-01T01:00:00Z",
        message_count: 1, storage: "db" as const, parentSessionId: "root-001" },
      { id: "depth-1-b", agent: "claude" as const, alias: "team" as const,
        title: "Depth 1 B",
        created_at: "2024-01-01T02:00:00Z", updated_at: "2024-01-01T02:00:00Z",
        message_count: 1, storage: "db" as const, parentSessionId: "root-001" },
      { id: "depth-2", agent: "opencode" as const, alias: "main" as const,
        title: "Depth 2 (grandchild)",
        created_at: "2024-01-01T03:00:00Z", updated_at: "2024-01-01T03:00:00Z",
        message_count: 1, storage: "db" as const, parentSessionId: "depth-1-a" },
    ];
    const listService: ListService = async () => ({ sessions: allSessions, errors: [] });

    // @ts-ignore -- childrenOf does not exist yet
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      childrenOf: "root-001",
    });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    expect(lines.some((l) => l.includes("depth-1-a"))).toBe(true);
    expect(lines.some((l) => l.includes("depth-1-b"))).toBe(true);
    expect(lines.some((l) => l.includes("depth-2"))).toBe(false);
  });

});

// ============================================================================
// Tests -- oas read shows parent info
// ============================================================================
describe("oas read shows parent info when present", () => {

  test("test_read_shows_parent_info_when_present", async () => {
    // @ts-ignore -- ReadService is a type-only import
    const { runReadCommand } = await import("../src/cli/read");
    const getSession: Parameters<typeof runReadCommand>[0] extends { getSession: infer S } ? S : never = async () => CHILD_SESSION;

    const result = await runReadCommand({
      session: "child-001",
      config: baseConfig,
      getSession,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("parent");
    expect(result.stdout).toContain("root-sess-001");
  });

  test("test_read_does_not_show_parent_field_when_root_session", async () => {
    // @ts-ignore -- ReadService is a type-only import
    const { runReadCommand } = await import("../src/cli/read");
    const getSession: Parameters<typeof runReadCommand>[0] extends { getSession: infer S } ? S : never = async () => ROOT_SESSION;

    const result = await runReadCommand({
      session: "root-sess-001",
      config: baseConfig,
      getSession,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("parent:");
  });

  test("test_read_json_format_includes_parent_session_id", async () => {
    // @ts-ignore -- ReadService is a type-only import
    const { runReadCommand } = await import("../src/cli/read");
    const getSession: Parameters<typeof runReadCommand>[0] extends { getSession: infer S } ? S : never = async () => CHILD_SESSION;

    const result = await runReadCommand({
      session: "child-001",
      config: baseConfig,
      getSession,
      format: "json",
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.session.parentSessionId).toBe("root-sess-001");
  });

  test("test_read_json_format_root_session_has_no_parent_session_id", async () => {
    // @ts-ignore -- ReadService is a type-only import
    const { runReadCommand } = await import("../src/cli/read");
    const getSession: Parameters<typeof runReadCommand>[0] extends { getSession: infer S } ? S : never = async () => ROOT_SESSION;

    const result = await runReadCommand({
      session: "root-sess-001",
      config: baseConfig,
      getSession,
      format: "json",
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.session.parentSessionId).toBeUndefined();
  });

});

// ============================================================================
// Tests -- SessionSummary needs parentSessionId field
// The SessionItem type alias above is the source of truth for what the
// ListService returns. If parentSessionId is not on SessionSummary,
// TypeScript will error (TS(2322)) on the fixture assignments, which is
// the correct RED signal -- the field must be added first.
// ============================================================================
describe("SessionSummary type needs parentSessionId for fork awareness", () => {

  test("test_session_summary_type_has_optional_parent_session_id", () => {
    // Runtime sanity check that the inferred type includes parentSessionId
    const item: SessionItem = {
      id: "test-001",
      agent: "opencode" as const,
      alias: "main" as const,
      title: "Test",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      message_count: 0,
      storage: "db" as const,
      parentSessionId: "parent-001",
    };
    expect(item.parentSessionId).toBe("parent-001");
  });

  test("test_session_summary_parent_session_id_is_optional", () => {
    const item: SessionItem = {
      id: "root-001",
      agent: "opencode" as const,
      alias: "main" as const,
      title: "Root",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      message_count: 1,
      storage: "db" as const,
      // No parentSessionId -- compiles only if field is truly optional
    };
    expect(item.parentSessionId).toBeUndefined();
  });

});

// ============================================================================
// Tests -- buildForkChain utility (already implemented, verify correctness)
// ============================================================================
describe("buildForkChain subagent utility", () => {

  test("test_build_fork_chain_returns_chain_from_root_to_leaf", async () => {
    const { buildForkChain } = await import("../src/core/subagents");

    const session = {
      id: "grandchild-001" as const,
      parentSessionId: "child-001" as const,
      agent: "opencode" as const,
      alias: "main" as const,
      title: "Deep verifier fork",
    };

    const resolveParent = (id: string) => {
      if (id === "child-001") {
        return {
          id: "child-001" as const,
          parentSessionId: "root-sess-001" as const,
          agent: "codex" as const,
          alias: "work" as const,
          title: "Verifier sub-session",
        };
      }
      if (id === "root-sess-001") {
        return {
          id: "root-sess-001" as const,
          parentSessionId: undefined,
          agent: "opencode" as const,
          alias: "main" as const,
          title: "Root orchestration session",
        };
      }
      return null;
    };

    const chain = buildForkChain(session, resolveParent);

    expect(chain.length).toBe(3);
    // Output: root first (depth=2), leaf last (depth=0)
    // depth = distance from LEAF / starting node
    expect(chain[0].sessionId).toBe("root-sess-001");
    expect(chain[0].depth).toBe(2);   // root = deepest ancestor = max depth
    expect(chain[1].sessionId).toBe("child-001");
    expect(chain[1].depth).toBe(1);
    expect(chain[2].sessionId).toBe("grandchild-001");
    expect(chain[2].depth).toBe(0);   // leaf / starting point = depth 0
  });

  test("test_build_fork_chain_single_node_for_root_session", async () => {
    const { buildForkChain } = await import("../src/core/subagents");

    const root = {
      id: "root-sess-001" as const,
      parentSessionId: undefined,
      agent: "opencode" as const,
      alias: "main" as const,
      title: "Root session",
    };

    const resolveParent = (_id: string) => null;
    const chain = buildForkChain(root, resolveParent);

    expect(chain.length).toBe(1);
    expect(chain[0].sessionId).toBe("root-sess-001");
    expect(chain[0].depth).toBe(0);  // root = leaf = only node = depth 0
    expect(chain[0].parentSessionId).toBeUndefined();
  });

  test("test_build_fork_chain_depth_increments_per_generation", async () => {
    const { buildForkChain } = await import("../src/core/subagents");

    const leaf = {
      id: "gen-4" as const,
      parentSessionId: "gen-3" as const,
      agent: "opencode" as const,
      alias: "main" as const,
      title: "Gen 4",
    };

    const resolveParent = (id: string) => {
      if (id === "gen-3") {
        return { id: "gen-3", parentSessionId: "gen-2", agent: "opencode", alias: "main", title: "Gen 3" };
      }
      if (id === "gen-2") {
        return { id: "gen-2", parentSessionId: "gen-1", agent: "opencode", alias: "main", title: "Gen 2" };
      }
      if (id === "gen-1") {
        return { id: "gen-1", parentSessionId: undefined, agent: "opencode", alias: "main", title: "Gen 1" };
      }
      return null;
    };

    const chain = buildForkChain(leaf, resolveParent);

    expect(chain.length).toBe(4);
    // Output: root first (depth=3), leaf last (depth=0)
    expect(chain[0].sessionId).toBe("gen-1");
    expect(chain[0].depth).toBe(3);   // root = deepest ancestor
    expect(chain[3].sessionId).toBe("gen-4");
    expect(chain[3].depth).toBe(0);   // leaf = starting point
  });

});

// ============================================================================
// Zone 1: Edge cases for tree command
// ============================================================================
describe("oas tree — edge cases (Zone 1)", () => {

  test("test_tree_with_single_root_and_no_children", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");
    const singleChain: ForkChainNode[] = [
      {
        sessionId: "root-only-001",
        title: "Orphan root session",
        agent: "opencode",
        alias: "main",
        depth: 0,
      },
    ];
    const getForkChain = async (): Promise<ForkChainNode[]> => singleChain;

    const result = await runTreeCommand({
      session: "root-only-001",
      config: baseConfig,
      getForkChain,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("root-only-001");
    expect(result.stdout).toContain("Orphan root session");
    // No indentation (single node = root with depth=0)
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
  });

  test("test_tree_json_format_returns_structured_output", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");
    const chain: ForkChainNode[] = [
      {
        sessionId: "root-json",
        title: "Root JSON test",
        agent: "opencode",
        alias: "main",
        depth: 1,
        parentSessionId: undefined,
      },
      {
        sessionId: "child-json",
        title: "Child JSON test",
        agent: "codex",
        alias: "work",
        depth: 0,
        parentSessionId: "root-json",
      },
    ];
    const getForkChain = async (): Promise<ForkChainNode[]> => chain;

    // @ts-ignore -- json format flag may not be implemented yet
    const result = await runTreeCommand({
      session: "child-json",
      config: baseConfig,
      getForkChain,
      format: "json",
    });

    // RED: tree command with --format json should return structured JSON
    expect(result.exitCode).toBe(0);
    expect(() => {
      JSON.parse(result.stdout);
    }).not.toThrow();
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed) || typeof parsed === "object").toBe(true);
  });

  test("test_tree_command_circular_reference_handles_gracefully", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");
    // Simulate a circular chain: A→B→C→A (cycle)
    const circularChain: ForkChainNode[] = [
      {
        sessionId: "node-a",
        title: "Node A",
        agent: "opencode",
        alias: "main",
        depth: 2,
        parentSessionId: "node-c",
      },
      {
        sessionId: "node-b",
        title: "Node B",
        agent: "codex",
        alias: "work",
        depth: 1,
        parentSessionId: "node-a",
      },
      {
        sessionId: "node-c",
        title: "Node C",
        agent: "opencode",
        alias: "main",
        depth: 0,
        parentSessionId: "node-b",
      },
    ];
    const getForkChain = async (): Promise<ForkChainNode[]> => circularChain;

    // RED: circular reference should handle gracefully without crash
    const result = await runTreeCommand({
      session: "node-c",
      config: baseConfig,
      getForkChain,
    });

    // Should not crash — either exitCode 0 with output, or exitCode 1 with error
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Zone 2: Edge cases for children command
// ============================================================================
describe("oas children — edge cases (Zone 2)", () => {

  test("test_children_command_shows_parent_agent_and_alias", async () => {
    const { runChildrenCommand } = await import("../src/cli/children");
    const children: SessionItem[] = [
      {
        id: "child-001",
        agent: "codex" as const,
        alias: "work" as const,
        title: "Verifier sub-session",
        created_at: "2024-01-01T01:30:00Z",
        updated_at: "2024-01-01T02:00:00Z",
        message_count: 2,
        storage: "db" as const,
        parentSessionId: "root-sess-001",
      },
    ];
    const getChildren = async (): Promise<SessionItem[]> => children;

    const result = await runChildrenCommand({
      parentSessionId: "root-sess-001",
      config: baseConfig,
      getChildren,
    });

    expect(result.exitCode).toBe(0);
    // Should show agent:alias on each child line
    expect(result.stdout).toContain("[codex:work]");
  });

  test("test_children_command_json_format", async () => {
    const { runChildrenCommand } = await import("../src/cli/children");
    const children: SessionItem[] = [
      {
        id: "child-x",
        agent: "opencode" as const,
        alias: "main" as const,
        title: "Child X",
        created_at: "2024-01-01T01:00:00Z",
        updated_at: "2024-01-01T01:00:00Z",
        message_count: 1,
        storage: "db" as const,
        parentSessionId: "root-001",
      },
    ];
    const getChildren = async (): Promise<SessionItem[]> => children;

    // @ts-ignore -- json format may not be implemented
    const result = await runChildrenCommand({
      parentSessionId: "root-001",
      config: baseConfig,
      getChildren,
      format: "json",
    });

    // RED: children command should support --format json
    expect(result.exitCode).toBe(0);
    expect(() => {
      JSON.parse(result.stdout);
    }).not.toThrow();
  });

  test("test_children_command_large_number_of_children", async () => {
    const { runChildrenCommand } = await import("../src/cli/children");
    const manyChildren: SessionItem[] = Array.from({ length: 50 }, (_, i) => ({
      id: `child-${String(i).padStart(3, "0")}`,
      agent: "opencode" as const,
      alias: "main" as const,
      title: `Child ${i}`,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      message_count: 1,
      storage: "db" as const,
      parentSessionId: "root-001",
    }));
    const getChildren = async (): Promise<SessionItem[]> => manyChildren;

    const result = await runChildrenCommand({
      parentSessionId: "root-001",
      config: baseConfig,
      getChildren,
    });

    expect(result.exitCode).toBe(0);
    // All 50 children should appear
    expect(result.stdout).toContain("child-000");
    expect(result.stdout).toContain("child-049");
  });
});

// ============================================================================
// Zone 3: Cross-feature interactions
// ============================================================================
describe("fork hierarchy cross-feature interactions (Zone 3)", () => {

  test("test_read_shows_child_agent_info_when_present", async () => {
    // @ts-ignore -- ReadService is a type-only import
    const { runReadCommand } = await import("../src/cli/read");
    const childSession: SessionDetail = {
      id: "child-agent-001",
      agent: "codex",
      alias: "work",
      title: "Verifier session",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      message_count: 2,
      storage: "db",
      messages: [],
      parentSessionId: "root-session-001",
    };
    const getSession: Parameters<typeof runReadCommand>[0] extends { getSession: infer S } ? S : never = async () => childSession;

    const result = await runReadCommand({
      session: "child-agent-001",
      config: baseConfig,
      getSession,
    });

    expect(result.exitCode).toBe(0);
    // Should show the agent:alias of the child
    expect(result.stdout).toContain("[codex:work]");
    expect(result.stdout).toContain("parent");
    expect(result.stdout).toContain("root-session-001");
  });

  test("test_list_roots_only_with_mixed_storage_types", async () => {
    const { runListCommand } = await import("../src/cli/list");
    const mixedStorage: SessionItem[] = [
      {
        id: "root-db", agent: "opencode" as const, alias: "main" as const,
        title: "DB root", created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        message_count: 1, storage: "db" as const,
      },
      {
        id: "root-jsonl", agent: "codex" as const, alias: "work" as const,
        title: "JSONL root", created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        message_count: 1, storage: "jsonl" as const,
      },
      {
        id: "child-db", agent: "claude" as const, alias: "team" as const,
        title: "DB child", created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        message_count: 1, storage: "db" as const,
        parentSessionId: "root-db",
      },
    ];
    const listService: ListService = async () => ({ sessions: mixedStorage, errors: [] });

    // @ts-ignore -- rootsOnly does not exist yet
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      rootsOnly: true,
    });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    // Both roots (db and jsonl) should appear
    expect(lines.some((l) => l.includes("root-db"))).toBe(true);
    expect(lines.some((l) => l.includes("root-jsonl"))).toBe(true);
    // Child should NOT appear
    expect(lines.some((l) => l.includes("child-db"))).toBe(false);
  });
});
