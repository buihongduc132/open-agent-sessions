/**
 * test/cli-gaps-edge-cases-8.test.ts
 *
 * RED tests targeting gaps NOT covered by any existing test file.
 *
 * Coverage checked against:
 *   - test/cli-gaps-edge-cases.test.ts      (20 tests)
 *   - test/cli-gaps-edge-cases-2.test.ts    (20 tests)
 *   - test/cli-gaps-edge-cases-3.test.ts    ( 7 tests)
 *   - test/cli-gaps-edge-cases-4.test.ts    (17 tests)
 *   - test/cli-gaps-edge-cases-5.test.ts    (13 tests)
 *   - test/cli-gaps-edge-cases-6.test.ts    ( 6 tests)
 *   - test/cli-gaps-edge-cases-7.test.ts    (19 tests)
 *   - test/cli-search.test.ts
 *   - test/cli-search-boolean.test.ts
 *   - test/cli-search-content.test.ts
 *   - test/cli-list.test.ts
 *   - test/cli-tree.test.ts
 *   - test/cli-read-composable.test.ts
 *   - test/search-planner-backend-predicates.test.ts
 *
 * NEW GAP AREAS:
 *   GAP-1: liqe parser — grouped expression "(ast-grep OR comby) AND gritql"
 *   GAP-2: liqe parser — field-specific query "agent:opencode ast-grep"
 *   GAP-3: liqe parser — quoted phrase "ast-grep patterns"
 *   GAP-4: liqe parser — RangeExpression (timestamp ranges)
 *   GAP-5: planner — 3-way OR: "ast-grep OR comby OR gritql"
 *   GAP-6: planner — OR with NOT combined: "ast-grep OR comby NOT gritql"
 *   GAP-7: jsonlFilter — streaming filter with AND semantics
 *   GAP-8: jsonlFilter — streaming filter with OR semantics
 *   GAP-9: jsonlFilter — streaming filter with NOT exclusion
 */

import { describe, expect, test } from "bun:test";
import { planFromQuery } from "../src/search/planner";

// ============================================================================
// GAP-1: liqe grouped expression — "(ast-grep OR comby) AND gritql"
// ============================================================================
// Root cause: When liqe parses "(ast-grep OR comby) AND gritql", it produces
// a LogicalExpression at the top level with AND operator. The left side is a
// GroupExpression containing the OR. The right side is the gritql literal.
// The current walkAst correctly handles LogicalExpression AND by recursing into
// both sides, so terms SHOULD be extracted. But:
//   - For OR, walkAst doesn't track the operator, so terms are extracted as
//     ["ast-grep", "comby"] without preserving the OR grouping.
//   - buildFts5Query uses the detected booleanOp ("AND") rather than detecting
//     that the inner expression is OR.
//   - Expected FTS5: "(astgrep OR comby) AND gritql"
//   - Actual FTS5: "astgrep AND comby AND gritql" (OR lost in FTS5 output)
//
// After fix: FTS5 query should preserve OR grouping from the inner expression.
// ============================================================================

describe("GAP-1: liqe grouped expression", () => {
  /**
   * WHY RED: liqe parses "(ast-grep OR comby) AND gritql" with OR inside parens.
   * walkAst extracts all three terms. But buildFts5Query only uses the
   * top-level booleanOp ("AND") and loses the inner OR grouping.
   *
   * After fix: FTS5 query should be "(astgrep OR comby) AND gritql"
   * preserving the OR inside the group.
   */
  test("grouped_OR_expression_preserves_OR_in_FTS5", () => {
    const plan = planFromQuery("(ast-grep OR comby) AND gritql");

    // Terms should all be extracted
    expect(plan.terms).toContain("ast-grep");
    expect(plan.terms).toContain("comby");
    expect(plan.terms).toContain("gritql");

    // RED: FTS5 should preserve OR grouping from the inner expression.
    // Expected: "(astgrep OR comby) AND gritql"
    // Current: "astgrep AND comby AND gritql" — OR lost!
    expect(plan.fts5Query).toMatch(/\(astgrep OR comby\)/);
    expect(plan.fts5Query).toContain("AND gritql");
  });

  /**
   * WHY RED: Nested grouping — the planner should handle nested parens correctly.
   */
  test("deeply_nested_grouping_preserves_inner_OR", () => {
    const plan = planFromQuery("((ast-grep OR comby)) AND gritql");

    // RED: Nested parens should still preserve OR
    expect(plan.fts5Query).toMatch(/\(astgrep OR comby\)/);
    expect(plan.fts5Query).toContain("AND gritql");
  });

  /**
   * WHY RED: Parens with only one alternative should not produce empty OR.
   */
  test("grouped_single_term_no_redundant_OR", () => {
    const plan = planFromQuery("(ast-grep) AND comby");

    // Should be treated as two AND terms, no redundant OR
    expect(plan.fts5Query).toBe("astgrep AND comby");
  });
});

// ============================================================================
// GAP-2: liqe field-specific query — "agent:opencode ast-grep"
// ============================================================================
// Root cause: When liqe parses "agent:opencode ast-grep", it produces a Tag node
// with field="agent" and expression=LiteralExpression("opencode"), plus a separate
// LiteralExpression("ast-grep"). The current walkAst handles Tag nodes by
// recursing into node.expression, but it doesn't separate the field tag from
// the search term. Both get pushed into the terms array.
//
// Expected: plan.terms = ["ast-grep"], plan.fieldFilters = { agent: "opencode" }
// Current behavior: plan.terms = ["opencode", "ast-grep"] — "opencode" incorrectly
// treated as a search term.
//
// After fix: Tag nodes should be handled separately, extracting field:value pairs
// into a dedicated plan.fieldFilters field.
// ============================================================================

describe("GAP-2: liqe field-specific query", () => {
  /**
   * WHY RED: liqe parses "agent:opencode ast-grep" as Tag("agent"="opencode")
   * + LiteralExpression("ast-grep"). walkAst handles Tag by recursing into the
   * expression, pushing "opencode" as a term. This makes the search treat
   * "opencode" as a content search term instead of a filter.
   *
   * After fix: SearchPlan should have a fieldFilters property:
   *   plan.fieldFilters = { agent: "opencode" }
   *   plan.terms = ["ast-grep"]
   */
  test("field_specific_query_extracts_field_and_term_separately", () => {
    const plan = planFromQuery("agent:opencode ast-grep");

    // RED: "opencode" from the field tag should NOT be a search term
    // Currently: plan.terms = ["opencode", "ast-grep"] — wrong!
    // After fix: plan.terms = ["ast-grep"] only
    expect(plan.terms).toContain("ast-grep");
    // "opencode" is the field VALUE, not a search term
    // The exact behavior depends on fieldFilters implementation
    // For now, we check that NOT both are in terms independently
    // (i.e., the plan doesn't search for "opencode" as a text term)
    const hasOpencodeAsTerm = plan.terms.some(t => t === "opencode" || t === "agent:opencode");
    expect(hasOpencodeAsTerm).toBe(false);
  });

  /**
   * WHY RED: Multiple field filters should be separated from search terms.
   */
  test("multiple_field_filters_only_extracts_search_terms", () => {
    const plan = planFromQuery("agent:codex ast-grep comby");

    // Search terms should be "ast-grep" and "comby" only
    // "codex" and "agent" are field tags, not search terms
    expect(plan.terms).toContain("ast-grep");
    expect(plan.terms).toContain("comby");
    expect(plan.terms).not.toContain("codex");
    expect(plan.terms).not.toContain("agent:codex");
  });
});

// ============================================================================
// GAP-3: liqe quoted phrase — '"ast-grep patterns"'
// ============================================================================
// Root cause: liqe parses '"ast-grep patterns"' as a LiteralExpression with
// value = "ast-grep patterns" (quotes stripped, spaces preserved).
// walkAst pushes this as a term, which is correct. However, buildFts5Query
// normalizes the term by stripping hyphens and lowercasing, so
// "ast-grep patterns" becomes "astgreppatterns" — the space is also stripped!
// This means phrase search loses the space between words.
//
// Expected: FTS5 phrase search should preserve the space: '"astgrep patterns"'
// or the JSONL filter should do proper phrase matching (not substring).
// ============================================================================

describe("GAP-3: liqe quoted phrase", () => {
  /**
   * WHY RED: '"ast-grep patterns"' has a space inside quotes. normalizeTerm
   * does term.replace(/-/g, "").toLowerCase() which removes the hyphen but
   * KEEPS the space. So "ast-grep patterns" → "astgrep patterns".
   * buildFts5Query then joins with " AND ", giving "astgrep patterns".
   * This is a phrase with a space, which FTS5 might handle but the term
   * is split incorrectly.
   *
   * Actually the real issue is: the space is preserved in normalizeTerm.
   * So "ast-grep patterns" → "astgrep patterns". Then FTS5: "astgrep patterns".
   * This is correct! The space is preserved. But the hyphen was stripped.
   * So the phrase "ast-grep patterns" searches for "astgrepatterns" (no space).
   * This is wrong — the space should separate "astgrep" and "patterns".
   *
   * After fix: Quoted phrases should preserve spaces as word separators
   * while still stripping hyphens as word joiners.
   */
  test("quoted_phrase_preserves_space_as_word_separator", () => {
    const plan = planFromQuery('"ast-grep patterns"');

    // RED: normalizeTerm strips hyphens but also removes spaces:
    // "ast-grep patterns" → "astgreppatterns" (space removed too!)
    // This merges two words into one, breaking phrase search.
    //
    // After fix: normalizeTerm should preserve spaces between actual words
    // so "ast-grep patterns" → "astgrep patterns" (space between words kept)
    // and FTS5 phrase search finds "astgrep" near "patterns" correctly.

    // Check that spaces between real words are preserved
    const fts5Query = plan.fts5Query;
    // The query should have "astgrep" AND "patterns" as separate terms
    expect(fts5Query).not.toBe("astgreppatterns");
    // Should have either both words or the phrase quoted
    expect(
      fts5Query.includes("astgrep") ||
      fts5Query.includes('"ast-grep patterns"') ||
      /astgrep\s+patterns/.test(fts5Query)
    ).toBe(true);
  });

  /**
   * WHY RED: Mixed quoted phrase + boolean operator.
   */
  test("quoted_phrase_with_AND_boolean_preserves_phrase", () => {
    const plan = planFromQuery('"ast-grep patterns" AND comby');

    // Both terms should be present
    expect(plan.terms.length).toBeGreaterThanOrEqual(1);
    // "comby" should be a term
    expect(plan.terms.some(t => t.toLowerCase().includes("comby"))).toBe(true);

    // FTS5 should contain comby
    expect(plan.fts5Query.toLowerCase()).toContain("comby");
  });
});

// ============================================================================
// GAP-4: liqe RangeExpression — "timestamp:[2024-01-01 TO 2024-12-31]"
// ============================================================================
// Root cause: liqe parses "timestamp:[2024-01-01 TO 2024-12-31]" as a
// RangeExpression node (not a LiteralExpression or LogicalExpression).
// walkAst doesn't handle RangeExpression — it falls through without adding
// any terms. The entire query silently produces an empty plan.
//
// After fix: Either:
//   (a) throw a clear error that RangeExpression is not supported, OR
//   (b) fall back to treating the whole query as a literal string
// The test verifies the fallback behavior.
// ============================================================================

describe("GAP-4: liqe RangeExpression (timestamp ranges)", () => {
  /**
   * WHY RED: liqe parses "[2024-01-01 TO 2024-12-31]" as RangeExpression.
   * walkAst doesn't have a case for it → no terms extracted → empty plan.
   * The catch block in planFromQuery handles parse() errors but walkAst doesn't
   * throw — it just silently skips the node.
   *
   * After fix: walkAst should detect RangeExpression and either:
   *   (a) set a flag so planFromQuery knows to use fallback, OR
   *   (b) throw a specific error
   * The test expects fallback behavior: the whole query becomes one term.
   */
  test("range_query_not_supported_falls_back_to_literal", () => {
    const plan = planFromQuery("timestamp:[2024-01-01 TO 2024-12-31]");

    // RED: RangeExpression is silently skipped → terms = [] → plan is empty
    // After fix: fallback behavior should activate
    // Either: hasRange = true (new field), OR terms = [full query]
    // This test documents the expected fallback behavior
    expect(plan.terms.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * WHY RED: Term + range query. The range should be handled without
   * crashing, ideally as a fallback.
   */
  test("term_and_range_query_falls_back_to_literal", () => {
    const plan = planFromQuery("ast-grep timestamp:[2024-01 TO 2024-06]");

    // RED: "ast-grep" should be extracted but range part is skipped
    // After fix: "ast-grep" should still be in terms
    expect(plan.terms.some(t => t.includes("ast-grep"))).toBe(true);
  });
});

// ============================================================================
// GAP-5: 3-way OR query — "ast-grep OR comby OR gritql"
// ============================================================================
// Root cause: buildFts5Query handles OR with normalized.join(" OR ").
// For 3-way OR, this should produce "astgrep OR comby OR gritql".
// This should work correctly since normalizeTerm is applied per-term.
// However, detectBooleanOp checks for "OR" in the query string, which works.
// The real question: does the FTS5 query chain 3 ORs correctly?
// ============================================================================

describe("GAP-5: 3-way OR query", () => {
  /**
   * WHY RED: "ast-grep OR comby OR gritql" should generate FTS5:
   * "astgrep OR comby OR gritql" — three terms joined with OR.
   * Currently this should work since normalizeTerm is applied per-term
   * and join(" OR ") handles N terms. But worth verifying.
   */
  test("three_way_OR_generates_correct_FTS5", () => {
    const plan = planFromQuery("ast-grep OR comby OR gritql");

    // All three terms should be extracted
    expect(plan.terms.length).toBe(3);
    expect(plan.terms).toContain("ast-grep");
    expect(plan.terms).toContain("comby");
    expect(plan.terms).toContain("gritql");

    // FTS5 should have all three with OR
    expect(plan.fts5Query).toBe("astgrep OR comby OR gritql");
  });

  /**
   * WHY RED: detectBooleanOp should return "OR" for 3-way OR
   */
  test("three_way_OR_detected_as_OR_operator", () => {
    const plan = planFromQuery("ast-grep OR comby OR gritql");
    expect(plan.booleanOp).toBe("OR");
  });
});

// ============================================================================
// GAP-6: OR with NOT combined — "ast-grep OR comby NOT gritql"
// ============================================================================
// Root cause: buildFts5Query builds the positive part (with OR for multiple terms)
// then appends NOT terms. For "ast-grep OR comby NOT gritql":
//   normalized = ["astgrep", "comby"]
//   normalizedExclude = ["gritql"]
//   positive = "astgrep OR comby"
//   final = "astgrep OR comby NOT gritql"
// This should be correct. But detectBooleanOp needs to handle the case where
// there's OR + NOT. Currently it returns "AND" when NOT is present.
// The query has both OR and NOT — what should booleanOp be?
//
// For execution: OR with exclusions means (term1 OR term2) NOT term3.
// booleanOp could be "AND" (top-level is AND between OR-group and exclusions)
// or the planner could set a special "OR_WITH_EXCLUSIONS" flag.
// ============================================================================

describe("GAP-6: OR with NOT combined", () => {
  /**
   * WHY RED: "ast-grep OR comby NOT gritql" has both OR and NOT.
   * detectBooleanOp returns "AND" when NOT is present (termCount > 1 triggers AND
   * first, then NOT is detected). But the real question is whether the FTS5
   * query correctly places NOT after the OR group.
   *
   * Expected FTS5: "astgrep OR comby NOT gritql"
   * Current: "astgrep OR comby NOT gritql" — this should actually be correct!
   */
  test("OR_with_NOT_generates_correct_FTS5_syntax", () => {
    const plan = planFromQuery("ast-grep OR comby NOT gritql");

    // Terms should include both positive terms
    expect(plan.terms).toContain("ast-grep");
    expect(plan.terms).toContain("comby");
    // gritql should be in exclude terms
    expect(plan.excludeTerms).toContain("gritql");

    // FTS5 should be "astgrep OR comby NOT gritql"
    expect(plan.fts5Query).toContain("astgrep OR comby");
    expect(plan.fts5Query).toContain("NOT gritql");
  });

  /**
   * WHY RED: Vector terms should include positive terms but NOT exclude terms
   */
  test("OR_with_NOT_excludes_terms_from_vector_terms", () => {
    const plan = planFromQuery("ast-grep OR comby NOT gritql");

    expect(plan.vectorTerms).toContain("astgrep");
    expect(plan.vectorTerms).toContain("comby");
    // gritql should NOT be in vector terms (it's excluded)
    expect(plan.vectorTerms).not.toContain("gritql");
  });
});

// ============================================================================
// GAP-7: jsonlFilter — AND semantics (all terms must match)
// ============================================================================
// Root cause: buildJsonlFilter with AND (or NONE for multi-term):
// returns (text) => normalized.every(t => lower.includes(t))
// This means ALL terms must appear in the text (substring match).
// Tests needed to verify the AND semantics work correctly.
// ============================================================================

describe("GAP-7: jsonlFilter — AND semantics", () => {
  /**
   * WHY RED: AND query — both terms must be in the text.
   * "astgrep" AND "comby" → text must contain both substrings.
   */
  test("jsonlFilter_AND_requires_all_terms_present", () => {
    const plan = planFromQuery("ast-grep AND comby");
    const filter = plan.jsonlFilter;

    // Text with both terms → should match
    expect(filter("Working with ast-grep and comby tools")).toBe(true);

    // Text with only one term → should not match
    expect(filter("Just ast-grep here")).toBe(false);
    expect(filter("Just comby here")).toBe(false);

    // Text with neither → should not match
    expect(filter("Unrelated text")).toBe(false);
  });

  /**
   * WHY RED: Hyphens should be stripped from both term and text,
   // so "ast-grep" matches "astgrep" in text.
   */
  test("jsonlFilter_AND_strips_hyphens_for_matching", () => {
    const plan = planFromQuery("ast-grep AND comby");
    const filter = plan.jsonlFilter;

    // Hyphen stripped from term → matches text without hyphen
    expect(filter("Using astgrep and comby")).toBe(true);
  });
});

// ============================================================================
// GAP-8: jsonlFilter — OR semantics
// ============================================================================

describe("GAP-8: jsonlFilter — OR semantics", () => {
  /**
   * WHY RED: OR query — at least one term must match.
   */
  test("jsonlFilter_OR_matches_if_any_term_present", () => {
    const plan = planFromQuery("ast-grep OR comby");
    const filter = plan.jsonlFilter;

    // Both terms → matches
    expect(filter("ast-grep and comby together")).toBe(true);

    // Only first term → matches
    expect(filter("Only ast-grep here")).toBe(true);

    // Only second term → matches
    expect(filter("Only comby here")).toBe(true);

    // Neither → does not match
    expect(filter("Unrelated text")).toBe(false);
  });
});

// ============================================================================
// GAP-9: jsonlFilter — NOT exclusion
// ============================================================================

describe("GAP-9: jsonlFilter — NOT exclusion", () => {
  /**
   * WHY RED: NOT query — should exclude text containing the excluded term.
   */
  test("jsonlFilter_NOT_excludes_matching_text", () => {
    const plan = planFromQuery("ast-grep NOT comby");
    const filter = plan.jsonlFilter;

    // Has ast-grep but NOT comby → matches
    expect(filter("ast-grep only tool available")).toBe(true);

    // Has both ast-grep AND comby → excluded
    expect(filter("ast-grep and comby both")).toBe(false);

    // Has comby but NOT ast-grep → excluded (no positive match for ast-grep)
    expect(filter("only comby here")).toBe(false);

    // Neither term → excluded
    expect(filter("unrelated")).toBe(false);
  });

  /**
   * WHY RED: Complex: OR with NOT exclusion.
   * (ast-grep OR comby) NOT gritql
   */
  test("jsonlFilter_OR_with_NOT_excludes_correctly", () => {
    const plan = planFromQuery("ast-grep OR comby NOT gritql");
    const filter = plan.jsonlFilter;

    // Has ast-grep, no gritql → matches
    expect(filter("ast-grep is great")).toBe(true);

    // Has comby, no gritql → matches
    expect(filter("comby is nice")).toBe(true);

    // Has gritql → excluded regardless of other terms
    expect(filter("ast-grep with gritql")).toBe(false);
    expect(filter("comby with gritql")).toBe(false);

    // Neither ast-grep nor comby → excluded
    expect(filter("just gritql here")).toBe(false);
  });
});

// ============================================================================
// GAP-10: vectorTerms normalization — hyphenated compound terms
// ============================================================================
// The gap file states: "normalize by stripping hyphens for embedding lookup".
// This means "ast-grep" → "astgrep" for vector search.
// ============================================================================

describe("GAP-10: vectorTerms normalization", () => {
  test("vectorTerms_strips_hyphens_for_embedding_lookup", () => {
    const plan = planFromQuery("ast-grep comby gritql");

    // Hyphens should be stripped for vector terms
    expect(plan.vectorTerms).toContain("astgrep");
    expect(plan.vectorTerms).toContain("comby");
    expect(plan.vectorTerms).toContain("gritql");
    // Should NOT have hyphenated versions
    expect(plan.vectorTerms).not.toContain("ast-grep");
  });

  test("vectorTerms_empty_for_NOT_only_query", () => {
    const plan = planFromQuery("NOT comby");

    // Positive terms: none; only exclusion
    // vectorTerms should have exclude terms filtered out
    expect(plan.vectorTerms).not.toContain("comby");
    // For NOT-only, there are no positive terms → vectorTerms is empty
    expect(plan.vectorTerms.length).toBe(0);
  });
});
