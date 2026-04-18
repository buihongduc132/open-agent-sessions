/**
 * test/search-planner-backend-predicates.test.ts
 *
 * RED tests for REQ-22: Planner translates liqe AST to per-backend predicates
 * for all 3 backends (FTS5, JSONL, Vector).
 *
 * The SearchPlan interface MUST include:
 *   - fts5Query: string — FTS5 MATCH predicate for SQLite backends
 *   - jsonlFilter: (text: string) => boolean — streaming filter for JSONL backends
 *   - vectorTerms: string[] — terms for vector similarity search
 *
 * Architecture reference: _16apr_gaps.md "3-layer architecture — reuse library"
 *
 * TDD approach: Each test FAILS until the SearchPlan interface and planFromQuery
 * implementation produce correct per-backend predicates.
 */

import { describe, expect, test } from "bun:test";
import { planFromQuery, type SearchPlan } from "../src/search/planner";

// ============================================================================
// Test: SearchPlan has per-backend predicate fields
// ============================================================================

describe("REQ-22: SearchPlan per-backend predicates", () => {
  // ── Zone 1: Interface contract — all predicate fields exist ────────────────

  describe("Zone 1 — interface contract", () => {
    test("planFromQuery_simple_term_produces_fts5Query", () => {
      const plan = planFromQuery("ast-grep");
      // RED: fts5Query does not exist on SearchPlan yet
      expect(plan).toHaveProperty("fts5Query");
      expect(typeof plan.fts5Query).toBe("string");
      expect(plan.fts5Query.length).toBeGreaterThan(0);
    });

    test("planFromQuery_simple_term_produces_jsonlFilter", () => {
      const plan = planFromQuery("ast-grep");
      // RED: jsonlFilter does not exist on SearchPlan yet
      expect(plan).toHaveProperty("jsonlFilter");
      expect(typeof plan.jsonlFilter).toBe("function");
    });

    test("planFromQuery_simple_term_produces_vectorTerms", () => {
      const plan = planFromQuery("ast-grep");
      // RED: vectorTerms does not exist on SearchPlan yet
      expect(plan).toHaveProperty("vectorTerms");
      expect(Array.isArray(plan.vectorTerms)).toBe(true);
    });
  });

  // ── Zone 2: FTS5 predicate correctness ────────────────────────────────────

  describe("Zone 2 — FTS5 predicate (fts5Query)", () => {
    test("fts5Query_single_term_matches_term", () => {
      const plan = planFromQuery("comby");
      // Single term: fts5Query should be just the term
      expect(plan.fts5Query).toBe("comby");
    });

    test("fts5Query_AND_query_produces_fts5_AND_syntax", () => {
      const plan = planFromQuery("ast-grep AND comby");
      // FTS5 AND syntax: "term1 AND term2" or "term1 term2"
      expect(plan.fts5Query).toContain("astgrep");
      expect(plan.fts5Query).toContain("comby");
    });

    test("fts5Query_OR_query_produces_fts5_OR_syntax", () => {
      const plan = planFromQuery("comby OR gritql");
      // FTS5 OR syntax: "term1 OR term2"
      expect(plan.fts5Query).toContain("OR");
      expect(plan.fts5Query).toContain("comby");
      expect(plan.fts5Query).toContain("gritql");
    });

    test("fts5Query_NOT_query_excludes_term", () => {
      const plan = planFromQuery("ast-grep NOT comby");
      // FTS5 NOT: "astgrep NOT comby" or "astgrep -comby"
      expect(plan.fts5Query).toContain("astgrep");
      expect(plan.excludeTerms).toContain("comby");
    });
  });

  // ── Zone 3: JSONL filter correctness ───────────────────────────────────────

  describe("Zone 3 — JSONL filter (jsonlFilter)", () => {
    test("jsonlFilter_single_term_matches_text_containing_term", () => {
      const plan = planFromQuery("ast-grep");
      // jsonlFilter should match message text containing the term
      expect(plan.jsonlFilter("using ast-grep for code diff")).toBe(true);
    });

    test("jsonlFilter_single_term_rejects_text_without_term", () => {
      const plan = planFromQuery("ast-grep");
      expect(plan.jsonlFilter("using comby for pattern matching")).toBe(false);
    });

    test("jsonlFilter_AND_query_matches_only_when_all_terms_present", () => {
      const plan = planFromQuery("ast-grep AND comby");
      // Both terms must be present
      expect(plan.jsonlFilter("ast-grep and comby comparison")).toBe(true);
      expect(plan.jsonlFilter("ast-grep only session")).toBe(false);
      expect(plan.jsonlFilter("comby only session")).toBe(false);
    });

    test("jsonlFilter_OR_query_matches_when_any_term_present", () => {
      const plan = planFromQuery("comby OR gritql");
      // At least one term must be present
      expect(plan.jsonlFilter("comby pattern matching")).toBe(true);
      expect(plan.jsonlFilter("gritql code queries")).toBe(true);
      expect(plan.jsonlFilter("ast-grep diff tool")).toBe(false);
    });

    test("jsonlFilter_NOT_query_excludes_excluded_term", () => {
      const plan = planFromQuery("ast-grep NOT comby");
      // Must have ast-grep but NOT comby
      expect(plan.jsonlFilter("ast-grep for diffing")).toBe(true);
      expect(plan.jsonlFilter("ast-grep and comby comparison")).toBe(false);
      expect(plan.jsonlFilter("comby pattern matching")).toBe(false);
    });

    test("jsonlFilter_is_case_insensitive", () => {
      const plan = planFromQuery("AST-GREP");
      expect(plan.jsonlFilter("using ast-grep for code diff")).toBe(true);
      expect(plan.jsonlFilter("AST-GREP migration plan")).toBe(true);
    });
  });

  // ── Zone 4: Vector terms correctness ───────────────────────────────────────

  describe("Zone 4 — Vector terms (vectorTerms)", () => {
    test("vectorTerms_single_term_contains_term", () => {
      const plan = planFromQuery("comby");
      expect(plan.vectorTerms).toEqual(["comby"]);
    });

    test("vectorTerms_AND_query_contains_all_terms", () => {
      const plan = planFromQuery("ast-grep AND comby");
      // Vector search needs individual terms for embedding lookup
      expect(plan.vectorTerms).toContain("astgrep");
      expect(plan.vectorTerms).toContain("comby");
    });

    test("vectorTerms_OR_query_contains_all_terms", () => {
      const plan = planFromQuery("comby OR gritql");
      expect(plan.vectorTerms).toContain("comby");
      expect(plan.vectorTerms).toContain("gritql");
    });

    test("vectorTerms_NOT_query_excludes_not_terms", () => {
      const plan = planFromQuery("ast-grep NOT comby");
      // Only the positive terms go to vector search
      expect(plan.vectorTerms).toContain("astgrep");
      expect(plan.vectorTerms).not.toContain("comby");
    });
  });

  // ── Zone 5: Empty / edge cases ─────────────────────────────────────────────

  describe("Zone 5 — empty and edge cases", () => {
    test("empty_query_produces_empty_predicates", () => {
      const plan = planFromQuery("");
      expect(plan.fts5Query).toBe("");
      expect(plan.vectorTerms).toEqual([]);
      expect(plan.jsonlFilter("any text")).toBe(true); // empty filter matches everything
    });

    test("whitespace_only_query_produces_empty_predicates", () => {
      const plan = planFromQuery("   ");
      expect(plan.fts5Query).toBe("");
      expect(plan.vectorTerms).toEqual([]);
    });

    test("quoted_phrase_preserved_in_fts5Query", () => {
      const plan = planFromQuery('"ast-grep migration"');
      expect(plan.fts5Query).toContain("ast");
      expect(plan.fts5Query).toContain("grep");
    });
  });
});
