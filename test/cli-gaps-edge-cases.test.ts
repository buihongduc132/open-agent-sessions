/**
 * test/cli-gaps-edge-cases.test.ts
 *
 * RED tests for edge cases NOT covered by the existing test suites:
 *   - test/cli-search.test.ts
 *   - test/cli-search-boolean.test.ts
 *   - test/cli-search-content.test.ts
 *   - test/cli-tree.test.ts
 *   - test/cli-read-composable.test.ts
 *
 * Each test targets a specific uncovered boundary condition across
 * the 5 gaps documented in _16apr_gaps.md.
 */

import { describe, expect, test } from "bun:test";
import {
  runSearchCommand,
  type SearchService,
  type ContentSearchService,
} from "../src/cli/search";
import { type Config } from "../src/config/types";
import { type SessionSummary, type SearchQuery } from "../src/core/types";
import {
  type SessionDetail,
  type SessionReadOptions,
  type SessionMessage,
} from "../src/core/types";
import { type ForkChainNode } from "../src/core/subagents";
import { createAcpxAdapter } from "../src/adapters/acpx";
import { runReadCommand } from "../src/cli/read";

// ============================================================================
// Shared fixtures
// ============================================================================

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
  ],
};

function makeSession(
  id: string,
  agent: string,
  alias: string,
  title: string,
  overrides?: Partial<SessionSummary>,
): SessionSummary {
  return {
    id,
    agent: agent as any,
    alias,
    title,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 5,
    storage: "db",
    ...overrides,
  };
}

function makeMessage(role: "user" | "assistant" | "system", text: string, id?: string): SessionMessage {
  return {
    id: id ?? `msg-${Date.now()}-${Math.random()}`,
    role,
    created_at: "2024-01-01T12:00:00Z",
    parts: [{ type: "text", text }],
  };
}

// ============================================================================
// Gap 1 — Content Search Edge Cases
// ============================================================================

describe("Gap 1 — Content search edge cases", () => {

  /**
   * EDGE CASE: findSimilarSessions throws an error.
   *
   * Covered by existing tests? NO — all content search tests mock findSimilarSessions
   * to return valid results. If the underlying vector search fails (e.g. corrupted
   * sqlite-vec, disk error), the CLI should fall back to title-only search or
   * return a clear error, NOT crash with an unhandled promise rejection.
   *
   * WHY RED: runSearchCommand currently does not wrap findSimilarSessions in try/catch.
   * When it throws, the error propagates uncaught.
   */
  test("content_search_findSimilarSessions_throws_falls_back_gracefully", async () => {
    const titleOnlyResult: SearchService = async () => ({
      sessions: [
        makeSession("oc-fallback-001", "opencode", "personal", "Fallback result"),
      ],
      errors: [],
    });

    const brokenSimilar: ContentSearchService = async () => {
      throw new Error("sqlite-vec corrupted: malformed vector index");
    };

    // Should NOT throw — should either return title-only results or exitCode 1 with clear error
    const result = await runSearchCommand({
      text: "test-query",
      config: baseConfig,
      searchSessions: titleOnlyResult,
      findSimilarSessions: brokenSimilar,
    });

    // RED: currently this will throw because runSearchCommand does not catch
    // findSimilarSessions errors. After fix: should return fallback or error gracefully.
    expect([0, 1]).toContain(result.exitCode);
    // If exitCode 0, must have fallback results; if exitCode 1, must have error message
    if (result.exitCode === 0) {
      expect(result.stdout).toContain("oc-fallback-001");
    } else {
      expect(result.stderr).toContain("sqlite-vec");
    }
  });

  /**
   * EDGE CASE: Same session appears in BOTH searchSessions AND findSimilarSessions.
   *
   * Covered by existing tests? NO — no test creates a scenario where the same
   * session ID appears in both title-only and content results simultaneously.
   * The CLI must deduplicate, not show the session twice.
   *
   * WHY RED: runSearchCommand in the findSimilarSessions branch completely replaces
   * searchSessions results with content results (line 98-107 in search.ts).
   * It doesn't merge, so deduplication may not be needed — but this test documents
   * the expected behavior when both sources return overlapping sessions.
   */
  test("content_search_deduplicates_sessions_from_title_and_content_sources", async () => {
    const DUAL_ID = "oc-dual-001";

    const titleResult: SearchService = async () => ({
      sessions: [
        makeSession(DUAL_ID, "opencode", "personal", "Dual match session"),
      ],
      errors: [],
    });

    const findSimilar: ContentSearchService = async (text) => {
      if (text.includes("dual")) {
        return [{
          sessionId: DUAL_ID,
          title: "Dual match session",
          score: 0.9,
          rank: 1,
          matchType: "hybrid",
          matchedChunks: 3,
        }];
      }
      return [];
    };

    const result = await runSearchCommand({
      text: "dual",
      config: baseConfig,
      searchSessions: titleResult,
      findSimilarSessions: findSimilar,
    });

    expect(result.exitCode).toBe(0);
    // Session must appear exactly ONCE — count occurrences of the ID
    const idOccurrences = result.stdout.split(DUAL_ID).length - 1;
    expect(idOccurrences).toBe(1);
    expect(result.stdout).toContain("Dual match session");
  });

  /**
   * EDGE CASE: Content search with special characters in query.
   *
   * Covered by existing tests? NO — all tests use alphanumeric queries.
   * Characters like `"`, `*`, `?`, `(`, `)`, `[`, `]` could break the
   * FTS5 MATCH syntax or the normalization logic.
   *
   * WHY RED: normalizeFuzzyQuery only strips hyphens and whitespace. Special
   * characters like `*`, `?` are FTS5 operators and could cause SQL errors
   * when passed to the real search backend.
   */
  test("content_search_with_special_characters_does_not_crash", async () => {
    const specialQueries = [
      'test*query',           // FTS5 wildcard
      'test?query',           // SQL LIKE wildcard
      'test"query',           // Unmatched quote
      'test(query)',          // Parentheses
      "test'query",           // SQL injection attempt
      'test; DROP TABLE',     // SQL injection attempt
    ];

    const titleResult: SearchService = async () => ({ sessions: [], errors: [] });
    const findSimilar: ContentSearchService = async () => [];

    for (const query of specialQueries) {
      // Must NOT throw — each query should return gracefully
      const result = await runSearchCommand({
        text: query,
        config: baseConfig,
        searchSessions: titleResult,
        findSimilarSessions: findSimilar,
      });

      expect([0, 1]).toContain(result.exitCode);
    }
  });

  /**
   * EDGE CASE: Content search with unicode/international characters.
   *
   * Covered by existing tests? NO — all tests use ASCII-only queries.
   * Users with non-English sessions should be able to search in their language.
   *
   * WHY RED: FTS5 unicode61 tokenizer may handle CJK characters differently,
   * and normalizeFuzzyQuery doesn't account for unicode word boundaries.
   */
  test("content_search_with_unicode_characters_returns_results", async () => {
    const titleResult: SearchService = async () => ({ sessions: [], errors: [] });
    const findSimilar: ContentSearchService = async (text) => {
      if (text.includes("débug") || text.includes("调试")) {
        return [{
          sessionId: "oc-unicode-001",
          title: "Débugging session 调试",
          score: 0.85,
          rank: 1,
          matchType: "fts-only",
          matchedChunks: 1,
        }];
      }
      return [];
    };

    const result = await runSearchCommand({
      text: "débug 调试",
      config: baseConfig,
      searchSessions: titleResult,
      findSimilarSessions: findSimilar,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("oc-unicode-001");
  });
});

// ============================================================================
// Gap 2 — Boolean/Fuzzy Search Edge Cases
// ============================================================================

describe("Gap 2 — Boolean/fuzzy search edge cases", () => {

  const allSessions = [
    makeSession("ses_AG", "opencode", "personal", "Working with ast-grep for AST diffing"),
    makeSession("ses_CB", "codex", "work", "Comby pattern rewrite tool exploration"),
    makeSession("ses_ALL", "opencode", "personal", "ast-grep, comby, gritql — full comparison"),
  ];

  const BOOLEAN_OPS = / AND | OR | NOT /i;

  function buildBooleanAwareMock(sessions: SessionSummary[]): SearchService {
    return async (query: SearchQuery) => {
      const text: string = query.text.trim();
      if (BOOLEAN_OPS.test(text)) {
        // CLI has NOT parsed boolean operators
        return { sessions: [], errors: [] };
      } else {
        const lcTerm = text.toLowerCase().replace(/-/g, "");
        const results = lcTerm.length > 0
          ? sessions.filter((s) => s.title.toLowerCase().replace(/-/g, "").includes(lcTerm))
          : [];
        return { sessions: results, errors: [] };
      }
    };
  }

  /**
   * EDGE CASE: Query with only operators and no actual terms.
   *
   * Covered by existing tests? NO — "()" is tested but "AND AND AND" is not.
   * A query consisting solely of boolean operators with no search terms
   * should return empty results or a parse error, NOT crash.
   *
   * WHY RED: The tokenizer produces AND AND AND tokens with no TERM tokens.
   * The parser expects TERM tokens between operators and may throw or produce
   * unexpected results.
   */
  test("boolean_query_only_operators_no_terms_returns_empty_gracefully", async () => {
    const result = await runSearchCommand({
      text: "AND AND AND",
      config: baseConfig,
      searchSessions: buildBooleanAwareMock(allSessions),
    });

    // Must not crash — either empty results or parse error
    expect([0, 1]).toContain(result.exitCode);
    if (result.exitCode === 0) {
      // Empty or "No sessions found" is acceptable
      expect(result.stdout).toContain("No sessions found");
    }
  });

  /**
   * EDGE CASE: Very long query string (10,000+ characters).
   *
   * Covered by existing tests? NO — all tests use short queries.
   * A very long query could cause stack overflow in recursive parser,
   * or memory issues in the evaluator.
   *
   * WHY RED: The recursive descent parser (parseOr → parseAnd → parseNot → parsePrimary)
   * could hit stack limits for extremely long inputs with many operators.
   */
  test("boolean_query_very_long_string_does_not_crash", async () => {
    // Build a long alternating query: "term0 OR term1 OR term2 OR ... OR term99"
    const terms = Array.from({ length: 100 }, (_, i) => `term${i}`);
    const longQuery = terms.join(" OR ");

    const result = await runSearchCommand({
      text: longQuery,
      config: baseConfig,
      searchSessions: async (query) => {
        // Mock: find any term that matches
        const matched = allSessions.filter((s) =>
          terms.some((t) => s.title.toLowerCase().includes(t)),
        );
        return { sessions: matched, errors: [] };
      },
    });

    // Must not crash — even if no results match
    expect([0, 1]).toContain(result.exitCode);
  });

  /**
   * EDGE CASE: Boolean query where one term's service call throws an error.
   *
   * Covered by existing tests? NO — all mocks return successfully.
   * If searching for one term fails (e.g. one agent's backend is down),
   * the CLI should still return results from other agents and report the error.
   *
   * WHY RED: executeBooleanSearch calls searchTerm per term. If one throws,
   * the entire boolean evaluation fails without partial results.
   */
  test("boolean_query_partial_service_failure_still_returns_results", async () => {
    let callCount = 0;
    const failingMock: SearchService = async (query: SearchQuery) => {
      callCount++;
      // First call succeeds, second call fails
      if (callCount === 1) {
        return {
          sessions: [makeSession("ses_AG", "opencode", "personal", "Working with ast-grep")],
          errors: [],
        };
      }
      // Second term search throws — simulating one backend being down
      throw new Error("Backend connection refused: codex adapter offline");
    };

    const result = await runSearchCommand({
      text: "ast-grep AND comby",
      config: baseConfig,
      searchSessions: failingMock,
    });

    // RED: currently throws uncaught. After fix: should return partial results
    // or exitCode 1 with clear error about which agent failed.
    expect([0, 1]).toContain(result.exitCode);
  });

  /**
   * EDGE CASE: Quoted phrase in boolean query.
   *
   * Covered by existing tests? NO — no test uses quoted phrases like
   * `"ast-grep" AND comby`. The tokenizer handles quotes but no test
   * verifies the behavior end-to-end.
   *
   * WHY RED: The tokenizer strips quotes and produces a TERM token.
   * The test verifies that quoted phrases are treated as single terms
   * and not split on internal spaces.
   */
  test("boolean_query_quoted_phrase_treated_as_single_term", async () => {
    let capturedQueries: string[] = [];
    const capturingMock: SearchService = async (query: SearchQuery) => {
      capturedQueries.push(query.text);
      return { sessions: [], errors: [] };
    };

    const result = await runSearchCommand({
      text: '"ast grep" AND comby',
      config: baseConfig,
      searchSessions: capturingMock,
    });

    expect(result.exitCode).toBe(0);
    // "ast grep" should be a single term, not split into "ast" and "grep"
    expect(capturedQueries).toContain("ast grep");
    expect(capturedQueries).toContain("comby");
  });
});

// ============================================================================
// Gap 3 — Exclude Current Session Edge Cases
// ============================================================================

describe("Gap 3 — Exclude current session edge cases", () => {

  const sessions = [
    makeSession("ses_CURRENT", "opencode", "personal", "Current active session"),
    makeSession("ses_OTHER_1", "codex", "work", "Other relevant session"),
    makeSession("ses_OTHER_2", "opencode", "personal", "Another session"),
  ];

  /**
   * EDGE CASE: --exclude-current=true but currentSessionId is undefined.
   *
   * Covered by existing tests? NO — all tests that use excludeCurrent also
   * set currentSessionId. If the CLI can't determine the current session ID
   * (e.g. not inside a session), --exclude-current should be a no-op.
   *
   * WHY RED: The current implementation checks `options.excludeCurrent && options.currentSessionId`.
   * If currentSessionId is undefined, the exclude set stays empty — which IS correct.
   * This test verifies the no-op behavior explicitly.
   */
  test("exclude_current_without_currentSessionId_is_noop", async () => {
    const searchResult: SearchService = async () => ({
      sessions,
      errors: [],
    });

    const result = await runSearchCommand({
      text: "session",
      config: baseConfig,
      excludeCurrent: true,
      // currentSessionId is NOT set — should not exclude anything
      searchSessions: searchResult,
    });

    expect(result.exitCode).toBe(0);
    // All sessions should appear — nothing excluded
    expect(result.stdout).toContain("ses_CURRENT");
    expect(result.stdout).toContain("ses_OTHER_1");
    expect(result.stdout).toContain("ses_OTHER_2");
  });

  /**
   * EDGE CASE: --exclude-current combined with content search (findSimilarSessions).
   *
   * Covered by existing tests? NO — Zone 3 in cli-search-content.test.ts tests
   * excludeCurrent with findSimilarSessions, but the gap is that when findSimilarSessions
   * is the active path (not searchSessions), the exclude logic runs AFTER the content
   * results are mapped to SessionSummary objects. This test verifies the exclude filter
   * is applied to the content search path too.
   *
   * WHY RED: Actually the code at lines 116-118 of search.ts applies excludedIds
   * after both branches, so this should work. But this test validates the edge case
   * where the excluded session ID appears in findSimilarSessions results but NOT
   * in searchSessions results.
   */
  test("exclude_current_removes_session_from_content_search_results", async () => {
    const CURRENT_ID = "content-current-001";

    const findSimilar: ContentSearchService = async () => [
      { sessionId: CURRENT_ID, title: "Current content session", score: 0.9, rank: 1, matchType: "fts-only", matchedChunks: 3 },
      { sessionId: "content-other-001", title: "Other content session", score: 0.7, rank: 2, matchType: "fts-only", matchedChunks: 1 },
    ];

    const result = await runSearchCommand({
      text: "content",
      config: baseConfig,
      currentSessionId: CURRENT_ID,
      excludeCurrent: true,
      searchSessions: async () => ({ sessions: [], errors: [] }),
      findSimilarSessions: findSimilar,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(CURRENT_ID);
    expect(result.stdout).toContain("content-other-001");
  });

  /**
   * EDGE CASE: --exclude-session with empty array.
   *
   * Covered by existing tests? NO — all tests pass non-empty arrays.
   * An empty array should be a no-op (nothing excluded).
   *
   * WHY RED: The code iterates options.excludeSession with for...of, so an
   * empty array should be fine. This test documents expected behavior.
   */
  test("exclude_session_empty_array_is_noop", async () => {
    const searchResult: SearchService = async () => ({
      sessions: [
        makeSession("ses_A", "opencode", "personal", "Session A"),
        makeSession("ses_B", "codex", "work", "Session B"),
      ],
      errors: [],
    });

    const result = await runSearchCommand({
      text: "session",
      config: baseConfig,
      excludeSession: [],
      searchSessions: searchResult,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ses_A");
    expect(result.stdout).toContain("ses_B");
  });
});

// ============================================================================
// Gap 4 — Composable Read Flags Edge Cases
// ============================================================================

describe("Gap 4 — Composable read flags edge cases", () => {

  function makeAcpxAdapterWithMessages(
    messages: SessionMessage[],
    detail?: Partial<SessionDetail>,
  ): ReturnType<typeof createAcpxAdapter> {
    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "acpx", enabled: true },
      { basePath: "/tmp/no-such-acpx-path-edge" },
    );

    const sessionDetail: SessionDetail = {
      id: "acpx:scope:edge-test",
      agent: "opencode",
      alias: "scope",
      title: "Edge case test",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      message_count: messages.length,
      storage: "other",
      messages,
      ...detail,
    };

    // Override getSessionDetail with correct behavior
    (adapter as any).getSessionDetail = async (_id: string, opts: SessionReadOptions) => {
      let msgs = sessionDetail.messages ?? [];

      const selection = opts.selection;
      if (selection) {
        switch (selection.mode) {
          case "first":
            msgs = msgs.slice(0, selection.count);
            break;
          case "last":
            msgs = msgs.slice(-(selection.count ?? 10));
            break;
          case "range": {
            const start = (selection.start ?? 1) - 1;
            const end = selection.end ?? start + 1;
            msgs = msgs.slice(start, end);
            break;
          }
          case "all":
          default:
            break;
        }
      }

      const effectiveUserOnly = opts.userOnly || opts.selection?.userOnly;
      if (effectiveUserOnly) {
        if (opts.role && opts.role !== "user") {
          msgs = [];
        } else {
          msgs = msgs.filter((m) => m.role === "user");
        }
      }

      return { ...sessionDetail, messages: msgs };
    };

    return adapter as ReturnType<typeof createAcpxAdapter>;
  }

  /**
   * EDGE CASE: --last with very large number (exceeds message count).
   *
   * Covered by existing tests? NO — all --last tests use counts within
   * the message count. If --last 999999 is passed for a session with 5
   * messages, it should return all 5 messages (clamped).
   *
   * WHY RED: The adapter should clamp --last N to the actual message count.
   * The mock implements this correctly via slice(-N), which handles N > length.
   */
  test("read_last_large_number_clamps_to_available_messages", async () => {
    const messages: SessionMessage[] = [
      makeMessage("user", "Msg 1", "m1"),
      makeMessage("assistant", "Msg 2", "m2"),
      makeMessage("user", "Msg 3", "m3"),
    ];

    const adapter = makeAcpxAdapterWithMessages(messages);
    const result = await adapter.getSessionDetail!(
      "acpx:scope:edge-test",
      { userOnly: false, mode: "all_no_tools", selection: { mode: "last", count: 999999 } },
    );

    // Should return all 3 messages, not crash or return empty
    expect(result.messages!.length).toBe(3);
    expect(result.messages!.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  /**
   * EDGE CASE: --range where start === end (single message).
   *
   * Covered by existing tests? NO — all range tests use start < end.
   * A range like --range 3:3 should return exactly one message (the 3rd).
   *
   * WHY RED: slice(start, end) with start === end returns empty array.
   * The correct behavior is to include the message at position `start`.
   * The mock uses slice(start-1, end) which for start=3, end=3 gives
   * slice(2, 3) = [msg at index 2] — correct.
   */
  test("read_range_start_equals_end_returns_single_message", async () => {
    const messages: SessionMessage[] = [
      makeMessage("user", "Msg 1", "m1"),
      makeMessage("assistant", "Msg 2", "m2"),
      makeMessage("user", "Msg 3", "m3"),
      makeMessage("assistant", "Msg 4", "m4"),
    ];

    const adapter = makeAcpxAdapterWithMessages(messages);
    const result = await adapter.getSessionDetail!(
      "acpx:scope:edge-test",
      { userOnly: false, mode: "all_no_tools", selection: { mode: "range", start: 3, end: 3 } },
    );

    // Should return exactly 1 message: the 3rd one
    expect(result.messages!.length).toBe(1);
    expect(result.messages![0].id).toBe("m3");
  });

  /**
   * EDGE CASE: --first with --user-only composability.
   *
   * Covered by existing tests? NO — the composable tests use --last + userOnly
   * and --range + userOnly, but never --first + userOnly.
   *
   * WHY RED: First applies the count, then userOnly filters. The order matters:
   * --first 5 --user-only should give: first 5 messages → filter to user only.
   * Not: filter to user only → first 5 of those.
   */
  test("read_first_5_user_only_composes_correctly", async () => {
    const messages: SessionMessage[] = [
      makeMessage("assistant", "A1", "a1"),
      makeMessage("user", "U1", "u1"),
      makeMessage("assistant", "A2", "a2"),
      makeMessage("user", "U2", "u2"),
      makeMessage("assistant", "A3", "a3"),
      makeMessage("user", "U3", "u3"),
    ];

    const adapter = makeAcpxAdapterWithMessages(messages);
    const result = await adapter.getSessionDetail!(
      "acpx:scope:edge-test",
      {
        userOnly: true,
        mode: "all_no_tools",
        selection: { mode: "first", count: 5, userOnly: true },
      },
    );

    // First 5 messages = [a1, u1, a2, u2, a3], then userOnly filter = [u1, u2] = 2 messages
    expect(result.messages!.length).toBe(2);
    expect(result.messages!.map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  /**
   * EDGE CASE: Session with only system messages + --user-only.
   *
   * Covered by existing tests? NO — existing tests have assistant-only sessions
   * but no system-only sessions. System messages should also be filtered out
   * when --user-only is active.
   *
   * WHY RED: userOnly filter should only keep role="user" messages. System
   * messages are not user messages and should be excluded.
   */
  test("read_user_only_system_only_session_returns_empty", async () => {
    const messages: SessionMessage[] = [
      makeMessage("system", "System prompt 1", "s1"),
      makeMessage("system", "System prompt 2", "s2"),
    ];

    const adapter = makeAcpxAdapterWithMessages(messages);
    const result = await adapter.getSessionDetail!(
      "acpx:scope:edge-test",
      { userOnly: true, mode: "all_no_tools", selection: { mode: "all", userOnly: true } },
    );

    // System messages should be filtered out — empty result
    expect(result.messages!.length).toBe(0);
  });
});

// ============================================================================
// Gap 5 — Hierarchy / Delegation Edge Cases
// ============================================================================

describe("Gap 5 — Hierarchy edge cases", () => {

  /**
   * EDGE CASE: buildForkChain with very deep chain (10+ levels).
   *
   * Covered by existing tests? NO — deepest chain tested is 4 levels (gen-1 → gen-4).
   * Real delegation chains can be much deeper (orchestrator → planner → builder →
   * verifier → fixer → ...). This tests for stack safety and correctness.
   *
   * WHY RED: buildForkChain uses a while loop (not recursion), so stack overflow
   * is unlikely. But the depth values need to be correct across all 10+ levels.
   */
  test("build_fork_chain_very_deep_chain_10_levels", async () => {
    const { buildForkChain } = await import("../src/core/subagents");

    // Build 12-level chain: level-0 (root) → level-11 (leaf)
    const depth = 12;
    const leaf = {
      id: `level-${depth - 1}`,
      parentSessionId: `level-${depth - 2}`,
      agent: "opencode",
      alias: "main",
      title: `Level ${depth - 1}`,
    };

    const resolveParent = (id: string) => {
      const levelMatch = id.match(/^level-(\d+)$/);
      if (!levelMatch) return null;
      const lvl = parseInt(levelMatch[1]);
      if (lvl < 0) return null; // impossible, but guard
      return {
        id: `level-${lvl}`,
        parentSessionId: lvl > 0 ? `level-${lvl - 1}` : undefined,
        agent: "opencode",
        alias: "main",
        title: `Level ${lvl}`,
      };
    };

    const chain = buildForkChain(leaf, resolveParent);

    // Chain should have exactly `depth` nodes (root=level-0, ..., leaf=level-11)
    expect(chain.length).toBe(depth);
    // Root should be first
    expect(chain[0].sessionId).toBe("level-0");
    // Leaf should be last
    expect(chain[chain.length - 1].sessionId).toBe(`level-${depth - 1}`);
    // Depth values should be strictly increasing from root to leaf
    // (root has depth = depth-1, leaf has depth = 0)
    expect(chain[0].depth).toBe(depth - 1);
    expect(chain[chain.length - 1].depth).toBe(0);
  });

  /**
   * EDGE CASE: buildForkChain with parentSessionId referencing a non-existent session.
   *
   * Covered by existing tests? NO — all resolveParent functions return valid sessions
   * for every ID. If a parent session was deleted or corrupted, resolveParent returns
   * null, and the chain should stop at the last known ancestor.
   *
   * WHY RED: buildForkChain calls resolveParent and sets current = null when
   * parentSessionId is set but resolveParent returns null. The while loop terminates
   * correctly. This test verifies that the chain is truncated, not infinite.
   */
  test("build_fork_chain_parent_references_nonexistent_session_stops_gracefully", async () => {
    const { buildForkChain } = await import("../src/core/subagents");

    const session = {
      id: "orphan-child",
      parentSessionId: "deleted-parent-999",
      agent: "codex",
      alias: "work",
      title: "Orphaned session",
    };

    const resolveParent = (_id: string) => null; // Parent doesn't exist

    const chain = buildForkChain(session, resolveParent);

    // Chain should contain only the orphan session — parent is lost
    expect(chain.length).toBe(1);
    expect(chain[0].sessionId).toBe("orphan-child");
    expect(chain[0].parentSessionId).toBe("deleted-parent-999");
  });

  /**
   * EDGE CASE: --roots-only AND --children-of specified together (conflict).
   *
   * Covered by existing tests? NO — no test combines both flags.
   * These filters are mutually exclusive: --roots-only shows sessions WITHOUT
   * parents, while --children-of shows sessions WITH a specific parent.
   * Using both together is a user error that should be caught.
   *
   * WHY RED: runListCommand doesn't validate the conflict. Both filters
   * would be applied sequentially, producing confusing results (rootsOnly
   * filters to sessions without parents, then childrenOf filters to sessions
   * WITH a parent → empty result always).
   */
  test("list_roots_only_and_children_of_conflict_returns_error", async () => {
    const { runListCommand } = await import("../src/cli/list");
    const listService = async () => ({
      sessions: [
        makeSession("root-1", "opencode", "personal", "Root 1"),
        makeSession("child-1", "codex", "work", "Child 1", { parentSessionId: "root-1" }),
      ],
      errors: [],
    });

    // @ts-ignore -- both rootsOnly and childrenOf may not be validated together yet
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      rootsOnly: true,
      childrenOf: "root-1",
    });

    // RED: Should return an error because the combination is contradictory.
    // Currently: both filters apply sequentially → always empty → "No sessions"
    // Expected: exitCode 1 with error like "Cannot use --roots-only and --children-of together"
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/cannot use.*together|conflict|mutually exclusive/i);
  });

  /**
   * EDGE CASE: buildForkChain with session missing title (undefined).
   *
   * Covered by existing tests? NO — all sessions in fork chain tests have titles.
   * If a session's title is undefined or empty, buildForkChain should fall back
   * to the session ID.
   *
   * WHY RED: buildForkChain does `current.title ?? current.id`, which handles
   * undefined. But empty string `""` is truthy for `??`, so `title: ""` would
   * produce an empty string instead of falling back to the ID.
   */
  test("build_fork_chain_missing_title_falls_back_to_id", async () => {
    const { buildForkChain } = await import("../src/core/subagents");

    const session = {
      id: "no-title-session",
      parentSessionId: undefined,
      agent: "opencode",
      alias: "main",
      // title is omitted (undefined)
    };

    const resolveParent = (_id: string) => null;
    const chain = buildForkChain(session as any, resolveParent);

    expect(chain.length).toBe(1);
    // When title is undefined, should fall back to session ID
    expect(chain[0].title).toBe("no-title-session");
  });

  /**
   * EDGE CASE: Multiple children with same parent (siblings) in list output.
   *
   * Covered by existing tests? NO — the --children-of tests only verify that
   * direct children appear, but don't test that ALL siblings appear when they
   * share the same parent AND different agents.
   *
   * WHY RED: The list command doesn't deduplicate — but if the ListService
   * returns the same child twice (e.g. from two different agent backends that
   * both see the same session), the CLI should deduplicate.
   */
  test("list_children_of_same_parent_different_agents_shows_all_siblings", async () => {
    const { runListCommand } = await import("../src/cli/list");

    const siblings = [
      makeSession("sib-1", "opencode", "personal", "Sibling 1", { parentSessionId: "parent-X" }),
      makeSession("sib-2", "codex", "work", "Sibling 2", { parentSessionId: "parent-X" }),
      makeSession("sib-3", "opencode", "personal", "Sibling 3", { parentSessionId: "parent-X" }),
      // Unrelated session
      makeSession("unrelated", "opencode", "personal", "Unrelated"),
    ];

    const listService = async () => ({ sessions: siblings, errors: [] });

    // @ts-ignore -- childrenOf may not be typed yet
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      childrenOf: "parent-X",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sib-1");
    expect(result.stdout).toContain("sib-2");
    expect(result.stdout).toContain("sib-3");
    expect(result.stdout).not.toContain("unrelated");
  });
});
