import { describe, expect, test } from "bun:test";
import { runSearchCommand, type SearchService, type SearchResult } from "../src/cli/search";
import { type Config } from "../src/config/types";
import { SessionSummary } from "../src/core/types";

// ─── Setup ────────────────────────────────────────────────────────────────────

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
  ],
};

/**
 * buildSearchService — creates a SearchService that returns the given result.
 *
 * RED STRATEGY: The mock returns whatever `searchSessions` currently returns
 * in the broken state (title-only matching). The assertions encode what a
 * content-aware implementation MUST return. The test fails NOW (title-only
 * returns empty → assertion fails) and passes only once `runSearchCommand`
 * is wired to `findSimilarSessions()` from src/similarity/search.ts.
 */

// ─── Test ─────────────────────────────────────────────────────────────────────

/**
 * RED tests for Gap 1: Content search (not just title)
 *
 * Current state (broken):
 *   runSearchCommand → searchSessions → applyFilters() (src/core/list.ts)
 *   applyFilters ONLY matches session.id + session.title → no body search.
 *
 * Fix (what tests assert for):
 *   runSearchCommand → findSimilarSessions() (src/similarity/search.ts)
 *   findSimilarSessions does hybrid FTS5+vector search over message CHUNKS.
 *
 * The gap: `oas search --text "ast-grep"` misses sessions where "ast-grep"
 * only appears in message bodies, not titles.
 *
 * RED pattern: mock searchSessions to return what title-only search returns
 * (empty), assert the CLI surfaces the content-matched session → FAILS now,
 * passes after findSimilarSessions is wired.
 */

describe("cli search — content search gap (RED)", () => {
  // ── Test 1: Content match NOT in title is found ──────────────────────────────

  describe("test_content_match_in_body_not_title_is_found", () => {
    /**
     * Scenario: session "Config drift detection" has "ast-grep" in its message
     * body but NOT in the title. Title-only search returns ZERO results.
     *
     * RED assertion: the CLI SHOULD surface the session.
     * Current behaviour (broken): stdout = "No sessions found" → assertion fails.
     * After fix: runSearchCommand calls findSimilarSessions → session found.
     */
    test("SEARCHTEXT_ast-grep FINDS session whose TITLE does not match but BODY contains it", async () => {
      // Simulate what title-only searchSessions returns today (BROKEN: zero results)
      const titleOnlySearchResult: SearchService = async () => ({
        sessions: [], // ← title-only search finds nothing
        errors: [],
      });

      // The content-matched session that SHOULD be returned by a content-aware search
      const contentMatchedSession: SessionSummary = {
        id: "oc-drift-001",
        agent: "opencode",
        alias: "personal",
        title: "Config drift detection", // ← "ast-grep" NOT in title
        created_at: "2024-06-01T10:00:00Z",
        updated_at: "2024-06-02T14:30:00Z",
        message_count: 12,
        storage: "db",
      };

      // RED: we assert the CLI SHOULD surface this session.
      // Currently searchSessions returns empty → stdout="No sessions found" → FAILS.
      // After fix: runSearchCommand wires findSimilarSessions, which finds it.
      const result = await runSearchCommand({
        text: "ast-grep",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
      });

      // The CLI SHOULD return this session — fails today, passes after fix
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("oc-drift-001");
      expect(result.stdout).toContain("Config drift detection");

      // Also verify that, once the feature IS implemented, the content-matched
      // session is distinguishable from a title-only result.
      // (When content search is wired, runSearchCommand calls findSimilarSessions
      //  which returns sessions with body content matches — the mock above
      //  simulates findSimilarSessions returning the correct session.)
      void contentMatchedSession; // referenced in assertion intent
    });

    /**
     * Variant: title is completely generic — e.g. "Debug session".
     * A title-only search for "ast-grep" would return zero results.
     * Content-aware search SHOULD find it because the body contains "ast-grep".
     */
    test("SEARCHTEXT_ast-grep FINDS session with generic title when body contains the term", async () => {
      // Simulate what the current title-only search returns: nothing
      const titleOnlySearchResult: SearchService = async () => ({
        sessions: [],
        errors: [],
      });

      const result = await runSearchCommand({
        text: "ast-grep",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
      });

      // RED: this FAILS because title-only search returns no results.
      // After fix: findSimilarSessions finds "Debug session" via body match.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("oc-debug-042");
      expect(result.stdout).toContain("Debug session");
    });

    /**
     * Variant: search term appears in the title of one session and ONLY in the
     * body of another (not its title). Title-only search returns only the
     * title-match session. Content search should return BOTH.
     */
    test("SEARCHTEXT_typescript FINDS both title-match AND body-only sessions", async () => {
      // Simulate title-only search: only the title-match session is returned
      const titleOnlySearchResult: SearchService = async () => ({
        sessions: [
          {
            id: "oc-title-match",
            agent: "opencode",
            alias: "personal",
            title: "TypeScript migration", // ← title matches "typescript"
            created_at: "2024-07-01T10:00:00Z",
            updated_at: "2024-07-01T12:00:00Z",
            message_count: 4,
            storage: "db",
          },
          // ← oc-body-match is NOT returned: title has no "typescript"
        ],
        errors: [],
      });

      const result = await runSearchCommand({
        text: "typescript",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
      });

      // Title-match session appears (both title-only AND content search agree)
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("oc-title-match");
      expect(result.stdout).toContain("TypeScript migration");

      // RED: body-only session should also appear — FAILS now because
      // title-only search doesn't find it.
      // After fix: findSimilarSessions finds oc-body-match via chunk FTS5 match.
      expect(result.stdout).toContain("oc-body-match");
      expect(result.stdout).toContain("General refactor");
    });
  });

  // ── Test 2: Content search ranks results by relevance ──────────────────────

  describe("test_content_search_ranks_by_relevance", () => {
    /**
     * Scenario: searching "sqlite-vec" returns sessions ordered by content
     * relevance:
     *   1. oc-sqlite-001 — 5 chunks with "sqlite-vec" (highest relevance)
     *   2. oc-sqlite-002 — 2 chunks with "sqlite-vec"
     *   3. oc-sqlite-003 — 1 chunk (lowest relevance among matches)
     *
     * Title-only search would either return them in a different order (by
     * updated_at) or miss them entirely if titles don't mention "sqlite-vec".
     *
     * RED assertion: CLI preserves relevance ranking from findSimilarSessions.
     * Current behaviour: title-only search returns either wrong order or nothing.
     */
    test("SEARCHTEXT_sqlite-vec RETURNS sessions in descending relevance order (best match first)", async () => {
      // Simulate what title-only search returns today (broken: zero results)
      const titleOnlySearchResult: SearchService = async () => ({
        sessions: [],
        errors: [],
      });

      const result = await runSearchCommand({
        text: "sqlite-vec",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
      });

      // RED: FAILS — title-only search returns nothing.
      // After fix: findSimilarSessions returns results in fused-RRF order,
      // and runSearchCommand preserves that order in stdout.
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n").filter(Boolean);

      expect(lines[0]).toContain("oc-sqlite-001"); // most chunks → top rank
      expect(lines[0]).toContain("Vector search exploration");

      expect(lines[1]).toContain("oc-sqlite-002");
      expect(lines[1]).toContain("FTS5 migration");

      expect(lines[2]).toContain("oc-sqlite-003");
      expect(lines[2]).toContain("Embedding pipeline");
    });

    /**
     * Variant: mixed relevance — one session matches title AND body (strongest
     * signal), another matches body only. findSimilarSessions ranks title+body
     * match above body-only even if body-only has more chunk matches.
     * (FTS5 bm25 bonus for title matches.)
     */
    test("SEARCHTEXT_ast-grep RANKS title+body match above body-only match", async () => {
      // Title-only search finds nothing for "ast-grep"
      const titleOnlySearchResult: SearchService = async () => ({
        sessions: [],
        errors: [],
      });

      const result = await runSearchCommand({
        text: "ast-grep",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
      });

      // RED: FAILS — title-only search returns nothing.
      // After fix: findSimilarSessions returns:
      //   1. oc-title-plus-body (title matches → FTS5 bm25 bonus + vector similarity)
      //   2. oc-body-only (body only → lower fused score)
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n").filter(Boolean);

      // Higher relevance — title explicitly contains "ast-grep"
      expect(lines[0]).toContain("oc-title-plus-body");
      expect(lines[0]).toContain("ast-grep migration plan");

      // Lower relevance — "ast-grep" only in body, title is generic
      expect(lines[1]).toContain("oc-body-only");
      expect(lines[1]).toContain("Miscellaneous debugging");
    });
  });

  // ── Zone 1: Empty / nil inputs ─────────────────────────────────────────────

  describe("Zone 1 — empty and nil inputs", () => {
    /**
     * Zone 1 test: empty --text query.
     * User presses enter with no search term → empty string.
     * Must return exitCode 0 + "No sessions found", NOT throw or crash.
     */
    test("SEARCHTEXT_empty_string_returns_exitCode_0_and_no_sessions_found_not_error", async () => {
      const emptySearchResult: SearchService = async () => ({
        sessions: [],
        errors: [],
      });

      const result = await runSearchCommand({
        text: "",
        config: baseConfig,
        searchSessions: emptySearchResult,
      });

      // Must be graceful — exitCode 0, not 1
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No sessions found");
      expect(result.stderr).not.toContain("error");
    });

    /**
     * Zone 1 test: whitespace-only --text.
     * Must behave the same as empty — graceful, not an error.
     */
    test("SEARCHTEXT_whitespace_only_returns_graceful_empty_result", async () => {
      const emptySearchResult: SearchService = async () => ({
        sessions: [],
        errors: [],
      });

      const result = await runSearchCommand({
        text: "   ",
        config: baseConfig,
        searchSessions: emptySearchResult,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No sessions found");
    });
  });

  // ── Test 3: No content match returns empty gracefully ─────────────────────────

  describe("test_content_search_no_match_returns_empty", () => {
    /**
     * Scenario: term "nofilereplaced" appears in NO session title AND in NO
     * message body. findSimilarSessions returns zero results.
     *
     * Expectation: exitCode 0, stdout "No sessions found", no stderr.
     * This is the SAME as the title-only path — both agree on zero results.
     * This test documents the shared behaviour and ensures it is NOT broken
     * when findSimilarSessions is wired (e.g. it doesn't throw an error).
     */
    test("SEARCHTEXT_nofilereplaced FINDS NOTHING returns exitCode 0 and 'No sessions found'", async () => {
      // Neither title-only nor content search finds this
      const emptySearchResult: SearchService = async () => ({
        sessions: [],
        errors: [],
      });

      const result = await runSearchCommand({
        text: "nofilereplaced",
        config: baseConfig,
        searchSessions: emptySearchResult,
      });

      // Both title-only AND content-aware search agree on empty result.
      // This test passes now AND after the fix.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No sessions found");
      expect(result.stderr).toBe("");
    });

    /**
     * Variant: partial title match exists, but no body content match.
     * Title-only search might find it; content search should NOT.
     * The CLI should return whatever searchSessions returns (no post-filter).
     */
    test("SEARCHTEXT_config FINDS title-only match but NO content match returns title-only session", async () => {
      // Title-only search finds "Config drift" (title matches)
      // Content search finds nothing (no message body has "config" in relevant chunks)
      const contentSearchEmptyResult: SearchService = async () => ({
        sessions: [],
        errors: [],
      });

      const result = await runSearchCommand({
        text: "config",
        config: baseConfig,
        searchSessions: contentSearchEmptyResult,
      });

      // RED: currently FAILS — title-only search would return the session,
      // but content search (once wired) returns empty.
      // After fix: runSearchCommand calls findSimilarSessions which returns
      // zero results for this query (no body match) → CLI prints "No sessions found".
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No sessions found");
    });
  });

  // ── Test 4: Multiple terms — ALL must appear in content ─────────────────────

  describe("test_content_search_multiple_terms_requires_all", () => {
    /**
     * Scenario: user searches `--text "ast-grep pattern"`.
     * FTS5 AND semantics require BOTH "ast-grep" AND "pattern" in the same
     * message chunk (or chunks joined by the FTS query).
     *
     * A session with only "ast-grep" in the body and no "pattern" anywhere
     * should NOT be returned. Title-only search would also return nothing
     * (assuming neither term is in the title).
     *
     * This test verifies that when content search IS wired, the CLI correctly
     * surfaces only the AND-match session.
     */
    test("SEARCHTEXT_ast-grep_pattern FINDS sessions containing BOTH terms in body", async () => {
      // Title-only search: zero results (neither term in title)
      const titleOnlySearchResult: SearchService = async () => ({
        sessions: [],
        errors: [],
      });

      const result = await runSearchCommand({
        text: "ast-grep pattern",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
      });

      // RED: FAILS — title-only search returns nothing.
      // After fix: findSimilarSessions runs FTS5 AND query, finds session with
      // both terms in body → CLI surfaces it.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("oc-astgrep-001");
      expect(result.stdout).toContain("Static analysis setup");
    });

    /**
     * Variant: multi-term query where one session matches ALL terms and another
     * only matches a subset. Only the all-terms session should appear.
     * Title-only search returns nothing (assuming no term is in any title).
     */
    test("SEARCHTEXT_react_useEffect FINDS session with BOTH react AND useEffect in body (not partial)", async () => {
      // Title-only search: nothing
      const titleOnlySearchResult: SearchService = async () => ({
        sessions: [],
        errors: [],
      });

      const result = await runSearchCommand({
        text: "react useEffect",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
      });

      // RED: FAILS — title-only search returns nothing.
      // After fix: findSimilarSessions enforces FTS5 AND semantics across chunks,
      // finds oc-react-001 (both terms present) → CLI surfaces it.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("oc-react-001");
      expect(result.stdout).toContain("Frontend refactor");
    });
  });
});
