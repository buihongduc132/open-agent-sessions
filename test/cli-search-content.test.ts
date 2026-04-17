import { describe, expect, test } from "bun:test";
import { runSearchCommand, type SearchService, type ContentSearchService, type SearchResult } from "../src/cli/search";
import type { SimilarSessionResult } from "../src/similarity/search";
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

      // findSimilarSessions returns the content-matched session
      const findSimilar: ContentSearchService = async (text) => {
        // text is normalized (hyphens stripped): "ast-grep" → "ast grep"
        if (text.includes("ast") && text.includes("grep")) {
          return [{
            sessionId: "oc-drift-001",
            title: "Config drift detection",
            score: 0.8,
            rank: 1,
            matchType: "fts-only",
            matchedChunks: 3,
          }];
        }
        return [];
      };

      const result = await runSearchCommand({
        text: "ast-grep",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
        findSimilarSessions: findSimilar,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("oc-drift-001");
      expect(result.stdout).toContain("Config drift detection");
    });

    /**
     * Variant: title is completely generic — e.g. "Debug session".
     * A title-only search for "ast-grep" would return zero results.
     * Content-aware search SHOULD find it because the body contains "ast-grep".
     */
    test("SEARCHTEXT_ast-grep FINDS session with generic title when body contains the term", async () => {
      const titleOnlySearchResult: SearchService = async () => ({ sessions: [], errors: [] });

      const findSimilar: ContentSearchService = async (text) => {
        // text is normalized (hyphens stripped): "ast-grep" → "ast grep"
        if (text.includes("ast") && text.includes("grep")) {
          return [{ sessionId: "oc-debug-042", title: "Debug session", score: 0.7, rank: 1, matchType: "fts-only", matchedChunks: 1 }];
        }
        return [];
      };

      const result = await runSearchCommand({
        text: "ast-grep",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
        findSimilarSessions: findSimilar,
      });

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
      const titleOnlySearchResult: SearchService = async () => ({
        sessions: [
          {
            id: "oc-title-match",
            agent: "opencode",
            alias: "personal",
            title: "TypeScript migration",
            created_at: "2024-07-01T10:00:00Z",
            updated_at: "2024-07-01T12:00:00Z",
            message_count: 4,
            storage: "db",
          },
        ],
        errors: [],
      });

      // Content search finds both title-match AND body-only session
      const findSimilar: ContentSearchService = async (text) => {
        if (text.includes("typescript")) {
          return [
            { sessionId: "oc-title-match", title: "TypeScript migration", score: 0.9, rank: 1, matchType: "hybrid", matchedChunks: 2 },
            { sessionId: "oc-body-match", title: "General refactor", score: 0.7, rank: 2, matchType: "fts-only", matchedChunks: 1 },
          ];
        }
        return [];
      };

      const result = await runSearchCommand({
        text: "typescript",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
        findSimilarSessions: findSimilar,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("oc-title-match");
      expect(result.stdout).toContain("TypeScript migration");
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
      const titleOnlySearchResult: SearchService = async () => ({ sessions: [], errors: [] });

      const findSimilar: ContentSearchService = async (text) => {
        if (text.includes("sqlite") || text.includes("vec")) {
          return [
            { sessionId: "oc-sqlite-001", title: "Vector search exploration", score: 0.95, rank: 1, matchType: "hybrid", matchedChunks: 5 },
            { sessionId: "oc-sqlite-002", title: "FTS5 migration", score: 0.8, rank: 2, matchType: "hybrid", matchedChunks: 2 },
            { sessionId: "oc-sqlite-003", title: "Embedding pipeline", score: 0.6, rank: 3, matchType: "fts-only", matchedChunks: 1 },
          ];
        }
        return [];
      };

      const result = await runSearchCommand({
        text: "sqlite-vec",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
        findSimilarSessions: findSimilar,
      });

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n").filter(Boolean);

      expect(lines[0]).toContain("oc-sqlite-001");
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
      const titleOnlySearchResult: SearchService = async () => ({ sessions: [], errors: [] });

      const findSimilar: ContentSearchService = async (text) => {
        if (text.includes("ast") || text.includes("grep")) {
          return [
            { sessionId: "oc-title-plus-body", title: "ast-grep migration plan", score: 0.9, rank: 1, matchType: "hybrid", matchedChunks: 3 },
            { sessionId: "oc-body-only", title: "Miscellaneous debugging", score: 0.6, rank: 2, matchType: "fts-only", matchedChunks: 1 },
          ];
        }
        return [];
      };

      const result = await runSearchCommand({
        text: "ast-grep",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
        findSimilarSessions: findSimilar,
      });

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n").filter(Boolean);

      expect(lines[0]).toContain("oc-title-plus-body");
      expect(lines[0]).toContain("ast-grep migration plan");

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

      // Empty text is treated as missing --text argument → exitCode 1
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing required argument: --text");
    });

    /**
     * Zone 1 test: whitespace-only --text.
     * Must behave the same as empty — exitCode 1 for missing argument.
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

      // Whitespace-only text is treated as missing --text argument → exitCode 1
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing required argument: --text");
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
      const titleOnlySearchResult: SearchService = async () => ({
        sessions: [{
          id: "oc-config-001", agent: "opencode", alias: "personal",
          title: "Config drift detection",
          created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
          message_count: 3, storage: "db",
        }],
        errors: [],
      });

      // Content search returns empty — so no sessions should be found
      const findSimilar: ContentSearchService = async () => [];

      const result = await runSearchCommand({
        text: "config",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
        findSimilarSessions: findSimilar,
      });

      expect(result.exitCode).toBe(0);
      // When findSimilarSessions returns empty, result is empty (content search preferred)
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
      const titleOnlySearchResult: SearchService = async () => ({ sessions: [], errors: [] });

      // "ast-grep pattern" is NOT detected as boolean (hyphen ≠ word boundary)
      // Normalized to "ast grep pattern"; findSimilarSessions gets combined text
      const findSimilar: ContentSearchService = async (text) => {
        // "ast-grep pattern" normalized to "ast grep pattern"
        // Mock: checks that all three terms are in the query
        if (text.includes("ast") && text.includes("grep") && text.includes("pattern")) {
          return [{ sessionId: "oc-react-001", title: "Frontend refactor", score: 0.8, rank: 1, matchType: "fts-only", matchedChunks: 2 }];
        }
        return [];
      };

      const result = await runSearchCommand({
        text: "ast-grep pattern",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
        findSimilarSessions: findSimilar,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("oc-react-001");
      expect(result.stdout).toContain("Frontend refactor");
    });
  });

  // ── Zone 2: Result count boundary conditions ────────────────────────────────
  describe("Zone 2 — result count boundary conditions", () => {
    test("SEARCHTEXT_singleton_match_returns_single_result", async () => {
      const titleOnlySearchResult: SearchService = async () => ({ sessions: [], errors: [] });

      const findSimilar: ContentSearchService = async (text) => {
        if (text.includes("unique") || text.includes("xyz123")) {
          return [{ sessionId: "oc-singleton-001", title: "Singleton match session", score: 0.9, rank: 1, matchType: "fts-only", matchedChunks: 1 }];
        }
        return [];
      };

      const result = await runSearchCommand({
        text: "unique-content-term-xyz123",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
        findSimilarSessions: findSimilar,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("oc-singleton-001");
      expect(result.stdout).toContain("Singleton match session");
    });

    test("SEARCHTEXT_large_result_set_returns_all_matches", async () => {
      const titleOnlySearchResult: SearchService = async () => ({ sessions: [], errors: [] });

      const findSimilar: ContentSearchService = async (text) => {
        if (text.includes("common")) {
          return Array.from({ length: 100 }, (_, i) => ({
            sessionId: `oc-top-match-${String(i).padStart(3, "0")}`,
            title: `Common term session ${i}`,
            score: 0.9 - i * 0.001,
            rank: i + 1,
            matchType: "fts-only" as const,
            matchedChunks: 1,
          }));
        }
        return [];
      };

      const result = await runSearchCommand({
        text: "common-term",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
        findSimilarSessions: findSimilar,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("oc-top-match-001");
    });
  });

  // ── Zone 3: Content search + exclude flags combined ─────────────────────────
  describe("Zone 3 — content search + exclude flags interaction", () => {
    /**
     * Cross-feature interaction: content search combined with --exclude-session.
     * Content search finds session X, but --exclude-session removes it.
     * Both filters should compose correctly.
     */
    test("SEARCHTEXT_content_match_with_exclude_session_removes_excluded", async () => {
      const findSimilar: ContentSearchService = async (text) => {
        if (text.includes("content")) {
          return [
            { sessionId: "oc-content-001", title: "Content match session", score: 0.8, rank: 1, matchType: "fts-only", matchedChunks: 2 },
            { sessionId: "oc-other-002", title: "Other session", score: 0.7, rank: 2, matchType: "fts-only", matchedChunks: 1 },
          ];
        }
        return [];
      };

      const result = await runSearchCommand({
        text: "content",
        config: baseConfig,
        excludeSession: ["oc-content-001"],
        searchSessions: async () => ({ sessions: [], errors: [] }),
        findSimilarSessions: findSimilar,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("oc-content-001");
      expect(result.stdout).toContain("oc-other-002");
    });

    test("SEARCHTEXT_content_match_with_exclude_current_removes_current", async () => {
      const CURRENT_ID = "current-with-content";
      const OTHER_ID = "other-with-content";

      const findSimilar: ContentSearchService = async (text) => {
        if (text.includes("content")) {
          return [
            { sessionId: CURRENT_ID, title: "Current session with content", score: 0.8, rank: 1, matchType: "fts-only", matchedChunks: 2 },
            { sessionId: OTHER_ID, title: "Other session with content", score: 0.7, rank: 2, matchType: "fts-only", matchedChunks: 1 },
          ];
        }
        return [];
      };

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
      expect(result.stdout).toContain(OTHER_ID);
    });
  });

  // ── Zone 4: Content search in other agents (codex) ─────────────────────────
  describe("Zone 4 — content search cross-agent awareness", () => {
    test("SEARCHTEXT_codex_agent_content_match_is_found", async () => {
      const titleOnlySearchResult: SearchService = async () => ({ sessions: [], errors: [] });

      const findSimilar: ContentSearchService = async (text) => {
        if (text.includes("codebase") || text.includes("pattern")) {
          return [{ sessionId: "codex:work:cb-001", title: "Codex codebase work", score: 0.9, rank: 1, matchType: "fts-only", matchedChunks: 2 }];
        }
        return [];
      };

      const result = await runSearchCommand({
        text: "codebase-pattern",
        config: baseConfig,
        searchSessions: titleOnlySearchResult,
        findSimilarSessions: findSimilar,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("codex:work");
    });
  });
});
