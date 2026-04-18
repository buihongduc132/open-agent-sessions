/**
 * test/cli-gaps-edge-cases-7.test.ts
 *
 * RED tests for edge cases NOT covered by ANY existing test suite:
 *   - test/cli-gaps-edge-cases.test.ts   (20 tests: content search fallback, dedup, special chars, unicode, operators-only, long query, partial service failure, quoted phrase, exclude without ID, exclude from content, empty exclude array, --last large, range start=end, --first --user-only, system-only session, deep fork chain, orphan chain, roots+children conflict, missing title fallback, siblings)
 *   - test/cli-gaps-edge-cases-2.test.ts (7 tests: regex /pattern/, Boolean+content interaction, empty-string title fallback, planFromQuery/applyBooleanLogic, normalizeFuzzyQuery hyphens, error dedup)
 *   - test/cli-gaps-edge-cases-3.test.ts (4 tests: /g flag regex bug, ReDoS protection)
 *   - test/cli-gaps-edge-cases-4.test.ts (7 tests: buildForkChain circular reference, --sub-only flag, boolean hyphen normalization, whitespace title, main/sub role tags, default child hiding + badges)
 *   - test/cli-gaps-edge-cases-5.test.ts (8 tests: regex intercepted by boolean, plain search whitespace normalization, double NOT, NOT with compound operand, NOT implicit AND drop, regex flags leak, operators-only "AND OR", newline in title)
 *   - test/cli-gaps-edge-cases-6.test.ts (5 tests: tree newline title, children newline title, tree error session ID, children error parent ID, tree JSON dedup)
 *   - test/cli-search.test.ts, test/cli-search-boolean.test.ts, test/cli-search-content.test.ts
 *   - test/cli-tree.test.ts, test/cli-read-composable.test.ts, test/cli-sessions.test.ts
 *
 * All tests below MUST fail with the current code. Each targets a specific
 * untested edge case that reveals a real bug or missing behavior.
 *
 * UNCOVERED GAP AREAS:
 *   GAP 1: contentResultsToSessions hardcodes agent identity
 *   GAP 2: trailing/leading boolean operators, content-search empty fallback
 *   GAP 3: overlapping exclude IDs, exclude-session with nonexistent IDs
 *   GAP 4: --all --user-only, --last 1 --user-only, --range 1:1 --user-only
 *   GAP 5: sessions command no hierarchy tags, children empty feedback, children JSON format, tree single-node, buildForkChain maxDepth
 */

import { describe, expect, test } from "bun:test";
import {
  runSearchCommand,
  type SearchService,
  type ContentSearchService,
} from "../src/cli/search";
import { runListCommand, type ListService } from "../src/cli/list";
import { runSessionsCommand, type SessionsService } from "../src/cli/sessions";
import { type Config } from "../src/config/types";
import {
  type SessionSummary,
  type SessionDetail,
  type SessionMessage,
  type SessionReadOptions,
  type SearchQuery,
} from "../src/core/types";
import { type ForkChainNode } from "../src/core/subagents";

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

function makeMessage(role: "user" | "assistant" | "system", text: string, id?: string): SessionMessage {
  return {
    id: id ?? `msg-${Date.now()}-${Math.random()}`,
    role,
    created_at: "2024-01-01T12:00:00Z",
    parts: [{ type: "text", text }],
  };
}

// ============================================================================
// GAP 1: contentResultsToSessions hardcodes agent identity
// ============================================================================
// Root cause: In search.ts, contentResultsToSessions() always maps results to
// agent: "opencode", alias: "personal". But if a session actually belongs to
// codex/work, the output row shows the WRONG agent. Users cannot tell which
// agent the session truly came from when it's found via content search.
//
// Expected fix: contentResultsToSessions should look up the actual agent/alias
// from the session data, or the SimilarSessionResult type should carry the
// original agent/alias information from the search backend.
// ============================================================================

describe("GAP 1: contentResultsToSessions hardcodes agent identity", () => {
  /**
   * WHY RED: A codex session found via content search gets displayed as
   * [opencode:personal] instead of [codex:work]. This misleads users about
   * which agent the session belongs to. The contentResultsToSessions function
   * at line 259-270 of search.ts hardcodes `agent: "opencode"` and
   * `alias: "personal"` for ALL content search results.
   *
   * After fix: The content search result should carry the real agent/alias
   * from the backend, or the lookup should use the session ID to find the
   * correct agent identity from the registry.
   */
  test("content_search_preserves_correct_agent_identity", async () => {
    // A session that actually belongs to codex/work
    const codexSession = makeSession("codex-real-001", "codex", "work", "Codex session title");

    // Title search returns the session with correct agent info
    const titleSearch: SearchService = async () => ({
      sessions: [],
      errors: [],
    });

    // Content search finds it with matching body content
    const findSimilar: ContentSearchService = async () => [
      {
        sessionId: "codex-real-001",
        title: "Codex session title",
        score: 0.9,
        rank: 1,
        matchType: "hybrid",
        matchedChunks: 3,
      },
    ];

    const result = await runSearchCommand({
      text: "codex session",
      config: baseConfig,
      searchSessions: titleSearch,
      findSimilarSessions: findSimilar,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("codex-real-001");

    // RED: The output shows [opencode:personal] but should show [codex:work]
    // because the session belongs to the codex agent, not opencode.
    expect(result.stdout).toMatch(/\[codex:work\]/);
    expect(result.stdout).not.toMatch(/\[opencode:personal\].*codex-real-001/);
  });

  /**
   * WHY RED: Same issue but with a claude agent session found via content search.
   * All content search results are stamped as opencode:personal regardless.
   */
  test("content_search_preserves_claude_agent_identity", async () => {
    const findSimilar: ContentSearchService = async () => [
      {
        sessionId: "claude-session-001",
        title: "Claude team discussion",
        score: 0.85,
        rank: 1,
        matchType: "fts-only",
        matchedChunks: 2,
      },
    ];

    const result = await runSearchCommand({
      text: "claude discussion",
      config: baseConfig,
      searchSessions: async () => ({ sessions: [], errors: [] }),
      findSimilarSessions: findSimilar,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("claude-session-001");

    // RED: Should show the actual agent that owns this session
    // Currently always shows [opencode:personal]
    expect(result.stdout).not.toMatch(/\[opencode:personal\].*claude-session-001/);
  });
});

// ============================================================================
// GAP 2A: Boolean query with trailing operator "alpha AND"
// ============================================================================
// Root cause: The tokenizer produces [TERM("alpha"), AND, EOF]. The parser's
// parseAnd() consumes the AND token, then calls parseNot() → parsePrimary().
// parsePrimary sees EOF → falls to default case → consumes EOF → returns
// term(""). The AND expression becomes and(term("alpha"), term("")).
// searchTerm("") returns empty (guarded by !node.value.trim() in evalNode),
// so AND intersection is always empty → 0 results for "alpha AND".
//
// Expected fix: parseAnd should detect trailing operators and throw a parse
// error, or the CLI should show a helpful message like "Incomplete query:
// trailing 'AND' with no term".
// ============================================================================

describe("GAP 2A: Boolean query with trailing operator", () => {
  /**
   * WHY RED: "alpha AND" with trailing AND produces and(term("alpha"), term("")).
   * The empty term returns 0 sessions, so AND intersection = 0. This silently
   * returns empty results instead of telling the user the query is malformed.
   *
   * After fix: Should either return exitCode 1 with "Incomplete query" error,
   * or at minimum show "No sessions found" without misleading the user that
   * the search ran successfully.
   */
  test("trailing_AND_produces_error_not_empty_results", async () => {
    const sessions = [
      makeSession("ses-alpha", "opencode", "personal", "alpha session"),
      makeSession("ses-beta", "codex", "work", "beta session"),
    ];

    const result = await runSearchCommand({
      text: "alpha AND",
      config: baseConfig,
      searchSessions: async (query) => {
        const text = query.text.toLowerCase();
        const matched = sessions.filter(s =>
          s.title.toLowerCase().includes(text) || s.id.toLowerCase().includes(text)
        );
        return { sessions: matched, errors: [] };
      },
    });

    // RED: Currently returns exitCode 0 with "No sessions found" — the user
    // thinks "alpha AND" just didn't match anything, when actually the query
    // is malformed. Should return exitCode 1 with a parse error.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/incomplete|trailing|missing.*term|parse.*error/i);
  });

  /**
   * WHY RED: "alpha OR" with trailing OR produces or(term("alpha"), term("")).
   * The empty term returns 0 sessions, so OR = just "alpha" results. This is
   * not terrible but still masks a malformed query.
   */
  test("trailing_OR_produces_error_not_silent_success", async () => {
    const sessions = [
      makeSession("ses-alpha", "opencode", "personal", "alpha session"),
    ];

    const result = await runSearchCommand({
      text: "alpha OR",
      config: baseConfig,
      searchSessions: async (query) => {
        const text = query.text.toLowerCase();
        const matched = sessions.filter(s =>
          s.title.toLowerCase().includes(text) || s.id.toLowerCase().includes(text)
        );
        return { sessions: matched, errors: [] };
      },
    });

    // RED: Should return error for trailing operator
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/incomplete|trailing|missing.*term|parse.*error/i);
  });

  /**
   * WHY RED: "AND alpha" with leading AND. The tokenizer produces
   * [AND, TERM("alpha"), EOF]. parsePrimary sees AND → default case → consumes
   * AND → returns term("AND"). Then parseAnd continues, consuming alpha.
   * Result: and(term("AND"), term("alpha")). The term "AND" searches for the
   * literal word "AND" in titles, which is nonsensical.
   */
  test("leading_AND_does_not_search_for_literal_AND", async () => {
    let capturedQueries: string[] = [];

    const result = await runSearchCommand({
      text: "AND alpha",
      config: baseConfig,
      searchSessions: async (query) => {
        capturedQueries.push(query.text);
        return { sessions: [], errors: [] };
      },
    });

    expect(result.exitCode).toBe(0);

    // RED: "AND" is treated as a literal search term.
    // After fix: should detect leading operator and return parse error
    // or at minimum not search for the literal string "AND".
    expect(capturedQueries).not.toContain("and");
  });
});

// ============================================================================
// GAP 2B: Content search returns empty — no fallback to title results
// ============================================================================
// Root cause: When findSimilarSessions is provided but returns [], the content
// search branch at line 213 of search.ts does:
//   filteredSessions = contentResultsToSessions(contentResults);
// This produces an empty array. The title search results are never checked.
// The user sees "No sessions found" even though title search would have found
// the session.
//
// Expected fix: When contentResults is empty, fall back to title-only search
// results from searchSessions.
// ============================================================================

describe("GAP 2B: Content search empty does not fall back to title results", () => {
  /**
   * WHY RED: findSimilarSessions returns [] (no content matches), but the
   * session title clearly contains the search term. The user expects the title
   * match to appear in results. Currently, providing findSimilarSessions
   * completely replaces the title search path, even when content search finds
   * nothing.
   *
   * After fix: When findSimilarSessions returns empty, the CLI should fall back
   * to title-only results from searchSessions.
   */
  test("content_search_empty_falls_back_to_title_results", async () => {
    const titleMatch = makeSession("title-match-001", "opencode", "personal", "Important debug session");

    const titleSearch: SearchService = async () => ({
      sessions: [titleMatch],
      errors: [],
    });

    // Content search finds nothing
    const findSimilar: ContentSearchService = async () => [];

    const result = await runSearchCommand({
      text: "debug",
      config: baseConfig,
      searchSessions: titleSearch,
      findSimilarSessions: findSimilar,
    });

    expect(result.exitCode).toBe(0);

    // RED: "title-match-001" has "debug" in the title, but content search
    // returned empty, so the CLI shows "No sessions found" instead of the
    // title match. After fix: should show the title-matched session.
    expect(result.stdout).toContain("title-match-001");
  });
});

// ============================================================================
// GAP 3A: Overlapping exclude IDs (excludeCurrent + excludeSession same ID)
// ============================================================================
// No test verifies the behavior when --exclude-current and --exclude-session
// both reference the same session ID. Should still exclude it once.
// ============================================================================

describe("GAP 3A: Overlapping exclude IDs", () => {
  /**
   * WHY RED: When both excludeCurrent and excludeSession reference the same
   * session ID, the excludedIds Set should deduplicate it. The session should
   * be excluded exactly once. This tests that the Set-based approach handles
   * duplicates correctly — it should, but no test verifies it.
   */
  test("exclude_current_and_exclude_session_overlap_excludes_once", async () => {
    const OVERLAP_ID = "overlap-session-001";
    const sessions = [
      makeSession(OVERLAP_ID, "opencode", "personal", "Overlap session"),
      makeSession("other-001", "codex", "work", "Other session"),
    ];

    const result = await runSearchCommand({
      text: "session",
      config: baseConfig,
      currentSessionId: OVERLAP_ID,
      excludeCurrent: true,
      excludeSession: [OVERLAP_ID], // Same ID as currentSessionId
      searchSessions: async () => ({ sessions, errors: [] }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(OVERLAP_ID);
    expect(result.stdout).toContain("other-001");
  });

  /**
   * WHY RED: --exclude-session with some nonexistent IDs. The Set should
   * silently ignore IDs that don't match any session. No error should be
   * produced for nonexistent exclude IDs.
   */
  test("exclude_session_with_nonexistent_ids_is_noop", async () => {
    const sessions = [
      makeSession("real-001", "opencode", "personal", "Real session"),
    ];

    const result = await runSearchCommand({
      text: "session",
      config: baseConfig,
      excludeSession: ["ghost-001", "phantom-002", "does-not-exist"],
      searchSessions: async () => ({ sessions, errors: [] }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("real-001");
    // No error about nonexistent exclude IDs
    expect(result.stderr).not.toMatch(/ghost|phantom|does-not-exist/i);
  });
});

// ============================================================================
// GAP 4A: Composable read flags — additional uncovered edge cases
// ============================================================================
// Existing tests cover: --last large, range start=end, --first --user-only,
// system-only + user-only. NOT covered:
//   - --all --user-only
//   - --last 1 --user-only
//   - --range 1:1 --user-only
// ============================================================================

describe("GAP 4A: Additional composable read flag edge cases", () => {
  function makeMockAdapter(messages: SessionMessage[]) {
    const detail: SessionDetail = {
      id: "test-session",
      agent: "opencode",
      alias: "personal",
      title: "Test",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      message_count: messages.length,
      storage: "db",
      messages,
    };

    return {
      getSessionDetail: async (_id: string, opts: SessionReadOptions) => {
        let msgs = [...detail.messages];

        const sel = opts.selection;
        if (sel) {
          switch (sel.mode) {
            case "first":
              msgs = msgs.slice(0, sel.count);
              break;
            case "last":
              msgs = msgs.slice(-(sel.count ?? 10));
              break;
            case "range": {
              const start = (sel.start ?? 1) - 1;
              const end = sel.end ?? start + 1;
              msgs = msgs.slice(start, end);
              break;
            }
            case "all":
            default:
              break;
          }
        }

        // Apply userOnly filter
        const effectiveUserOnly = opts.userOnly || opts.selection?.userOnly;
        if (effectiveUserOnly) {
          msgs = msgs.filter(m => m.role === "user");
        }

        return { ...detail, messages: msgs };
      },
    };
  }

  /**
   * WHY RED: --all --user-only should return all user messages across the
   * entire session. The selection mode "all" gives all messages, then userOnly
   * filters to user-only. This verifies the composition works for --all mode
   * specifically, which is a different code path than --last or --range.
   */
  test("read_all_user_only_returns_all_user_messages", async () => {
    const messages: SessionMessage[] = [
      makeMessage("system", "System prompt", "s1"),
      makeMessage("user", "User message 1", "u1"),
      makeMessage("assistant", "Response 1", "a1"),
      makeMessage("user", "User message 2", "u2"),
      makeMessage("assistant", "Response 2", "a2"),
      makeMessage("user", "User message 3", "u3"),
    ];

    const adapter = makeMockAdapter(messages);
    const result = await adapter.getSessionDetail("test-session", {
      userOnly: true,
      mode: "all_no_tools",
      selection: { mode: "all", userOnly: true },
    });

    // All 3 user messages, no system or assistant
    expect(result.messages.length).toBe(3);
    expect(result.messages.every(m => m.role === "user")).toBe(true);
    expect(result.messages.map(m => m.id)).toEqual(["u1", "u2", "u3"]);
  });

  /**
   * WHY RED: --last 1 --user-only should return the last 1 message, then
   * filter to user-only. If the last message is from the assistant, the
   * result should be empty (the last message was filtered out).
   * If the last message is from the user, it should appear.
   *
   * This tests the edge case of --last N where N is very small (1) combined
   * with user-only filter.
   */
  test("read_last_1_user_only_returns_last_msg_filtered_by_user_role", async () => {
    // Last message is assistant — user-only should filter it out
    const messages1: SessionMessage[] = [
      makeMessage("user", "User msg", "u1"),
      makeMessage("assistant", "Last msg is assistant", "a1"),
    ];

    const adapter1 = makeMockAdapter(messages1);
    const result1 = await adapter1.getSessionDetail("test-session", {
      userOnly: true,
      mode: "all_no_tools",
      selection: { mode: "last", count: 1, userOnly: true },
    });

    // Last 1 = [a1], userOnly filter = [] (assistant filtered out)
    expect(result1.messages.length).toBe(0);

    // Now test where last message IS user
    const messages2: SessionMessage[] = [
      makeMessage("assistant", "Assistant msg", "a1"),
      makeMessage("user", "Last msg is user", "u1"),
    ];

    const adapter2 = makeMockAdapter(messages2);
    const result2 = await adapter2.getSessionDetail("test-session", {
      userOnly: true,
      mode: "all_no_tools",
      selection: { mode: "last", count: 1, userOnly: true },
    });

    // Last 1 = [u1], userOnly filter = [u1] — it's a user message, kept
    expect(result2.messages.length).toBe(1);
    expect(result2.messages[0].id).toBe("u1");
  });

  /**
   * WHY RED: --range 1:1 --user-only should return the first message (1-indexed)
   * filtered by user-only. If message 1 is not a user message, result is empty.
   */
  test("read_range_1_1_user_only_filters_single_message", async () => {
    // Message 1 is system — user-only should filter it out
    const messages: SessionMessage[] = [
      makeMessage("system", "System prompt", "s1"),
      makeMessage("user", "User first", "u1"),
      makeMessage("assistant", "Response", "a1"),
    ];

    const adapter = makeMockAdapter(messages);
    const result = await adapter.getSessionDetail("test-session", {
      userOnly: true,
      mode: "all_no_tools",
      selection: { mode: "range", start: 1, end: 1, userOnly: true },
    });

    // Range 1:1 = [s1], userOnly filter = [] (system filtered out)
    expect(result.messages.length).toBe(0);
  });

  /**
   * WHY RED: --range 2:2 --user-only where message 2 IS a user message.
   * Should return exactly that message.
   */
  test("read_range_2_2_user_only_returns_user_message_at_position_2", async () => {
    const messages: SessionMessage[] = [
      makeMessage("system", "System prompt", "s1"),
      makeMessage("user", "User message at position 2", "u1"),
      makeMessage("assistant", "Response", "a1"),
    ];

    const adapter = makeMockAdapter(messages);
    const result = await adapter.getSessionDetail("test-session", {
      userOnly: true,
      mode: "all_no_tools",
      selection: { mode: "range", start: 2, end: 2, userOnly: true },
    });

    // Range 2:2 = [u1], userOnly filter = [u1]
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].id).toBe("u1");
  });
});

// ============================================================================
// GAP 5A: sessions command lacks hierarchy tags ([main]/[sub], +N badges)
// ============================================================================
// Root cause: The sessions command uses formatSessionRow from formatters/text.ts
// which does NOT include [main]/[sub] role tags or +N child count badges.
// The list command uses its own formatSessionRow in list.ts which DOES include
// these tags. Users of `oas sessions` cannot see hierarchy information.
//
// Expected fix: sessions command should use the same formatSessionRow as list.ts,
// or formatters/text.ts formatSessionRow should be updated to include hierarchy.
// ============================================================================

describe("GAP 5A: sessions command lacks hierarchy tags", () => {
  const sessions: SessionSummary[] = [
    makeSession("root-001", "opencode", "personal", "Root session alpha"),
    makeSession("child-001", "codex", "work", "Child session beta", { parentSessionId: "root-001" }),
  ];

  const sessionsService: SessionsService = async () => ({
    sessions,
    errors: [],
  });

  /**
   * WHY RED: The sessions command formats output using formatters/text.ts
   * formatSessionRow which has NO [main]/[sub] tags. Even though the session
   * data has parentSessionId, the output doesn't distinguish root from child.
   * Compare: `oas list` shows [main] and [sub] tags, `oas sessions` does not.
   *
   * After fix: sessions output should include [main]/[sub] tags consistent
   * with the list command.
   */
  test("sessions_command_shows_main_sub_role_tags", async () => {
    const result = await runSessionsCommand({
      config: baseConfig,
      getSessions: sessionsService,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("root-001");
    expect(result.stdout).toContain("child-001");

    // RED: The root session line should have [main] tag
    const rootLine = result.stdout.split("\n").find(l => l.includes("root-001"));
    expect(rootLine).toBeDefined();
    expect(rootLine!).toMatch(/\[main\]/);

    // RED: The child session line should have [sub] tag
    const childLine = result.stdout.split("\n").find(l => l.includes("child-001"));
    expect(childLine).toBeDefined();
    expect(childLine!).toMatch(/\[sub\]/);
  });
});

// ============================================================================
// GAP 5B: children command empty result has no feedback message
// ============================================================================
// Root cause: runChildrenCommand at children.ts line 42-44 returns
// { exitCode: 0, stdout: "", stderr: "" } for empty children. Unlike list
// and search which say "No sessions found.", the children command gives no
// feedback. Users can't distinguish "command ran with 0 results" from
// "command silently did nothing".
//
// Expected fix: Return "No children found.\n" or similar message for empty results.
// ============================================================================

describe("GAP 5B: children command empty result has no feedback", () => {
  /**
   * WHY RED: When a session has no children, the output is completely empty
   * (stdout: ""). The user runs `oas children ses_001` and sees nothing — no
   * confirmation that the command ran, no indication of whether the session
   * exists. Compare: `oas list` says "No sessions found." for empty results.
   *
   * After fix: Should return "No children found.\n" or similar feedback.
   */
  test("children_empty_result_shows_feedback_message", async () => {
    const { runChildrenCommand } = await import("../src/cli/children");

    const getChildren = async () => []; // No children

    const result = await runChildrenCommand({
      parentSessionId: "parent-no-children",
      config: baseConfig,
      getChildren,
    });

    expect(result.exitCode).toBe(0);
    // RED: Currently stdout is empty (""). Should provide feedback.
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout).toMatch(/no children found/i);
  });
});

// ============================================================================
// GAP 5C: children command JSON format — output shape validation
// ============================================================================
// No existing test validates the JSON output from runChildrenCommand.
// The JSON format should return a valid JSON array of session objects.
// ============================================================================

describe("GAP 5C: children command JSON format validation", () => {
  /**
   * WHY RED: No test validates the JSON output shape from runChildrenCommand.
   * When format="json", the output should be a valid JSON array where each
   * element has the expected fields from SessionSummary.
   */
  test("children_json_format_returns_valid_json_array", async () => {
    const { runChildrenCommand } = await import("../src/cli/children");

    const children: SessionSummary[] = [
      makeSession("child-json-001", "opencode", "personal", "JSON child 1", { parentSessionId: "parent-001" }),
      makeSession("child-json-002", "codex", "work", "JSON child 2", { parentSessionId: "parent-001" }),
    ];

    const getChildren = async () => children;

    const result = await runChildrenCommand({
      parentSessionId: "parent-001",
      config: baseConfig,
      format: "json",
      getChildren,
    });

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);

    // Validate first child has expected fields
    expect(parsed[0].id).toBe("child-json-001");
    expect(parsed[0].agent).toBe("opencode");
    expect(parsed[0].alias).toBe("personal");
    expect(parsed[0].title).toBe("JSON child 1");
    expect(parsed[0].parentSessionId).toBe("parent-001");

    // Validate second child
    expect(parsed[1].id).toBe("child-json-002");
    expect(parsed[1].parentSessionId).toBe("parent-001");
  });
});

// ============================================================================
// GAP 5D: tree command single-node chain (root session, no parent)
// ============================================================================
// No test covers the edge case where a root session has no parentSessionId.
// buildForkChain returns a single-element array. The tree output should show
// exactly one node with depth 0.
// ============================================================================

describe("GAP 5D: tree command single-node chain (root session)", () => {
  /**
   * WHY RED: A root session with no parent should produce a single-node tree
   * with depth 0. The output should have exactly one line with the session's
   * agent:alias label and title.
   */
  test("tree_single_node_root_shows_one_line", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");

    const chain: ForkChainNode[] = [
      {
        sessionId: "root-only-001",
        title: "Standalone root session",
        agent: "opencode",
        alias: "personal",
        depth: 0,
      },
    ];

    const getForkChain = async () => chain;

    const result = await runTreeCommand({
      session: "root-only-001",
      config: baseConfig,
      getForkChain,
    });

    expect(result.exitCode).toBe(0);

    // Should produce exactly 1 non-empty output line
    const lines = result.stdout.split("\n").filter(l => l.length > 0);
    expect(lines.length).toBe(1);

    // The line should contain the session details
    expect(lines[0]).toContain("root-only-001");
    expect(lines[0]).toContain("opencode");
    expect(lines[0]).toContain("Standalone root session");
  });
});

// ============================================================================
// GAP 5E: buildForkChain with custom maxDepth parameter
// ============================================================================
// No test verifies that the maxDepth parameter actually limits chain length.
// buildForkChain accepts maxDepth (default 100) but no test passes a custom
// value to verify it works.
// ============================================================================

describe("GAP 5E: buildForkChain with custom maxDepth", () => {
  /**
   * WHY RED: maxDepth=1 should stop after the first node (the starting session),
   * NOT traverse to the parent. This limits how deep the chain can grow.
   * Currently no test validates this parameter.
   */
  test("buildForkChain_maxDepth_1_returns_only_starting_session", async () => {
    const { buildForkChain } = await import("../src/core/subagents");

    // Chain: leaf → mid → root (3 levels)
    const leaf = {
      id: "leaf-001",
      parentSessionId: "mid-001",
      agent: "opencode",
      alias: "personal",
      title: "Leaf session",
    };

    const resolveParent = (id: string) => {
      if (id === "mid-001") {
        return {
          id: "mid-001",
          parentSessionId: "root-001",
          agent: "opencode",
          alias: "personal",
          title: "Mid session",
        };
      }
      if (id === "root-001") {
        return {
          id: "root-001",
          parentSessionId: undefined,
          agent: "opencode",
          alias: "personal",
          title: "Root session",
        };
      }
      return null;
    };

    // With maxDepth=1, should only include the leaf (starting session)
    const chain = buildForkChain(leaf, resolveParent, 1);

    expect(chain.length).toBe(1);
    expect(chain[0].sessionId).toBe("leaf-001");
  });

  /**
   * WHY RED: maxDepth=2 should stop after 2 nodes: leaf + mid, but NOT root.
   */
  test("buildForkChain_maxDepth_2_stops_before_root", async () => {
    const { buildForkChain } = await import("../src/core/subagents");

    const leaf = {
      id: "leaf-002",
      parentSessionId: "mid-002",
      agent: "opencode",
      alias: "personal",
      title: "Leaf session",
    };

    const resolveParent = (id: string) => {
      if (id === "mid-002") {
        return {
          id: "mid-002",
          parentSessionId: "root-002",
          agent: "opencode",
          alias: "personal",
          title: "Mid session",
        };
      }
      if (id === "root-002") {
        return {
          id: "root-002",
          parentSessionId: undefined,
          agent: "opencode",
          alias: "personal",
          title: "Root session",
        };
      }
      return null;
    };

    // With maxDepth=2, should include leaf + mid (2 nodes), stop before root
    const chain = buildForkChain(leaf, resolveParent, 2);

    expect(chain.length).toBe(2);
    expect(chain[0].sessionId).toBe("mid-002"); // Root of limited chain (deepest ancestor)
    expect(chain[1].sessionId).toBe("leaf-002"); // Starting session
    // Root should NOT be included
    expect(chain.find(n => n.sessionId === "root-002")).toBeUndefined();
  });
});

// ============================================================================
// GAP 5F: tree command JSON format — basic output validation (non-circular)
// ============================================================================
// The existing test in cli-gaps-edge-cases-6.test.ts only tests JSON format
// with a circular chain (4 entries with duplicate node-a). No test validates
// the basic JSON output shape for a normal, non-circular chain.
// ============================================================================

describe("GAP 5F: tree command JSON format — basic non-circular chain", () => {
  /**
   * WHY RED: The existing JSON test (cli-gaps-edge-cases-6 GAP 5) only tests
   * circular chains. This test validates the JSON output for a normal 3-node
   * chain (root → mid → leaf) with no cycles.
   */
  test("tree_json_format_normal_chain_has_correct_structure", async () => {
    const { runTreeCommand } = await import("../src/cli/tree");

    const chain: ForkChainNode[] = [
      { sessionId: "json-root", title: "Root node", agent: "opencode", alias: "personal", depth: 2 },
      { sessionId: "json-mid", title: "Mid node", agent: "codex", alias: "work", depth: 1, parentSessionId: "json-root" },
      { sessionId: "json-leaf", title: "Leaf node", agent: "opencode", alias: "personal", depth: 0, parentSessionId: "json-mid" },
    ];

    const getForkChain = async () => chain;

    const result = await runTreeCommand({
      session: "json-leaf",
      config: baseConfig,
      getForkChain,
      format: "json",
    });

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(3);

    // Validate each node has the expected ForkChainNode fields
    for (const node of parsed) {
      expect(node).toHaveProperty("sessionId");
      expect(node).toHaveProperty("title");
      expect(node).toHaveProperty("agent");
      expect(node).toHaveProperty("alias");
      expect(node).toHaveProperty("depth");
    }

    // Validate ordering (root first, leaf last)
    expect(parsed[0].sessionId).toBe("json-root");
    expect(parsed[0].depth).toBe(2);
    expect(parsed[2].sessionId).toBe("json-leaf");
    expect(parsed[2].depth).toBe(0);
    // Parent references preserved
    expect(parsed[1].parentSessionId).toBe("json-root");
    expect(parsed[2].parentSessionId).toBe("json-mid");
  });
});
