/**
 * test/cli-gaps-edge-cases-2.test.ts
 *
 * RED tests for edge cases NOT covered by any existing test suite:
 *   - test/cli-search.test.ts (7 tests)
 *   - test/cli-search-boolean.test.ts (22 tests)
 *   - test/cli-search-content.test.ts (14 tests)
 *   - test/cli-gaps-edge-cases.test.ts (20 tests)
 *   - test/cli-tree.test.ts
 *   - test/cli-read-composable.test.ts
 *
 * These tests target specific uncovered gaps documented in the task spec:
 *   Gap A: Regex search /pattern/ — no test verifies regex patterns work end-to-end
 *   Gap B: Boolean + content search interaction — boolean branch skips findSimilarSessions
 *   Gap C: buildForkChain with empty-string title ("") — ?? doesn't fall back to id
 *   Gap D: Dead code planFromQuery/applyBooleanLogic in planner.ts — never tested
 *   Gap E: normalizeFuzzyQuery edge cases — multiple/leading/trailing hyphens
 *   Gap F: Error deduplication in collectErrors — same agent:alias errors merged
 */

import { describe, expect, test } from "bun:test";
import {
  runSearchCommand,
  type SearchService,
  type ContentSearchService,
} from "../src/cli/search";
import { type Config } from "../src/config/types";
import { type SessionSummary, type SearchQuery } from "../src/core/types";
import { planFromQuery, applyBooleanLogic } from "../src/search/planner";

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

const allSessions = [
  makeSession("ses_AG", "opencode", "personal", "Working with ast-grep for AST diffing"),
  makeSession("ses_CB", "codex", "work", "Comby pattern rewrite tool exploration"),
  makeSession("ses_GQ", "opencode", "personal", "Evaluating gritql for code queries"),
  makeSession("ses_AG_CB", "opencode", "personal", "ast-grep vs comby comparison"),
  makeSession("ses_AG_GQ", "opencode", "personal", "ast-grep and gritql integration"),
  makeSession("ses_ALL", "codex", "work", "ast-grep, comby, gritql — full comparison"),
  makeSession("ses_NONE", "opencode", "personal", "General debugging session"),
];

const BOOLEAN_OPS = / AND | OR | NOT /i;

function buildBooleanAwareMock(sessions: SessionSummary[]): SearchService {
  return async (query: SearchQuery) => {
    const text: string = query.text.trim();
    if (BOOLEAN_OPS.test(text)) {
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

// ============================================================================
// Gap A — Regex search /pattern/
// ============================================================================

describe("Gap A — Regex search /pattern/ end-to-end", () => {
  /**
   * EDGE CASE: Regex pattern `/ast.grep/` should match sessions whose titles
   * contain "ast-grep" (dot matches any char including hyphen) or "ast grep"
   * (dot matches space).
   *
   * WHY RED: The liqe parser in planner.ts detects regex via `query.includes("/")`
   * and sets `hasRegex: true`. But runSearchCommand in search.ts does NOT have a
   * regex branch — it delegates to either isBooleanQuery or plain search.
   * `isBooleanQuery` returns false for `/ast.grep/` (no AND/OR/NOT/parens), so
   * the query goes through the plain search path where `/ast.grep/` is passed
   * literally to searchSessions. The mock does a simple substring match, which
   * won't find `/ast.grep/` in any title → empty results.
   *
   * After fix: runSearchCommand should detect regex patterns (e.g. via liqe's
   * RegexExpression node) and convert `/ast.grep/` into a regex test against
   * session titles/content.
   */
  test("regex_slash_pattern_slash matches ast-grep and ast grep sessions", async () => {
    const regexSessions = [
      makeSession("regex-ag-1", "opencode", "personal", "Working with ast-grep for diffing"),
      makeSession("regex-ag-2", "opencode", "personal", "Using ast grep tool for analysis"),
      makeSession("regex-unrelated", "codex", "work", "Unrelated session"),
    ];

    const result = await runSearchCommand({
      text: "/ast.grep/",
      config: baseConfig,
      searchSessions: buildBooleanAwareMock(regexSessions),
    });

    expect(result.exitCode).toBe(0);
    // Regex /ast.grep/ should match "ast-grep" (dot = hyphen) and "ast grep" (dot = space)
    expect(result.stdout).toContain("regex-ag-1");
    expect(result.stdout).toContain("regex-ag-2");
    expect(result.stdout).not.toContain("regex-unrelated");
  });

  /**
   * EDGE CASE: Regex OR pattern `/comby|gritql/` should match sessions with
   * either "comby" or "gritql" in their titles.
   *
   * WHY RED: Same as above — no regex evaluation branch exists in runSearchCommand.
   * The literal string `/comby|gritql/` is passed to searchSessions, which
   * can't match it via substring comparison.
   */
  test("regex_OR_pattern matches sessions with comby or gritql", async () => {
    const result = await runSearchCommand({
      text: "/comby|gritql/",
      config: baseConfig,
      searchSessions: buildBooleanAwareMock(allSessions),
    });

    expect(result.exitCode).toBe(0);
    // /comby|gritql/ should match any session with comby OR gritql
    expect(result.stdout).toContain("ses_CB");     // has comby
    expect(result.stdout).toContain("ses_GQ");     // has gritql
    expect(result.stdout).toContain("ses_AG_CB");  // has comby
    expect(result.stdout).toContain("ses_AG_GQ");  // has gritql
    expect(result.stdout).toContain("ses_ALL");     // has both
    // ses_AG has neither comby nor gritql
    expect(result.stdout).not.toContain("(ses_AG)");
    expect(result.stdout).not.toContain("(ses_NONE)");
  });

  /**
   * EDGE CASE: Regex combined with boolean operator: `/ast.grep/ AND comby`
   * should find sessions matching regex `/ast.grep/` AND containing "comby".
   *
   * WHY RED: isBooleanQuery returns true for this query (contains AND), so it
   * enters the boolean branch. But the boolean parser treats `/ast.grep/` as
   * a literal term (tokenizes it as-is including slashes). The searchSessions
   * mock does substring matching for "ast.grep" — but the real issue is that
   * the boolean search path doesn't strip regex delimiters or apply regex
   * matching. The term `/ast.grep/` won't match "ast-grep" via substring.
   */
  test("regex_AND_boolean combined: /ast.grep/ AND comby", async () => {
    let capturedQueries: string[] = [];
    const capturingMock: SearchService = async (query: SearchQuery) => {
      capturedQueries.push(query.text);
      return buildBooleanAwareMock(allSessions)(query);
    };

    const result = await runSearchCommand({
      text: "/ast.grep/ AND comby",
      config: baseConfig,
      searchSessions: capturingMock,
    });

    expect(result.exitCode).toBe(0);
    // Should find sessions with ast-grep (via regex) AND comby (via term)
    // ses_AG_CB has both; ses_ALL has both
    expect(result.stdout).toContain("ses_AG_CB");
    expect(result.stdout).toContain("ses_ALL");
    // ses_AG has ast-grep but NOT comby
    expect(result.stdout).not.toContain("(ses_AG)");
  });
});

// ============================================================================
// Gap B — Boolean + content search interaction
// ============================================================================

describe("Gap B — Boolean query skips findSimilarSessions", () => {
  /**
   * EDGE CASE: When findSimilarSessions is provided AND the query contains
   * boolean operators, the current code in search.ts line 80 takes the
   * isBooleanQuery branch and NEVER calls findSimilarSessions.
   *
   * This means: `findSimilarSessions AND ast-grep` will only use the boolean
   * search path, ignoring content search entirely. If a session only has
   * "findSimilarSessions" in its message body (not title), it won't be found.
   *
   * WHY RED: The code path is:
   *   if (isBooleanQuery(rawQuery)) { ... boolean branch ... }
   *   else { if (options.findSimilarSessions) { ... content branch ... } }
   *
   * These are mutually exclusive — boolean queries can never use content search.
   * The fix should merge both: run boolean evaluation AND content search, then
   * combine results.
   */
  test("boolean_query_with_findSimilarSessions_uses_both_paths", async () => {
    // A session whose title has "ast-grep" but NOT "comby"
    const titleMatch = makeSession("title-match", "opencode", "personal", "Working with ast-grep");
    // A session whose title has "comby" but NOT "ast-grep"
    const contentOnly = makeSession("content-only", "codex", "work", "Debug session");
    // A session with both in title
    const bothInTitle = makeSession("both-title", "opencode", "personal", "ast-grep and comby tools");

    const sessions = [titleMatch, contentOnly, bothInTitle];

    // Content search finds "content-only" because "ast-grep" appears in its body
    const findSimilar: ContentSearchService = async (text) => {
      if (text.includes("ast") || text.includes("grep")) {
        return [{
          sessionId: "content-only",
          title: "Debug session",
          score: 0.8,
          rank: 1,
          matchType: "fts-only",
          matchedChunks: 2,
        }];
      }
      return [];
    };

    const result = await runSearchCommand({
      text: "ast-grep AND comby",
      config: baseConfig,
      searchSessions: buildBooleanAwareMock(sessions),
      findSimilarSessions: findSimilar,
    });

    expect(result.exitCode).toBe(0);
    // "both-title" has both terms in title → always found
    expect(result.stdout).toContain("both-title");
    // RED: "content-only" has ast-grep in body (via findSimilarSessions) and
    // comby in title — should be found when boolean + content search are combined.
    // Currently: boolean branch runs, findSimilarSessions is never called,
    // so "content-only" is not found.
    expect(result.stdout).toContain("content-only");
  });
});

// ============================================================================
// Gap C — buildForkChain with empty-string title
// ============================================================================

describe("Gap C — buildForkChain with empty-string title", () => {
  /**
   * EDGE CASE: buildForkChain uses `current.title ?? current.id` to set the
   * title field. When title is `""` (empty string), the `??` operator does NOT
   * fall back to id because `""` is not nullish (only null/undefined trigger ??).
   * This produces a ForkChainNode with `title: ""` instead of falling back
   * to the session id.
   *
   * WHY RED: The fix should use `current.title || current.id` (falsy check)
   * or `current.title?.trim() ? current.title : current.id` to handle empty
   * strings. Current code at subagents.ts line 331:
   *   title: current.title ?? current.id,
   */
  test("buildForkChain_empty_string_title_falls_back_to_id", async () => {
    const { buildForkChain } = await import("../src/core/subagents");

    const session = {
      id: "empty-title-session",
      parentSessionId: undefined,
      agent: "opencode",
      alias: "main",
      title: "", // empty string — NOT undefined
    };

    const resolveParent = (_id: string) => null;
    const chain = buildForkChain(session as any, resolveParent);

    expect(chain.length).toBe(1);
    // RED: current.title ?? current.id returns "" (empty string) because
    // "" is not nullish. Should fall back to session id.
    expect(chain[0].title).toBe("empty-title-session");
  });

  /**
   * EDGE CASE: Same bug in a chain — child has empty title, parent has a real title.
   * The child's empty title propagates through the chain.
   */
  test("buildForkChain_child_with_empty_title_in_chain", async () => {
    const { buildForkChain } = await import("../src/core/subagents");

    const child = {
      id: "child-empty",
      parentSessionId: "parent-real",
      agent: "opencode",
      alias: "main",
      title: "",
    };

    const resolveParent = (id: string) => {
      if (id === "parent-real") {
        return {
          id: "parent-real",
          parentSessionId: undefined,
          agent: "opencode",
          alias: "main",
          title: "Parent session with title",
        };
      }
      return null;
    };

    const chain = buildForkChain(child as any, resolveParent);

    expect(chain.length).toBe(2);
    // Parent title should be preserved
    expect(chain[0].title).toBe("Parent session with title");
    // RED: Child's empty title should fall back to id
    expect(chain[1].title).toBe("child-empty");
  });
});

// ============================================================================
// Gap D — Dead code: planFromQuery and applyBooleanLogic
// ============================================================================

describe("Gap D — Dead code: planFromQuery and applyBooleanLogic", () => {
  /**
   * EDGE CASE: planFromQuery is defined in src/search/planner.ts but is NEVER
   * imported or used anywhere in the codebase. The actual boolean search uses
   * search-boolean.ts instead. This test verifies that planFromQuery correctly
   * parses queries — if it doesn't, it should either be fixed or removed.
   *
   * WHY RED: planFromQuery uses liqe to parse queries. liqe uses a different
   * AST structure than the custom tokenizer in search-boolean.ts. The walkAst
   * function may not handle all query shapes correctly. Additionally, liqe
   * throws on queries with unquoted special characters like hyphens in "ast-grep",
   * so planFromQuery falls back to treating the whole query as a single term.
   * This means it extracts ["ast-grep AND comby"] as one term, not ["ast-grep", "comby"].
   */
  test("planFromQuery_parses_AND_query_into_separate_terms", () => {
    const plan = planFromQuery("ast-grep AND comby");

    // RED: liqe may parse "ast-grep" as a range query or throw due to the
    // hyphen. When it throws, the catch block returns the whole query as one term.
    // After fix: plan.terms should be ["ast-grep", "comby"], not ["ast-grep AND comby"]
    expect(plan.terms).toEqual(["ast-grep", "comby"]);
    expect(plan.hasBoolean).toBe(true);
  });

  /**
   * EDGE CASE: planFromQuery with OR query.
   *
   * WHY RED: Same issue — liqe may not parse "ast-grep OR comby" correctly
   * due to hyphens. The fallback treats the entire string as one term.
   */
  test("planFromQuery_parses_OR_query_into_separate_terms", () => {
    const plan = planFromQuery("comby OR gritql");

    // RED: liqe may fail to parse; fallback returns single term
    expect(plan.terms).toEqual(["comby", "gritql"]);
    expect(plan.hasBoolean).toBe(true);
  });

  /**
   * EDGE CASE: planFromQuery with NOT query.
   *
   * WHY RED: The walkAst function handles BinaryExpression with operator "NOT",
   * but liqe may represent "ast-grep NOT comby" differently than expected.
   */
  test("planFromQuery_extracts_NOT_terms_into_excludeTerms", () => {
    const plan = planFromQuery("ast-grep NOT comby");

    // RED: liqe may not parse this correctly due to hyphens
    expect(plan.terms).toContain("ast-grep");
    expect(plan.excludeTerms).toContain("comby");
    expect(plan.hasBoolean).toBe(true);
  });

  /**
   * EDGE CASE: applyBooleanLogic with AND operator should compute intersection.
   *
   * WHY RED: This function exists but is never used. Testing it to verify
   * correctness in isolation. The function takes Map<term, Set<sessionId>>
   * and returns the intersection.
   */
  test("applyBooleanLogic_AND_returns_intersection", () => {
    const results = new Map<string, Set<string>>();
    results.set("ast-grep", new Set(["ses_A", "ses_B", "ses_C"]));
    results.set("comby", new Set(["ses_B", "ses_C", "ses_D"]));

    const result = applyBooleanLogic(results, "AND", new Set());

    // Intersection: ses_B and ses_C appear in both
    expect(result).toEqual(new Set(["ses_B", "ses_C"]));
  });

  /**
   * EDGE CASE: applyBooleanLogic with OR operator should compute union.
   */
  test("applyBooleanLogic_OR_returns_union", () => {
    const results = new Map<string, Set<string>>();
    results.set("ast-grep", new Set(["ses_A", "ses_B"]));
    results.set("comby", new Set(["ses_B", "ses_C"]));

    const result = applyBooleanLogic(results, "OR", new Set());

    // Union: all unique IDs
    expect(result).toEqual(new Set(["ses_A", "ses_B", "ses_C"]));
  });

  /**
   * EDGE CASE: applyBooleanLogic with NOT exclusions.
   */
  test("applyBooleanLogic_AND_with_exclusions_removes_excluded_ids", () => {
    const results = new Map<string, Set<string>>();
    results.set("ast-grep", new Set(["ses_A", "ses_B", "ses_C"]));
    results.set("comby", new Set(["ses_A", "ses_B", "ses_C"]));

    const excludeIds = new Set(["ses_B"]);
    const result = applyBooleanLogic(results, "AND", excludeIds);

    // Intersection minus excluded: ses_A and ses_C
    expect(result).toEqual(new Set(["ses_A", "ses_C"]));
  });

  /**
   * EDGE CASE: applyBooleanLogic with empty results map.
   */
  test("applyBooleanLogic_empty_map_returns_empty_set", () => {
    const results = new Map<string, Set<string>>();
    const result = applyBooleanLogic(results, "AND", new Set());
    expect(result).toEqual(new Set());
  });
});

// ============================================================================
// Gap E — normalizeFuzzyQuery edge cases
// ============================================================================

describe("Gap E — normalizeFuzzyQuery edge cases", () => {
  /**
   * EDGE CASE: Multiple consecutive hyphens `"a--b---c"`.
   *
   * normalizeFuzzyQuery does `query.replace(/-/g, "")` which strips ALL hyphens.
   * So "a--b---c" becomes "abc" (all hyphens removed). The issue is that the
   * mock's substring match in test sessions may not have "abc" anywhere, so the
   * search would fail to find sessions that have "a-b-c" in their titles.
   *
   * WHY RED: This tests the actual behavior through runSearchCommand. The
   * normalization strips hyphens, producing "abc". The mock does a substring
   * match on normalized titles. If the session title is "a-b-c tool", it becomes
   * "a b c tool" (mock doesn't strip hyphens from titles, only from query term).
   * So "abc" won't match "a b c tool" → session not found.
   *
   * The fix should either:
   * 1. Also normalize session titles before comparison, OR
   * 2. Replace consecutive hyphens with a single space instead of stripping
   */
  test("normalizeFuzzyQuery_multiple_consecutive_hyphens", async () => {
    const session = makeSession("ses-multihyphen", "opencode", "personal", "a-b-c analysis tool");

    const result = await runSearchCommand({
      text: "a--b---c",
      config: baseConfig,
      searchSessions: async (query: SearchQuery) => {
        // This mock mirrors what a real service would do:
        // normalize both query and titles for comparison
        const normalizedQuery = query.text.toLowerCase().replace(/-/g, "");
        const normalizedTitle = "a-b-c analysis tool".toLowerCase().replace(/-/g, "");
        if (normalizedTitle.includes(normalizedQuery)) {
          return { sessions: [session], errors: [] };
        }
        return { sessions: [], errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);
    // RED: query "a--b---c" normalized to "abc", but the title normalized is "abc analysis tool"
    // If the service normalizes both sides, it should match. But the current
    // runSearchCommand normalizes ONLY for findSimilarSessions, not for searchSessions.
    // So searchSessions receives the raw "a--b---c" query.
    expect(result.stdout).toContain("ses-multihyphen");
  });

  /**
   * EDGE CASE: Leading/trailing hyphens `"-sqlite-vec-"`.
   *
   * WHY RED: normalizeFuzzyQuery strips ALL hyphens → "sqlitevec". This is
   * probably correct for most cases, but leading/trailing hyphens could be
   * significant (e.g. "-flag" style arguments). The test verifies the
   * normalization result is predictable.
   */
  test("normalizeFuzzyQuery_leading_trailing_hyphens_stripped", async () => {
    const session = makeSession("ses-sqlite", "opencode", "personal", "sqlitevec session");

    const result = await runSearchCommand({
      text: "-sqlite-vec-",
      config: baseConfig,
      searchSessions: async (query: SearchQuery) => {
        const normalizedQuery = query.text.toLowerCase().replace(/-/g, "");
        const normalizedTitle = "sqlitevec session".toLowerCase().replace(/-/g, "");
        if (normalizedTitle.includes(normalizedQuery)) {
          return { sessions: [session], errors: [] };
        }
        return { sessions: [], errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);
    // "-sqlite-vec-" normalized → "sqlitevec" should match "sqlitevec session"
    expect(result.stdout).toContain("ses-sqlite");
  });

  /**
   * EDGE CASE: Mixed special characters `"sqlite_vec*test?"`.
   *
   * WHY RED: normalizeFuzzyQuery only strips hyphens and normalizes whitespace.
   * It does NOT strip underscores, asterisks, or question marks. These special
   * characters remain in the query and may break FTS5 MATCH syntax or substring
   * matching in the backend.
   *
   * The test checks that the query is at least handled without crashing.
   */
  test("normalizeFuzzyQuery_mixed_special_chars_does_not_crash", async () => {
    const specialQueries = [
      "sqlite_vec*test?",
      "test_query*another",
      "session**name??",
      "___triple___underscore___",
    ];

    for (const query of specialQueries) {
      const result = await runSearchCommand({
        text: query,
        config: baseConfig,
        searchSessions: async () => ({ sessions: [], errors: [] }),
      });

      // Must not crash — return gracefully
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No sessions found");
    }
  });

  /**
   * EDGE CASE: Query that is ONLY hyphens `"---"`.
   *
   * WHY RED: normalizeFuzzyQuery strips all hyphens from "---", producing "".
   * The empty string is then trimmed. If the result is empty, the service
   * receives an empty query. The mock should handle this gracefully.
   */
  test("normalizeFuzzyQuery_only_hyphens_produces_empty_query", async () => {
    let receivedQuery = "";
    const result = await runSearchCommand({
      text: "---",
      config: baseConfig,
      searchSessions: async (query: SearchQuery) => {
        receivedQuery = query.text;
        return { sessions: [], errors: [] };
      },
      findSimilarSessions: async (text: string) => {
        // After normalization, "---" → "" → should not reach here
        return [];
      },
    });

    // "---" is a valid string with length > 0, so it passes the initial
    // !options.text check. But after normalization it becomes "".
    // The code should handle this gracefully.
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================================
// Gap F — Search service error deduplication
// ============================================================================

describe("Gap F — Error deduplication in collectErrors", () => {
  /**
   * EDGE CASE: When a boolean AND query has two terms and BOTH fail with the
   * same error from the same agent, the errors should be deduplicated.
   *
   * WHY RED: The collectErrors function in search-boolean.ts deduplicates by
   * `agent:alias` key. But the error objects from the boolean evaluator have
   * `agent: "unknown"` and `alias: "unknown"` (from evalNode's catch block
   * at line 213). Two errors from two different term evaluations would BOTH
   * have `agent: "unknown", alias: "unknown"` → they get deduplicated to ONE
   * error. But the MESSAGE might be different! collectErrors keeps only the
   * FIRST error for a given key, losing the second error message.
   *
   * This test verifies that when two terms produce different error messages
   * from the same logical agent, both messages are preserved (or at least
   * the output contains information about both failures).
   */
  test("boolean_AND_both_terms_fail_different_errors_shows_all", async () => {
    let callCount = 0;
    const failingMock: SearchService = async (query: SearchQuery) => {
      callCount++;
      if (callCount === 1) {
        return {
          sessions: [],
          errors: [{ agent: "opencode" as const, alias: "personal", message: "opencode backend timeout" }],
        };
      }
      return {
        sessions: [],
        errors: [{ agent: "opencode" as const, alias: "personal", message: "opencode index corrupted" }],
      };
    };

    const result = await runSearchCommand({
      text: "term-a AND term-b",
      config: baseConfig,
      searchSessions: failingMock,
    });

    expect(result.exitCode).toBe(0);
    // Both errors come from the same agent:alias → collectErrors deduplicates.
    // RED: The dedup keeps only ONE error per agent:alias key.
    // But both error messages are important — the user should see both.
    // Currently: only the first error ("timeout") is shown, losing "corrupted".
    // After fix: either show all errors, or merge messages.
    expect(result.stderr).toContain("timeout");
    expect(result.stderr).toContain("corrupted");
  });

  /**
   * EDGE CASE: Two terms fail with errors from DIFFERENT agents.
   * These should NOT be deduplicated — both should appear in stderr.
   */
  test("boolean_AND_both_terms_fail_different_agents_shows_both", async () => {
    let callCount = 0;
    const failingMock: SearchService = async (query: SearchQuery) => {
      callCount++;
      if (callCount === 1) {
        return {
          sessions: [],
          errors: [{ agent: "opencode" as const, alias: "personal", message: "opencode offline" }],
        };
      }
      return {
        sessions: [],
        errors: [{ agent: "codex" as const, alias: "work", message: "codex connection refused" }],
      };
    };

    const result = await runSearchCommand({
      text: "term-a AND term-b",
      config: baseConfig,
      searchSessions: failingMock,
    });

    expect(result.exitCode).toBe(0);
    // Different agent:alias keys → both errors should appear
    expect(result.stderr).toContain("opencode offline");
    expect(result.stderr).toContain("codex connection refused");
  });

  /**
   * EDGE CASE: Same error message from same agent appears twice.
   * Should be deduplicated to appear exactly once.
   */
  test("boolean_AND_same_error_twice_deduplicated_to_one", async () => {
    let callCount = 0;
    const failingMock: SearchService = async (query: SearchQuery) => {
      callCount++;
      // Both terms produce the EXACT same error
      return {
        sessions: [],
        errors: [{ agent: "opencode" as const, alias: "personal", message: "service unavailable" }],
      };
    };

    const result = await runSearchCommand({
      text: "term-x AND term-y",
      config: baseConfig,
      searchSessions: failingMock,
    });

    expect(result.exitCode).toBe(0);
    // "service unavailable" should appear only once in stderr
    const count = result.stderr.split("service unavailable").length - 1;
    expect(count).toBe(1);
  });
});
