/**
 * test/cli-gaps-edge-cases-5.test.ts
 *
 * RED tests for edge cases NOT covered by ANY existing test suite:
 *   - test/cli-search.test.ts
 *   - test/cli-search-boolean.test.ts
 *   - test/cli-search-content.test.ts
 *   - test/cli-gaps-edge-cases.test.ts  (20 tests: findSimilarSessions throws, dedup, special chars, unicode, operators-only, long query, partial service failure, quoted phrase, exclude without ID, exclude from content, empty exclude array, --last large, range start=end, --first --user-only, system-only session, deep fork chain, orphan chain, roots+children conflict, missing title fallback, siblings)
 *   - test/cli-gaps-edge-cases-2.test.ts (7 tests: regex /pattern/, Boolean+content interaction, empty-string title fallback, dead code planFromQuery/applyBooleanLogic, normalizeFuzzyQuery hyphens, error dedup)
 *   - test/cli-gaps-edge-cases-3.test.ts (4 tests: /g flag regex bug, ReDoS protection)
 *   - test/cli-gaps-edge-cases-4.test.ts (7 tests: buildForkChain circular reference, --sub-only flag, boolean hyphen normalization, whitespace title, main/sub role tags)
 *   - test/cli-tree.test.ts
 *   - test/cli-read-composable.test.ts
 *
 * All tests below MUST fail with the current code. Each targets a specific
 * untested edge case that reveals a real bug or missing behavior.
 */

import { describe, expect, test } from "bun:test";
import {
  runSearchCommand,
  type SearchService,
  type ContentSearchService,
} from "../src/cli/search";
import { runListCommand, type ListService } from "../src/cli/list";
import { type Config } from "../src/config/types";
import { type SessionSummary, type SearchQuery } from "../src/core/types";

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
// GAP 1 — Regex pattern with parentheses intercepted by boolean tokenizer
// ============================================================================
// Root cause: Two bugs compound:
//   1. isBooleanQuery() detects parentheses inside /pattern/ → returns true,
//      routing the query through the boolean parser instead of the regex branch.
//   2. The boolean tokenizer breaks /(a{2,}){3,}/ into individual tokens:
//     TERM("/"), LPAREN, TERM("a{2,}"), RPAREN, TERM("{3,}/")
//     The parser reduces this to just term("/"), discarding the entire regex.
//
// Additionally, even if the regex branch WERE reached, hasNestedQuantifiers
// only checks for +* inside groups, not {n,} curly brace quantifiers.
//
// Expected fix: isRegexPattern() should be checked BEFORE isBooleanQuery(),
// OR isBooleanQuery() should strip /pattern/ delimiters before checking for
// operators/parens. Also extend hasNestedQuantifiers to detect {n,} patterns.
// ============================================================================

describe("GAP 1 — Regex pattern with parentheses intercepted by boolean tokenizer", () => {
  /**
   * WHY RED: `/(a{2,}){3,}/` contains `()` which triggers isBooleanQuery().
   * The boolean tokenizer breaks it into: TERM("/"), LPAREN, TERM("a{2,}"),
   * RPAREN, TERM("{3,}/"). The parser produces term("/") and the search
   * service receives "/" as the query text — the regex is never evaluated.
   * capturedQuery is "/" but should be either the full regex or a wildcard.
   *
   * After fix: isRegexPattern check should happen before isBooleanQuery, or
   * isBooleanQuery should be delimiter-aware so regex patterns aren't
   * misrouted to the boolean parser.
   */
  test("regex_curly_brace_nested_quantifier_intercepted_by_boolean_parser", async () => {
    let capturedQuery = "";

    const result = await runSearchCommand({
      text: "/(a{2,}){3,}/",
      config: baseConfig,
      searchSessions: async (query) => {
        capturedQuery = query.text;
        return { sessions: [], errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);

    // RED: capturedQuery is "/" (boolean parser mangled the regex)
    // After fix: the regex branch should handle this, sending "e" to
    // searchSessions (wildcard for regex filtering)
    expect(capturedQuery).toBe("e");
  });

  /**
   * WHY RED: Same issue with bounded quantifiers — parens in the regex
   * pattern trigger boolean mode, and the tokenizer destroys the pattern.
   */
  test("regex_bounded_curly_brace_intercepted_by_boolean_parser", async () => {
    let capturedQuery = "";

    const result = await runSearchCommand({
      text: "/(a{1,10}){2,}/",
      config: baseConfig,
      searchSessions: async (query) => {
        capturedQuery = query.text;
        return { sessions: [], errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);

    // RED: capturedQuery is "/" (boolean parser mangled the regex)
    // After fix: regex branch should handle this pattern
    expect(capturedQuery).toBe("e");
  });
});

// ============================================================================
// GAP 2 — Plain search path does not normalize tabs/newlines
// ============================================================================
// Root cause: In runSearchCommand, the non-boolean, non-regex, no-content-search
// path sends rawQuery directly to searchSessions WITHOUT calling
// normalizeFuzzyQuery. The content search path normalizes, but the plain
// title-only path does not. This means queries with tabs (\t) or newlines (\n)
// are sent to the search backend verbatim, causing mismatches.
//
// Expected fix: Apply normalizeFuzzyQuery to rawQuery in the plain search path
// before passing to searchSessions, consistent with the content search path.
// ============================================================================

describe("GAP 2 — Plain search does not normalize tabs and newlines", () => {
  /**
   * WHY RED: The query "hello\t\tworld" contains literal tab characters.
   * In the plain search path (no boolean, no regex, no findSimilarSessions),
   * rawQuery goes directly to searchSessions without normalization.
   * The mock receives "hello\t\tworld" instead of the expected "hello world".
   *
   * After fix: normalizeFuzzyQuery should be applied before the searchSessions
   * call in the plain path, collapsing all whitespace to single spaces.
   *
   * Fix: In the else branch at line ~203 of search.ts, change:
   *   const query = { text: rawQuery };
   * to:
   *   const query = { text: normalizeFuzzyQuery(rawQuery) };
   */
  test("plain_search_normalizes_tabs_before_sending_to_service", async () => {
    let receivedText = "";

    const result = await runSearchCommand({
      text: "hello\t\tworld",
      config: baseConfig,
      searchSessions: async (query) => {
        receivedText = query.text;
        return { sessions: [], errors: [] };
      },
      // No findSimilarSessions — forces plain search path
    });

    expect(result.exitCode).toBe(0);

    // RED: receivedText is "hello\t\tworld" (raw tabs preserved)
    // After fix: should be "hello world" (tabs collapsed by normalizeFuzzyQuery)
    expect(receivedText).toBe("hello world");
  });

  /**
   * WHY RED: Same issue with newlines. A query like "hello\nworld" should
   * be normalized to "hello world" before being sent to the search backend.
   */
  test("plain_search_normalizes_newlines_before_sending_to_service", async () => {
    let receivedText = "";

    const result = await runSearchCommand({
      text: "hello\nworld",
      config: baseConfig,
      searchSessions: async (query) => {
        receivedText = query.text;
        return { sessions: [], errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);

    // RED: receivedText contains literal newline
    expect(receivedText).toBe("hello world");
  });
});

// ============================================================================
// GAP 3 — Double NOT without AND produces empty results (universe too small)
// ============================================================================
// Root cause: "NOT term-a NOT term-b" is parsed as AND(NOT(term-a), NOT(term-b))
// by the implicit AND rule in parseAnd(). However, the universe is only seeded
// with sessions matching term-a OR term-b. The wildcard expansion at line 377
// of search-boolean.ts only triggers when `ast.type === "not"` at the root,
// but the root here is `and`. So the universe is too small — it doesn't include
// sessions that match NEITHER term.
//
// NOT(term-a) against universe {term-a matches, term-b matches} =
//   {term-b matches only}
// NOT(term-b) against universe {term-a matches, term-b matches} =
//   {term-a matches only}
// AND of both = {} (empty intersection)
//
// Expected: sessions that match NEITHER term-a NOR term-b should appear.
//
// Expected fix: When the AST contains NOT nodes that aren't at the root,
// also do a wildcard expansion to ensure the universe includes all sessions.
// ============================================================================

describe("GAP 3 — Double NOT without AND gives empty results", () => {
  /**
   * WHY RED: "NOT term-a NOT term-b" is parsed as AND(NOT(term-a), NOT(term-b)).
   * The universe is only seeded from term-a and term-b search results.
   * Wildcard expansion doesn't trigger (root is `and`, not `not`).
   * The complement of each NOT is computed against the small universe,
   * and their intersection is always empty.
   *
   * The test expects sessions matching NEITHER term to appear in results,
   * but they're absent because they were never seeded into the universe.
   *
   * Fix: In executeBooleanSearch, detect when NOT nodes exist anywhere in
   * the AST (not just at root) and do wildcard expansion to ensure full universe.
   */
  test("double_NOT_query_returns_complement_of_both_terms", async () => {
    const sessions = [
      makeSession("ses-a", "opencode", "personal", "term-a session"),
      makeSession("ses-b", "opencode", "personal", "term-b session"),
      makeSession("ses-c", "opencode", "personal", "unrelated charlie"),
      makeSession("ses-d", "opencode", "personal", "other delta"),
    ];

    const result = await runSearchCommand({
      text: "NOT terma NOT termb",
      config: baseConfig,
      searchSessions: async (query) => {
        const text = query.text.toLowerCase();
        if (text === "e") {
          return { sessions, errors: [] };
        }
        const normalizedText = text.replace(/-/g, "");
        const results = sessions.filter((s) => {
          const normalizedTitle = s.title.toLowerCase().replace(/-/g, "");
          return normalizedTitle.includes(normalizedText);
        });
        return { sessions: results, errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);

    // Should return sessions matching NEITHER terma NOR termb
    expect(result.stdout).toContain("ses-c");
    expect(result.stdout).toContain("ses-d");
    // Should NOT return sessions matching the excluded terms
    expect(result.stdout).not.toContain("ses-a");
    expect(result.stdout).not.toContain("ses-b");
  });
});

// ============================================================================
// GAP 4 — NOT with compound operand (AND/OR) evaluates incorrectly
// ============================================================================
// Root cause: In evalNode's "not" case, the operand's term value is only
// extracted when `node.operand.type === "term"`. For compound operands like
// `and(term("alpha"), term("bravo"))`, termValue is set to "" (empty string).
// The empty string is then searched, which either matches everything or nothing
// depending on the backend, producing incorrect complement results.
//
// "NOT (alpha AND bravo)" should exclude sessions that have BOTH alpha AND bravo.
// Instead, the code searches for "" (matches all), excludes all, returns empty.
//
// Expected fix: The NOT case should recursively evaluate compound operands
// using evalNode (or a dedicated subset) to get the correct set of sessions
// to exclude, rather than flattening the operand to a single term string.
// ============================================================================

describe("GAP 4 — NOT with compound AND operand evaluates incorrectly", () => {
  /**
   * WHY RED: "NOT (alpha AND bravo)" has a compound operand (and node).
   * The NOT evaluator only extracts a term value from simple term nodes,
   * so termValue becomes "". Searching for "" returns all sessions from the
   * mock, which are then all excluded → empty result.
   *
   * After fix: The NOT evaluator should recursively evaluate the compound
   * operand to find sessions matching "alpha AND bravo", then exclude only
   * those from the universe.
   *
   * Fix: In the "not" case of evalNode, when node.operand is not a term,
   * recursively evaluate it to get the sessions to exclude.
   */
  test("NOT_with_AND_operand_excludes_only_intersection", async () => {
    const sessions = [
      makeSession("ses-ab", "opencode", "personal", "alpha bravo session"),
      makeSession("ses-a", "opencode", "personal", "alpha only session"),
      makeSession("ses-b", "opencode", "personal", "bravo only session"),
      makeSession("ses-none", "opencode", "personal", "charlie delta session"),
    ];

    const result = await runSearchCommand({
      text: "NOT (alpha AND bravo)",
      config: baseConfig,
      searchSessions: async (query) => {
        const text = query.text.trim().toLowerCase();
        if (!text || text === "e") {
          return { sessions, errors: [] };
        }
        const results = sessions.filter((s) =>
          s.title.toLowerCase().includes(text)
        );
        return { sessions: results, errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);

    // NOT (alpha AND bravo) should return everything EXCEPT ses-ab
    expect(result.stdout).toContain("ses-a");
    expect(result.stdout).toContain("ses-b");
    expect(result.stdout).toContain("ses-none");
    // ses-ab has BOTH alpha AND bravo → should be excluded
    expect(result.stdout).not.toContain("ses-ab");
  });

  /**
   * WHY RED: "NOT (alpha OR bravo)" has a compound OR operand. Same bug —
   * termValue becomes "" → all sessions excluded → empty result.
   * Should exclude sessions matching alpha OR bravo, keeping only the rest.
   */
  test("NOT_with_OR_operand_excludes_only_union", async () => {
    const sessions = [
      makeSession("ses-a", "opencode", "personal", "alpha session"),
      makeSession("ses-b", "opencode", "personal", "bravo session"),
      makeSession("ses-none", "opencode", "personal", "charlie delta"),
    ];

    const result = await runSearchCommand({
      text: "NOT (alpha OR bravo)",
      config: baseConfig,
      searchSessions: async (query) => {
        const text = query.text.trim().toLowerCase();
        if (!text || text === "e") {
          return { sessions, errors: [] };
        }
        const results = sessions.filter((s) =>
          s.title.toLowerCase().includes(text)
        );
        return { sessions: results, errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);

    // NOT (alpha OR bravo) should return only ses-none
    expect(result.stdout).toContain("ses-none");
    expect(result.stdout).not.toContain("ses-a");
    expect(result.stdout).not.toContain("ses-b");
  });
});

// ============================================================================
// GAP 5 — NOT followed by implicit AND term silently drops trailing term
// ============================================================================
// Root cause: The parser's parseAnd() loop only looks for explicit AND or NOT
// tokens to continue. A bare TERM after a NOT expression exits parseAnd's
// while loop, causing the term to be silently dropped.
//
// "NOT alpha bravo" → tokens: [NOT, "alpha", "bravo"]
// Parser produces: not(term("alpha")) — "bravo" is never parsed.
//
// The user likely expects: NOT alpha AND bravo = sessions with bravo but not alpha.
// Actual result: all sessions NOT matching alpha (bravo constraint ignored).
//
// Expected fix: parseAnd should also continue on bare TERM tokens (implicit AND).
// ============================================================================

describe("GAP 5 — NOT followed by implicit AND term drops trailing term", () => {
  /**
   * WHY RED: "NOT alpha bravo" is parsed as not(term("alpha")) with "bravo"
   * silently dropped. The result is all sessions NOT matching alpha, including
   * sessions that don't have "bravo" at all. The test expects only sessions
   * that have "bravo" but NOT "alpha".
   *
   * After fix: parseAnd should treat bare TERM after NOT as implicit AND,
   * producing: and(not(term("alpha")), term("bravo")).
   *
   * Fix: In parseAnd's while loop, add TERM as a continuation trigger:
   *   while (peek.type === "AND" || peek.type === "NOT" || peek.type === "TERM")
   */
  test("NOT_alpha_bravo_does_not_drop_bravo_term", async () => {
    const sessions = [
      makeSession("ses-ab", "opencode", "personal", "alpha bravo session"),
      makeSession("ses-a", "opencode", "personal", "alpha only session"),
      makeSession("ses-b", "opencode", "personal", "bravo only session"),
      makeSession("ses-none", "opencode", "personal", "charlie delta"),
    ];

    const result = await runSearchCommand({
      text: "NOT alpha bravo",
      config: baseConfig,
      searchSessions: async (query) => {
        const text = query.text.trim().toLowerCase();
        if (!text || text === "e") {
          return { sessions, errors: [] };
        }
        const results = sessions.filter((s) =>
          s.title.toLowerCase().includes(text)
        );
        return { sessions: results, errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);

    // "NOT alpha bravo" should mean: (NOT alpha) AND bravo
    // Only ses-b qualifies: has bravo, does NOT have alpha
    expect(result.stdout).toContain("ses-b");
    // ses-none has neither → should NOT appear (doesn't have bravo)
    expect(result.stdout).not.toContain("ses-none");
    // ses-ab has alpha → should NOT appear
    expect(result.stdout).not.toContain("ses-ab");
    // ses-a has alpha → should NOT appear
    expect(result.stdout).not.toContain("ses-a");
  });
});

// ============================================================================
// GAP 6 — Boolean regex term leaks flags into content search text
// ============================================================================
// Root cause: In the boolean searchTerm callback, when a term is a regex
// pattern and findSimilarSessions is available, the code normalizes the term:
//
//   normalizeFuzzyQuery(searchText.replace(/^\/|\/$/g, ""))
//
// For "/test/i", this strips the first "/" and last "/" → "test/i".
// The "i" flag is NOT stripped because replace(/^\/|\/$/g, "") only removes
// leading/trailing slashes, not trailing flags. So findSimilarSessions
// receives "test/i" instead of "test".
//
// Expected fix: Strip regex flags after removing delimiters:
//   searchText.replace(/^\/|\/[gimsuy]*$/g, "")
// ============================================================================

describe("GAP 6 — Boolean regex term leaks flags into content search", () => {
  /**
   * WHY RED: The regex term "/test/i" in a boolean query has its outer slashes
   * stripped but the "i" flag remains. findSimilarSessions receives "test/i"
   * instead of "test". The content search for "test/i" won't find sessions
   * that contain "test" in their body, because the backend searches for the
   * literal string "test/i".
   *
   * After fix: The code should strip the trailing flags along with the closing
   * slash: replace(/^\/|\/[gimsuy]*$/g, "") → "/test/i" becomes "test".
   *
   * Fix: Change line ~109 in search.ts from:
   *   normalizeFuzzyQuery(searchText.replace(/^\/|\/$/g, ""))
   * to:
   *   normalizeFuzzyQuery(searchText.replace(/^\/|\/[gimsuy]*$/g, ""))
   */
  test("boolean_regex_term_strips_flags_for_content_search", async () => {
    let contentSearchText = "";

    const findSimilar: ContentSearchService = async (text) => {
      contentSearchText = text;
      return [];
    };

    const result = await runSearchCommand({
      text: "/test/i AND alpha",
      config: baseConfig,
      searchSessions: async () => ({ sessions: [], errors: [] }),
      findSimilarSessions: findSimilar,
    });

    expect(result.exitCode).toBe(0);

    // RED: contentSearchText is "test/i" (flag leaked) instead of "test"
    expect(contentSearchText).toBe("test");
  });

  /**
   * WHY RED: Multiple flags "/test/gi" → after stripping outer slashes: "test/gi"
   * Both "g" and "i" flags leak into the content search query.
   */
  test("boolean_regex_term_strips_multiple_flags_for_content_search", async () => {
    let contentSearchText = "";

    const findSimilar: ContentSearchService = async (text) => {
      contentSearchText = text;
      return [];
    };

    const result = await runSearchCommand({
      text: "bravo OR /pattern/gi",
      config: baseConfig,
      searchSessions: async () => ({ sessions: [], errors: [] }),
      findSimilarSessions: findSimilar,
    });

    expect(result.exitCode).toBe(0);

    // RED: "pattern/gi" instead of "pattern"
    expect(contentSearchText).toBe("pattern");
  });
});

// ============================================================================
// GAP 7 — Boolean operators-only query "AND OR" searches for literal "AND"
// ============================================================================
// Root cause: The tokenizer produces AND and OR tokens with no TERM tokens
// between them. The parser's parsePrimary() doesn't handle AND/OR tokens —
// it falls through to the default case which consumes the token and returns
// term(token.value). So "AND" becomes a literal search term.
//
// "AND OR" → parsePrimary consumes AND token → term("AND")
// Then parseOr sees OR → parseAnd → parsePrimary → consumes EOF → term("")
// Final AST: or(term("AND"), term(""))
//
// The search actually queries for sessions with "AND" in their titles.
//
// Expected fix: parsePrimary should reject AND/OR/NOT tokens (throw parse error)
// or the tokenizer should detect consecutive operators without intervening terms.
// ============================================================================

describe("GAP 7 — Boolean operators-only query searches for literal operator text", () => {
  /**
   * WHY RED: The parser treats "AND" as a literal search term when it appears
   * in a position where a TERM is expected. The searchSessions mock receives
   * "AND" as query text and searches for the literal word "AND" in titles.
   * This is nonsensical — the user clearly meant boolean operators, not content.
   *
   * After fix: The parser should detect that no actual search terms exist and
   * either return empty results or a parse error.
   *
   * Fix: In parsePrimary, if the token is AND/OR/NOT, throw or return an
   * empty term node that gets filtered downstream.
   */
  test("operators_only_AND_OR_does_not_search_for_literal_AND", async () => {
    const capturedQueries: string[] = [];

    const result = await runSearchCommand({
      text: "AND OR",
      config: baseConfig,
      searchSessions: async (query) => {
        capturedQueries.push(query.text);
        return { sessions: [], errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);

    // The result should be "No sessions found" since there are no real terms
    expect(result.stdout).toContain("No sessions found");

    // RED: The mock is called with "AND" as a search term (the operator
    // is treated as literal text). After fix: no search should be performed
    // for bare operators, or an empty query should be sent.
    expect(capturedQueries).not.toContain("and");
  });
});

// ============================================================================
// GAP 8 — formatSessionRow with newline in title breaks one-line-per-session
// ============================================================================
// Root cause: formatSessionRow in list.ts includes the session title verbatim
// without sanitizing embedded newlines. If a session title contains "\n",
// the output row spans multiple lines, breaking the one-session-per-line
// format that consumers (TUI, piping, grep) depend on.
//
// Expected fix: Replace newlines (and other control characters) with spaces
// or escape them before including in the output row.
// ============================================================================

describe("GAP 8 — formatSessionRow with newline in title breaks output format", () => {
  /**
   * WHY RED: The session title "hello\nworld" contains a literal newline.
   * formatSessionRow includes it verbatim, producing output like:
   *   [opencode:personal] [main] hello
   *   world (ses-1)
   * This breaks the one-line-per-session contract. The test expects exactly
   * 2 output lines (one per session) but gets 3.
   *
   * After fix: formatSessionRow should replace newlines with spaces (or ⏎):
   *   [opencode:personal] [main] hello world (ses-1)
   *
   * Fix: In formatSessionRow, sanitize the title:
   *   const sanitized = title.replace(/[\r\n]+/g, " ");
   */
  test("list_newline_in_title_does_not_break_one_line_per_session", async () => {
    const sessions = [
      makeSession("ses-1", "opencode", "personal", "hello\nworld"),
      makeSession("ses-2", "opencode", "personal", "normal title"),
    ];

    const listService: ListService = async () => ({
      sessions,
      errors: [],
    });

    const result = await runListCommand({
      config: baseConfig,
      list: listService,
    });

    expect(result.exitCode).toBe(0);

    // Two sessions should produce exactly 2 non-empty output lines
    const lines = result.stdout.trim().split("\n").filter((l) => l.length > 0);

    // RED: The newline in "hello\nworld" produces 3 lines instead of 2
    expect(lines.length).toBe(2);

    // Both session IDs should appear in the output
    expect(result.stdout).toContain("ses-1");
    expect(result.stdout).toContain("ses-2");
  });

  /**
   * WHY RED: Carriage return + newline (\r\n) in title also breaks format.
   * formatSessionRow doesn't sanitize any control characters.
   */
  test("list_carriage_return_in_title_does_not_break_output", async () => {
    const sessions = [
      makeSession("ses-cr", "opencode", "personal", "line1\r\nline2\r\nline3"),
    ];

    const listService: ListService = async () => ({
      sessions,
      errors: [],
    });

    const result = await runListCommand({
      config: baseConfig,
      list: listService,
    });

    expect(result.exitCode).toBe(0);

    const lines = result.stdout.trim().split("\n").filter((l) => l.length > 0);

    // RED: \r\n produces 3 lines instead of 1
    expect(lines.length).toBe(1);
  });
});
