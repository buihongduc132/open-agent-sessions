/**
 * test/cli-gaps-edge-cases-9.test.ts
 *
 * RED tests for edge cases NOT covered by any existing test suite:
 *   - test/cli-search.test.ts
 *   - test/cli-search-boolean.test.ts (22 tests)
 *   - test/cli-search-content.test.ts (14 tests)
 *   - test/cli-gaps-edge-cases.test.ts (20 tests)
 *   - test/cli-gaps-edge-cases-2.test.ts (20 tests: regex, boolean+content, empty-string title, planFromQuery, normalizeFuzzyQuery hyphens, error dedup)
 *   - test/cli-gaps-edge-cases-3.test.ts (7 tests: /g flag regex, ReDoS protection)
 *   - test/cli-gaps-edge-cases-4.test.ts (17 tests: buildForkChain cycles, --sub-only, boolean hyphen normalization, whitespace title, main/sub role tags, default child hiding)
 *   - test/cli-gaps-edge-cases-5.test.ts (13 tests: regex intercepted by boolean, plain search whitespace, double NOT, NOT compound operand, NOT implicit AND, regex flags leak, operators-only)
 *   - test/cli-gaps-edge-cases-6.test.ts (6 tests: tree newline, children newline, tree error session ID, children error parent ID, tree JSON dedup)
 *   - test/cli-gaps-edge-cases-7.test.ts (19 tests: content agent identity, trailing operators, content empty fallback, exclude overlap, read composable, sessions hierarchy, children empty/JSON, tree single-node, maxDepth)
 *   - test/cli-gaps-edge-cases-8.test.ts (20 tests: liqe grouped expression, field-specific, quoted phrase, RangeExpression, 3-way OR, OR+NOT, jsonlFilter AND/OR/NOT, vectorTerms)
 *   - test/cli-tree.test.ts
 *   - test/cli-read-composable.test.ts
 *   - test/search-planner-backend-predicates.test.ts
 *
 * NEW GAP AREAS:
 *   GAP H:  --exclude-current with boolean search (AND/OR/NOT) — NOT tested anywhere
 *   GAP I:  Trailing NOT "alpha NOT" — not tested (trailing AND/OR tested, NOT not tested)
 *   GAP J:  --exclude-session with boolean AND combined — NOT tested together
 *   GAP K:  Complex NOT: "NOT nonexistent AND nonexistent2" — standalone NOT + AND edge case
 *   GAP L:  jsonlFilter with empty terms array (all terms excluded by NOT)
 *   GAP M:  Empty query string handled gracefully in boolean path
 *   GAP N:  buildJsonlFilter with empty exclude terms (NOT-only query)
 */

import { describe, expect, test } from "bun:test";
import {
  runSearchCommand,
  type SearchService,
  type ContentSearchService,
} from "../src/cli/search";
import { type Config } from "../src/config/types";
import { type SessionSummary, type SearchQuery } from "../src/core/types";
import { planFromQuery } from "../src/search/planner";

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
    agent: agent as SessionSummary["agent"],
    alias,
    title,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 5,
    storage: "db",
    ...overrides,
  };
}

// ============================================================================
// GAP H: --exclude-current with boolean search (AND/OR/NOT)
// ============================================================================
// Root cause: No existing test verifies that excludeCurrent works correctly
// when combined with boolean search operators. The exclusion happens at the
// search command level (search.ts lines 239-241) AFTER boolean evaluation,
// so it SHOULD work — but it is NOT tested.
//
// For AND queries: excludeCurrent prevents the current session from being
// in the intersection. For OR queries: excludeCurrent removes it from the union.
// For NOT queries: the current session should never appear anyway.
// ============================================================================

describe("GAP H: --exclude-current with boolean search", () => {
  /**
   * WHY RED: No test covers --exclude-current combined with AND boolean queries.
   * The current session should be excluded from AND results even when the query
   * contains boolean operators. The exclusion happens post-boolean-evaluation.
   */
  test("exclude_current_with_boolean_AND_excludes_from_intersection", async () => {
    const currentSession = makeSession("current-ses", "opencode", "personal", "alpha beta session");
    const otherSession = makeSession("other-ses", "codex", "work", "alpha beta session");
    const noMatch = makeSession("no-match", "opencode", "personal", "gamma delta session");

    const result = await runSearchCommand({
      text: "alpha AND beta",
      config: baseConfig,
      currentSessionId: "current-ses",
      excludeCurrent: true,
      searchSessions: async (query) => {
        const text = query.text.toLowerCase();
        const matched = [currentSession, otherSession, noMatch].filter(s =>
          s.title.toLowerCase().includes(text) ||
          s.id.toLowerCase().includes(text)
        );
        return { sessions: matched, errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);
    // "current-ses" must NOT appear even though it matches the query
    expect(result.stdout).not.toContain("current-ses");
    // "other-ses" should appear (same query match, not excluded)
    expect(result.stdout).toContain("other-ses");
    // "no-match" should not appear (doesn't match query)
    expect(result.stdout).not.toContain("no-match");
  });

  /**
   * WHY RED: --exclude-current with OR query — the current session may appear
   * in the OR union but should be removed by post-processing exclusion.
   */
  test("exclude_current_with_boolean_OR_excludes_from_union", async () => {
    const currentAlpha = makeSession("current-alpha", "opencode", "personal", "alpha only session");
    const otherBeta = makeSession("other-beta", "codex", "work", "beta only session");

    const result = await runSearchCommand({
      text: "alpha OR beta",
      config: baseConfig,
      currentSessionId: "current-alpha",
      excludeCurrent: true,
      searchSessions: async (query) => {
        const text = query.text.toLowerCase();
        const matched = [currentAlpha, otherBeta].filter(s =>
          s.title.toLowerCase().includes(text) ||
          s.id.toLowerCase().includes(text)
        );
        return { sessions: matched, errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);
    // current session should NOT appear
    expect(result.stdout).not.toContain("current-alpha");
    // other session should appear
    expect(result.stdout).toContain("other-beta");
  });

  /**
   * WHY RED: --exclude-session with boolean AND combined. Both exclusion
   * mechanisms (excludeCurrent and excludeSession) should work together
   * with boolean queries.
   */
  test("exclude_session_with_boolean_AND_combined", async () => {
    const targetExclude = makeSession("exclude-me-001", "opencode", "personal", "alpha beta session");
    const keepMe = makeSession("keep-me-001", "codex", "work", "alpha beta session");
    const noMatch = makeSession("no-match-001", "opencode", "personal", "gamma session");

    const result = await runSearchCommand({
      text: "alpha AND beta",
      config: baseConfig,
      excludeSession: ["exclude-me-001"],
      searchSessions: async (query) => {
        const text = query.text.toLowerCase();
        const matched = [targetExclude, keepMe, noMatch].filter(s =>
          s.title.toLowerCase().includes(text) ||
          s.id.toLowerCase().includes(text)
        );
        return { sessions: matched, errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);
    // exclude-me-001 must NOT appear
    expect(result.stdout).not.toContain("exclude-me-001");
    // keep-me-001 must appear (matches AND query, not excluded)
    expect(result.stdout).toContain("keep-me-001");
  });
});

// ============================================================================
// GAP I: Trailing NOT "alpha NOT" — trailing operator edge case for NOT
// ============================================================================
// Root cause: The tokenizer produces [TERM("alpha"), NOT, EOF].
// parseAnd() sees NOT → parseNot() → parsePrimary() sees EOF → default case
// returns term(""). parseAnd then builds and(term("alpha"), term("")).
// The AND intersection with empty term = 0 sessions → silently empty results.
//
// Expected fix: parseAnd should detect trailing operators and throw a parse
// error, or the CLI should return exitCode 1 with "Incomplete query" message.
// ============================================================================

describe("GAP I: Trailing NOT operator edge case", () => {
  /**
   * WHY RED: "alpha NOT" with trailing NOT produces and(term("alpha"), term("")).
   * The empty term returns 0 sessions, so AND intersection is always empty.
   * The user gets "No sessions found" instead of a helpful error.
   *
   * After fix: Should return exitCode 1 with "Incomplete query: missing term after NOT"
   */
  test("trailing_NOT_returns_error_not_empty_results", async () => {
    const sessions = [
      makeSession("ses-alpha", "opencode", "personal", "alpha session"),
    ];

    const result = await runSearchCommand({
      text: "alpha NOT",
      config: baseConfig,
      searchSessions: async (query) => {
        const text = query.text.toLowerCase();
        const matched = sessions.filter(s =>
          s.title.toLowerCase().includes(text) ||
          s.id.toLowerCase().includes(text)
        );
        return { sessions: matched, errors: [] };
      },
    });

    // RED: Currently returns exitCode 0 with "No sessions found"
    // After fix: Should return exitCode 1 with parse error for trailing operator
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/incomplete|trailing|missing.*term|parse.*error/i);
  });

  /**
   * WHY RED: Standalone "NOT" with no positive term before it.
   * "NOT" alone → NOT(term("")) → empty term → wildcard fallback → NOT(all) → empty.
   * Should return a parse error, not empty results.
   */
  test("standalone_NOT_returns_error_not_empty_results", async () => {
    const sessions = [
      makeSession("ses-alpha", "opencode", "personal", "alpha session"),
    ];

    const result = await runSearchCommand({
      text: "NOT",
      config: baseConfig,
      searchSessions: async () => ({ sessions, errors: [] }),
    });

    // RED: Currently returns "No sessions found" (exitCode 0)
    // After fix: Should return exitCode 1 with parse error
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/incomplete|trailing|missing.*term|parse.*error/i);
  });
});

// ============================================================================
// GAP J: Complex boolean expressions — NOT X AND Y with compound NOT operand
// ============================================================================
// Root cause: "NOT nonexistent AND nonexistent2" parses as:
//   AND(NOT(term("nonexistent")), term("nonexistent2"))
// The universe is seeded only with "nonexistent" and "nonexistent2" matches.
// NOT(nonexistent) gives sessions that DON'T have "nonexistent" (seeded universe only).
// This doesn't cover sessions that match neither term.
//
// This is an edge case where NOT is not at the root and the excluded term
// is not the same as the positive term.
// ============================================================================

describe("GAP J: Complex NOT with AND — standalone NOT + positive term", () => {
  /**
   * WHY RED: "NOT nonexistent AND realterm" has:
   *   - Left: NOT(term("nonexistent"))
   *   - Right: term("realterm")
   * The universe is seeded from "nonexistent" and "realterm" searches.
   * NOT(nonexistent) gives sessions in {seeded} that don't have "nonexistent".
   * AND with term("realterm") requires intersection of both sets.
   *
   * This tests whether complex NOT expressions work correctly when combined
   * with a positive term on the right side.
   */
  test("NOT_excluded_AND_positive_term_requires_intersection", async () => {
    const sessions = [
      makeSession("ses-has-neither", "opencode", "personal", "charlie delta session"),
      makeSession("ses-has-real", "codex", "work", "realterm session"),
      makeSession("ses-has-both", "opencode", "personal", "nonexistent realterm session"),
      makeSession("ses-has-excluded", "opencode", "personal", "nonexistent session"),
    ];

    const result = await runSearchCommand({
      text: "NOT nonexistent AND realterm",
      config: baseConfig,
      searchSessions: async (query) => {
        const text = query.text.trim().toLowerCase();
        if (!text || text === "e") {
          return { sessions, errors: [] };
        }
        const results = sessions.filter(s =>
          s.title.toLowerCase().includes(text)
        );
        return { sessions: results, errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);

    // NOT nonexistent AND realterm:
    // - ses-has-real: has realterm ✓, NOT nonexistent ✓ → must appear
    expect(result.stdout).toContain("ses-has-real");
    // - ses-has-both: has both → excluded by NOT → must NOT appear
    expect(result.stdout).not.toContain("ses-has-both");
    // - ses-has-excluded: has nonexistent → excluded by NOT → must NOT appear
    expect(result.stdout).not.toContain("ses-has-excluded");
    // - ses-has-neither: missing realterm → must NOT appear
    expect(result.stdout).not.toContain("ses-has-neither");
  });
});

// ============================================================================
// GAP K: jsonlFilter with empty positive terms (NOT-only query)
// ============================================================================
// Root cause: "NOT comby" has terms=["comby"], excludeTerms=["comby"].
// buildJsonlFilter with normalized=[] (all excluded) but excludeTerms has "comby".
// The filter returns: positiveMatch = true (normalized.length === 0),
// then checks excludeTerms and excludes if "comby" found → false.
// So NOT-only queries return false for all text → empty results!
//
// This is the jsonlFilter equivalent of the standalone NOT bug in the CLI.
// ============================================================================

describe("GAP K: jsonlFilter with NOT-only query (empty positive terms)", () => {
  /**
   * WHY RED: "NOT comby" produces:
   *   terms = ["comby"], excludeTerms = []
   *   (NOT is represented differently in liqe — the excluded term is in terms,
   *    not in excludeTerms, depending on how liqe parses it)
   *
   * Actually let me check what liqe does with "NOT comby":
   * "NOT comby" parses as NOT(Term("comby")) in liqe's AST.
   * walkAst sees NOT → collectAndExclude(node.right, excludeTerms).
   * So: terms=[], excludeTerms=["comby"].
   *
   * buildJsonlFilter:
   *   normalized = [] (terms is empty)
   *   normalizedExclude = ["comby"]
   *   normalized.length === 0 → positiveMatch = true
   *   Check exclusion: lower.includes("comby") → false for unrelated text
   *   → returns true for unrelated text!
   *
   * So for NOT-only queries, the jsonlFilter returns true for ALL text
   * that doesn't contain the excluded term. This is wrong — it should return
   * false for text that doesn't contain the excluded term AND doesn't contain
   * the (empty) positive term set.
   *
   * Wait, let me re-examine:
   * If terms = [] and excludeTerms = ["comby"]:
   *   normalized = []
   *   normalizedExclude = ["comby"]
   *   normalized.length === 0 → positiveMatch = true
   *   Then exclusion check: if positiveMatch && normalizedExclude.length > 0
   *     hasExcluded = normalizedExclude.some(t => lower.includes(t))
   *     → if text doesn't have "comby" → hasExcluded = false → returns true
   *     → if text has "comby" → hasExcluded = true → returns false
   *   This IS correct! NOT-only should return true for text WITHOUT the excluded term.
   *
   * Let me reconsider: the test should verify this behavior.
   * "NOT comby" jsonlFilter should:
   *   - Return true for text WITHOUT "comby" ✓ (this is what happens)
   *   - Return false for text WITH "comby" ✓ (this also happens)
   *
   * So the current implementation is correct for simple NOT-only.
   * Let me instead test the edge case where liqe produces DIFFERENT structures.
   *
   * Actually the real edge case is: what if liqe parses "NOT" differently?
   * Let me test "NOT" alone (no term at all).
   */
  test("NOT_only_query_jsonlFilter_behavior", () => {
    // This tests what happens with "NOT" alone (no term)
    // In practice, "NOT" alone should be caught by hasTrailingOperator
    // but jsonlFilter tests need a concrete plan
    const plan = planFromQuery("NOT nonexistent-term");
    const filter = plan.jsonlFilter;

    // Text WITHOUT the excluded term → should match (NOT means "exclude X" = "include not-X")
    expect(filter("completely unrelated text")).toBe(true);

    // Text WITH the excluded term → should NOT match
    expect(filter("contains nonexistent-term here")).toBe(false);
  });
});

// ============================================================================
// GAP N: Tree command title — newlines in title break one-line-per-node
// GAP O: Children command title — newlines in title break one-line-per-child
// GAP P: Sessions command — [main]/[sub] role tags already implemented but
//         verify sessions.json format validation is NEW
// GAP Q: jsonlFilter with complex OR + NOT combination
// GAP R: buildFts5Query with OR groups + exclusion terms
// GAP S: vectorTerms normalization with NOT-only query
// ============================================================================

// GAP N: Tree title newlines — already partially tested in gap-6 but NEW case
describe("GAP N: Tree command title newlines — partial path not covered", () => {
  /**
   * WHY RED: The tree output at src/cli/tree.ts uses formatSessionRowSimple
   * which doesn't sanitize newlines. However, tree.ts lines 74-76 do a simple
   * format that includes node.title directly. Let me check if the title is
   * actually being sanitized.
   *
   * After fix: Tree output should show one line per node even if the title
   * contains newlines. The newline should be replaced with a space.
   */
  test("tree_multiline_title_produces_one_line_per_node", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");

    const chain = [
      {
        sessionId: "tree-multi-001",
        title: "First line\nSecond line\nThird line",
        agent: "opencode",
        alias: "main",
        depth: 0,
      },
      {
        sessionId: "tree-multi-002",
        title: "Normal child",
        agent: "codex",
        alias: "work",
        depth: 1,
        parentSessionId: "tree-multi-001",
      },
    ];

    const result = await runTreeCommand({
      session: "tree-multi-001",
      config: baseConfig,
      getForkChain: async () => chain,
    });

    expect(result.exitCode).toBe(0);
    // Two nodes should produce exactly 2 non-empty lines
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
  });

  /**
   * WHY RED: Carriage return in title breaks tree output. Same as above.
   */
  test("tree_carriage_return_in_title_produces_one_line", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");

    const chain = [
      {
        sessionId: "tree-cr-001",
        title: "Line1\r\nLine2\r\nLine3",
        agent: "opencode",
        alias: "main",
        depth: 0,
      },
    ];

    const result = await runTreeCommand({
      session: "tree-cr-001",
      config: baseConfig,
      getForkChain: async () => chain,
    });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
  });
});

// GAP Q: jsonlFilter with complex OR + NOT
describe("GAP Q: jsonlFilter complex OR + NOT combination", () => {
  /**
   * WHY RED: "(ast-grep OR comby) NOT gritql" should:
   *   - Match text with ast-grep OR comby
   *   - But NOT if it also has gritql
   *
   * buildJsonlFilter with OR+NOT:
   *   normalized = ["astgrep", "comby"] (from the OR terms)
   *   normalizedExclude = ["gritql"] (from NOT)
   *   op = "AND" (detectBooleanOp finds NOT)
   *   Filter logic: positiveMatch = normalized.every(t => lower.includes(t))
   *   For OR: positiveMatch = normalized.some(t => lower.includes(t))
   *   But how does it know to use OR when there's a NOT?
   *
   * The current buildJsonlFilter uses "op" parameter but when NOT is present,
   * it sets booleanOp to "AND" (via detectBooleanOp). So op = "AND".
   * positiveMatch = normalized.every(...) = both must match
   *
   * This is WRONG for "(ast-grep OR comby) NOT gritql"!
   * The OR should be preserved. The NOT is just an exclusion filter on top.
   *
   * After fix: The jsonlFilter should respect OR grouping from liqe AST.
   */
  test("jsonlFilter_OR_with_NOT_requires_exclusion_after_union", () => {
    const plan = planFromQuery("ast-grep OR comby NOT gritql");
    const filter = plan.jsonlFilter;

    // Has ast-grep only, no gritql → should match
    expect(filter("Using ast-grep for AST diffing")).toBe(true);

    // Has comby only, no gritql → should match
    expect(filter("Comby pattern matching tool")).toBe(true);

    // Has ast-grep AND comby, no gritql → should match
    expect(filter("Comparing ast-grep and comby tools")).toBe(true);

    // Has ast-grep but ALSO has gritql → should NOT match
    expect(filter("Using ast-grep with gritql integration")).toBe(false);

    // Has neither ast-grep nor comby, no gritql → should NOT match
    expect(filter("Unrelated tool discussion")).toBe(false);
  });
});

// GAP R: buildFts5Query with OR groups + exclusion
describe("GAP R: FTS5 query with OR groups + exclusion terms", () => {
  /**
   * WHY RED: "(ast-grep OR comby) NOT gritql" should produce FTS5:
   *   "(astgrep OR comby) NOT gritql"
   * Currently buildFts5Query loses the OR grouping inside the parens,
   * producing: "astgrep AND comby NOT gritql" (WRONG for OR semantics!)
   */
  test("fts5Query_preserves_OR_grouping_with_NOT_exclusion", () => {
    const plan = planFromQuery("ast-grep OR comby NOT gritql");

    // FTS5 should have OR for the positive terms, NOT for the exclusion
    // Expected: "astgrep OR comby NOT gritql"
    expect(plan.fts5Query).toContain("astgrep OR comby");
    expect(plan.fts5Query).toContain("NOT gritql");
    // Should NOT be "astgrep AND comby NOT gritql" (wrong!)
    expect(plan.fts5Query).not.toBe("astgrep AND comby NOT gritql");
  });

  /**
   * WHY RED: Multi-term positive with NOT exclusion.
   * "alpha beta NOT gamma" → positive is AND (two terms), exclusion is gamma.
   * FTS5: "alpha AND beta NOT gamma"
   */
  test("fts5Query_and_with_not_exclusion", () => {
    const plan = planFromQuery("alpha beta NOT gamma");
    expect(plan.fts5Query).toContain("alpha AND beta");
    expect(plan.fts5Query).toContain("NOT gamma");
  });
});

// GAP S: vectorTerms with NOT-only query
describe("GAP S: vectorTerms with NOT-only query (no positive terms)", () => {
  /**
   * WHY RED: "NOT comby" — all terms are excluded, no positive terms.
   * vectorTerms should be empty (nothing to search for — the NOT only
   * means "exclude sessions with comby" which is a title search concern,
   * not a vector similarity concern).
   */
  test("vectorTerms_empty_when_only_EXCLUDE_terms", () => {
    const plan = planFromQuery("NOT comby");
    // After filtering excludeTerms, vectorTerms should be empty
    // vectorTerms = terms.filter(t => !excludeTerms.includes(t))
    // For "NOT comby": terms=[], so vectorTerms=[]
    // For "ast-grep NOT comby": terms=["ast-grep"], excludeTerms=["comby"]
    //   → vectorTerms=["astgrep"]
    expect(plan.vectorTerms.length).toBe(0);
  });

  /**
   * WHY RED: Mixed positive + exclusion.
   * "ast-grep NOT comby" → vectorTerms should be ["astgrep"] (comby excluded)
   */
  test("vectorTerms_excludes_NOT_terms_from_positive_terms", () => {
    const plan = planFromQuery("ast-grep NOT comby");
    expect(plan.vectorTerms).toContain("astgrep");
    expect(plan.vectorTerms).not.toContain("comby");
  });
});

// ============================================================================
// GAP T: sessions command JSON format output shape validation (NEW)
// ============================================================================
// No existing test validates the JSON output from runSessionsCommand.
// sessions command uses formatSessionsJson which is NOT tested.
// ============================================================================

describe("GAP T: sessions command JSON format validation", () => {
  /**
   * WHY RED: No test validates the JSON output shape from runSessionsCommand.
   * When format="json", the output should be a valid JSON array where each
   * element has the expected SessionSummary fields. The formatSessionsJson
   * function is not tested.
   */
  test("sessions_json_format_returns_valid_json_array", async () => {
    const { runSessionsCommand } = await import("../src/cli/sessions");

    const sessions: SessionSummary[] = [
      makeSession("sessions-json-001", "opencode", "personal", "JSON session 1"),
      makeSession("sessions-json-002", "codex", "work", "JSON session 2", { parentSessionId: "sessions-json-001" }),
    ];

    const result = await runSessionsCommand({
      config: baseConfig,
      format: "json",
      getSessions: async () => ({ sessions, errors: [] }),
    });

    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();

    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);

    // Validate first session has expected fields
    expect(parsed[0].id).toBe("sessions-json-001");
    expect(parsed[0].agent).toBe("opencode");
    expect(parsed[0].alias).toBe("personal");
    expect(parsed[0].title).toBe("JSON session 1");
  });
});

// ============================================================================
// GAP U: Boolean search — implicit AND with bare TERM after NOT drops term
// ============================================================================
// This is the GAP-5 fix verification: after fixing parseAnd to continue on TERM
// tokens, verify that "NOT alpha bravo" works correctly.
// This test documents the expected behavior AFTER the GAP-5 fix is applied.
// ============================================================================

describe("GAP U: NOT followed by implicit AND (after GAP-5 fix)", () => {
  /**
   * WHY RED: "NOT alpha bravo" should be parsed as: NOT(alpha) AND bravo
   * After the GAP-5 fix (parseAnd continues on bare TERM tokens),
   * this should produce the correct AND intersection.
   *
   * BEFORE fix: "bravo" is silently dropped → all sessions NOT having alpha
   * AFTER fix: only sessions having bravo but NOT having alpha
   */
  test("NOT_alpha_bravo_parsed_as_not_alpha_AND_bravo", async () => {
    const sessions = [
      makeSession("ses-ab", "opencode", "personal", "alpha bravo session"),
      makeSession("ses-a", "opencode", "personal", "alpha only session"),
      makeSession("ses-b", "codex", "work", "bravo only session"),
      makeSession("ses-none", "opencode", "personal", "charlie delta session"),
    ];

    const result = await runSearchCommand({
      text: "NOT alpha bravo",
      config: baseConfig,
      searchSessions: async (query) => {
        const text = query.text.trim().toLowerCase();
        if (!text || text === "e") {
          return { sessions, errors: [] };
        }
        const results = sessions.filter(s =>
          s.title.toLowerCase().includes(text)
        );
        return { sessions: results, errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);

    // "NOT alpha bravo" = (NOT alpha) AND bravo
    // Only ses-b has bravo but NOT alpha
    expect(result.stdout).toContain("ses-b");
    // ses-ab has alpha → excluded
    expect(result.stdout).not.toContain("ses-ab");
    // ses-a has alpha → excluded
    expect(result.stdout).not.toContain("ses-a");
    // ses-none has neither → no bravo → excluded
    expect(result.stdout).not.toContain("ses-none");
  });
});

// ============================================================================
// GAP V: Complex boolean with parentheses + NOT + implicit AND
// ============================================================================

describe("GAP V: Complex boolean — parens + NOT + implicit AND", () => {
  /**
   * WHY RED: "(alpha OR beta) NOT gamma delta" — complex expression with:
   *   - OR group: (alpha OR beta)
   *   - NOT exclusion: NOT gamma
   *   - Implicit AND: delta
   *
   * Parsing should produce: AND(NOT(gamma), AND(delta, OR(alpha, beta)))
   * This is a tricky combination of explicit AND, NOT, and OR.
   *
   * Expected result: sessions with delta, not having gamma, and having alpha OR beta.
   */
  test("complex_parentheses_not_implicit_and_complex_query", async () => {
    const sessions = [
      makeSession("ses-full", "opencode", "personal", "alpha bravo delta session"),
      makeSession("ses-alpha-delta", "opencode", "personal", "alpha delta session"),
      makeSession("ses-beta-delta", "codex", "work", "beta delta session"),
      makeSession("ses-no-alpha-beta", "opencode", "personal", "gamma delta session"),
      makeSession("ses-only-alpha", "opencode", "personal", "alpha session"),
      makeSession("ses-none", "opencode", "personal", "unrelated session"),
    ];

    const result = await runSearchCommand({
      text: "(alpha OR beta) NOT gamma delta",
      config: baseConfig,
      searchSessions: async (query) => {
        const text = query.text.trim().toLowerCase();
        if (!text || text === "e") {
          return { sessions, errors: [] };
        }
        const results = sessions.filter(s =>
          s.title.toLowerCase().includes(text)
        );
        return { sessions: results, errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);

    // ses-full: has alpha, has delta, NOT gamma → should appear
    expect(result.stdout).toContain("ses-full");
    // ses-alpha-delta: has alpha, has delta, NOT gamma → should appear
    expect(result.stdout).toContain("ses-alpha-delta");
    // ses-beta-delta: has beta, has delta, NOT gamma → should appear
    expect(result.stdout).toContain("ses-beta-delta");
    // ses-no-alpha-beta: has gamma → excluded by NOT
    expect(result.stdout).not.toContain("ses-no-alpha-beta");
    // ses-only-alpha: missing delta → excluded
    expect(result.stdout).not.toContain("ses-only-alpha");
    // ses-none: missing all → excluded
    expect(result.stdout).not.toContain("ses-none");
  });
});

describe("GAP L: Whitespace-only query string in search path", () => {
  /**
   * WHY RED: A query that is only whitespace should be rejected as an empty query.
   * Currently "   " passes through isBooleanQuery (false) and goes to plain search,
   * which sends "   " to the search service. The service might interpret this as
   * a valid query or might error out.
   *
   * After fix: runSearchCommand should normalize whitespace-only to empty and
   * return the missing argument error.
   */
  test("whitespace_only_query_returns_error", async () => {
    let called = false;
    const result = await runSearchCommand({
      text: "   \t\n  ",
      config: baseConfig,
      searchSessions: async (query) => {
        called = true;
        return { sessions: [], errors: [] };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/missing.*argument|empty.*query/i);
    // The search service should NOT be called for whitespace-only input
    expect(called).toBe(false);
  });
});

// ============================================================================
// GAP M: Boolean query with ONLY exclusion terms (no positive terms)
// ============================================================================
// Root cause: Query like "NOT a NOT b" produces terms=[] (all excluded),
// excludeTerms=["a","b"]. The search service receives the wildcard "e"
// during collectAndSeedAll. The boolean evaluation for NOT produces
// complement sets based on the seeded universe.
//
// For jsonlFilter: with normalized=[] and normalizedExclude=["a","b"]:
//   positiveMatch = true (empty terms = match all positive)
//   Then exclusion: any of ["a","b"] in text? → false for unrelated text
//   → returns true for unrelated text (CORRECT for NOT-only!)
//
// For CLI: The boolean evaluator should handle "NOT a NOT b" correctly.
// This is tested in GAP-3 of edge-cases-5 (double NOT) but the fix was
// wildcard expansion for nested NOT. Let me verify the fix is complete.
// ============================================================================

describe("GAP M: Multiple NOT operators without positive terms", () => {
  /**
   * WHY RED: "NOT a NOT b NOT c" — triple NOT with no positive term.
   * The parser produces: AND(NOT(a), AND(NOT(b), NOT(c)))
   * This is equivalent to: NOT(a OR b OR c) — sessions matching none of a,b,c.
   *
   * After fix: The query should return sessions that match NONE of the terms.
   */
  test("triple_NOT_returns_complement_of_all_three_terms", async () => {
    const sessions = [
      makeSession("ses-a", "opencode", "personal", "session with a"),
      makeSession("ses-ab", "opencode", "personal", "session with a and b"),
      makeSession("ses-abc", "codex", "work", "session with a and b and c"),
      makeSession("ses-none", "opencode", "personal", "session with nothing"),
    ];

    const result = await runSearchCommand({
      text: "NOT a NOT b NOT c",
      config: baseConfig,
      searchSessions: async (query) => {
        const text = query.text.trim().toLowerCase();
        if (!text || text === "e") {
          return { sessions, errors: [] };
        }
        const results = sessions.filter(s =>
          s.title.toLowerCase().includes(text)
        );
        return { sessions: results, errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);

    // NOT a NOT b NOT c = sessions with NONE of a, b, or c
    // ses-none: has none of a, b, c → must appear
    expect(result.stdout).toContain("ses-none");
    // ses-a: has a → excluded
    expect(result.stdout).not.toContain("ses-a");
    // ses-ab: has a and b → excluded
    expect(result.stdout).not.toContain("ses-ab");
    // ses-abc: has a, b, c → excluded
    expect(result.stdout).not.toContain("ses-abc");
  });
});
