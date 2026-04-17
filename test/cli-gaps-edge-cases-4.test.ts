/**
 * test/cli-gaps-edge-cases-4.test.ts
 *
 * RED tests for 5 SPECIFIC UNCOVERED gaps in the oas CLI.
 *
 * All tests should FAIL until the corresponding implementation fixes are applied.
 * DO NOT modify source files or existing test files.
 */

import { describe, expect, test } from "bun:test";
import { runListCommand, type ListService } from "../src/cli/list";
import { runSearchCommand, type SearchService } from "../src/cli/search";
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
// GAP 1 — buildForkChain circular reference → INFINITE LOOP (CRITICAL BUG)
// ============================================================================
// Root cause: buildForkChain() has a `while (current)` loop that follows
// `parentSessionId` via resolveParent. There is NO visited-set check.
// If session A's parent is B and B's parent is A, the loop NEVER terminates.
//
// Expected fix: Add a visited Set<string> that tracks session IDs already seen.
// If resolveParent returns a session whose ID is already in the visited set,
// break the loop (or throw an error).
//
// Testing strategy: Since buildForkChain is synchronous and the infinite loop
// would cause OOM before any test timeout can fire, we test via a subprocess
// with `timeout` command. If the subprocess is killed (exit code 124), the
// function hung = infinite loop = RED test. After fix: the subprocess
// completes normally and writes a result file.
// ============================================================================

import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync } from "fs";

const RESULT_FILE = "/tmp/oas-fork-chain-result.txt";

function runForkChainInSubprocess(
  sessionSetupCode: string,
  startSessionVar: string,
): { completed: boolean; chainLength: number | null; error: string | null } {
    const script = `
import { buildForkChain } from "./src/core/subagents";

${sessionSetupCode}

try {
  const chain = buildForkChain(${startSessionVar}, resolveParent);
  await Bun.write("${RESULT_FILE}", "ok:" + chain.length);
  process.exit(0);
} catch (e) {
  await Bun.write("${RESULT_FILE}", "error:" + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}
`;

    const tmpScript = "/tmp/oas-test-fork-chain.ts";
    writeFileSync(tmpScript, script);

    try { unlinkSync(RESULT_FILE); } catch {}

    let timedOut = false;
    try {
      // `timeout 5` kills the process after 5 seconds if it hangs
      execSync(`timeout 5 bun run ${tmpScript} 2>&1`, {
        encoding: "utf-8",
        timeout: 8000,
      });
    } catch (e: any) {
      // exit code 124 from `timeout` = process was killed
      // exit code null = process was killed by signal
      timedOut = true;
    }

    let result: string | null = null;
    try { result = readFileSync(RESULT_FILE, "utf-8"); } catch {}

    if (result && result.startsWith("ok:")) {
      return { completed: true, chainLength: parseInt(result.slice(3), 10), error: null };
    } else if (result && result.startsWith("error:")) {
      return { completed: true, chainLength: null, error: result.slice(6) };
    } else {
      // No result file = process was killed before it could write = infinite loop
      return { completed: false, chainLength: null, error: null };
    }
  }

describe("GAP 1 — buildForkChain circular reference (CRITICAL: infinite loop)", () => {
  /**
   * WHY RED: buildForkChain enters an infinite loop when session A → B → A.
   * The subprocess is killed by `timeout 5` (exit 124), so the result file
   * is never written → completed = false. After fix: the function terminates
   * with cycle detection, subprocess exits normally, result file is written
   * with a bounded chain length.
   *
   * Fix: Add a visited Set<string> check inside the while loop of
   * buildForkChain() in src/core/subagents.ts.
   */
  test(
    "buildForkChain_circular_reference_A_to_B_to_A_terminates",
    async () => {
      const sessionSetup = `
const sessionA = {
  id: "session-A",
  parentSessionId: "session-B",
  agent: "opencode",
  alias: "personal",
  title: "Session A",
};
const sessionB = {
  id: "session-B",
  parentSessionId: "session-A",
  agent: "opencode",
  alias: "personal",
  title: "Session B",
};

const resolveParent = (id) => {
  if (id === "session-A") return sessionA;
  if (id === "session-B") return sessionB;
  return null;
};
`;

      const result = runForkChainInSubprocess(sessionSetup, "sessionA");

      // RED: The function hangs → completed is false because the subprocess
      // was killed by timeout before it could write the result file.
      // After fix: completed is true, chainLength is bounded.
      expect(result.completed).toBe(true);
      if (result.chainLength !== null) {
        expect(result.chainLength).toBeLessThanOrEqual(100);
      }
    },
    { timeout: 15000 }
  );

  /**
   * WHY RED: Self-referential session (parentSessionId === id) causes the
   * same infinite loop. The `while (current)` loop calls resolveParent which
   * returns the same session, forever.
   *
   * Fix: Same visited Set<string> guard.
   */
  test(
    "buildForkChain_self_referential_session_terminates",
    async () => {
      const sessionSetup = `
const selfRef = {
  id: "self-loop",
  parentSessionId: "self-loop",
  agent: "opencode",
  alias: "personal",
  title: "Self-referencing session",
};

const resolveParent = (id) => {
  if (id === "self-loop") return selfRef;
  return null;
};
`;

      const result = runForkChainInSubprocess(sessionSetup, "selfRef");

      // RED: Hangs because selfRef's parent is itself → infinite loop
      expect(result.completed).toBe(true);
      if (result.chainLength !== null) {
        expect(result.chainLength).toBeLessThanOrEqual(100);
      }
    },
    { timeout: 15000 }
  );

  /**
   * WHY RED: Three-way cycle A → C → B → A. More complex cycle that also
   * causes infinite loop because there's no cycle detection.
   *
   * Fix: Same visited Set<string> guard handles any cycle length.
   */
  test(
    "buildForkChain_three_way_cycle_A_B_C_A_terminates",
    async () => {
      const sessionSetup = `
const sessionA = {
  id: "cycle-A",
  parentSessionId: "cycle-C",
  agent: "opencode",
  alias: "personal",
  title: "Cycle A",
};
const sessionB = {
  id: "cycle-B",
  parentSessionId: "cycle-A",
  agent: "opencode",
  alias: "personal",
  title: "Cycle B",
};
const sessionC = {
  id: "cycle-C",
  parentSessionId: "cycle-B",
  agent: "opencode",
  alias: "personal",
  title: "Cycle C",
};

const resolveParent = (id) => {
  if (id === "cycle-A") return sessionA;
  if (id === "cycle-B") return sessionB;
  if (id === "cycle-C") return sessionC;
  return null;
};
`;

      const result = runForkChainInSubprocess(sessionSetup, "sessionA");

      // RED: Three-way cycle → infinite loop → subprocess killed
      expect(result.completed).toBe(true);
      if (result.chainLength !== null) {
        expect(result.chainLength).toBeLessThanOrEqual(100);
      }
    },
    { timeout: 15000 }
  );
});

// ============================================================================
// GAP 2 — --sub-only flag missing (filter to sessions WITH a parent)
// ============================================================================
// Root cause: `runListCommand` has `rootsOnly` but no `subOnly` option.
// Users cannot filter to see ONLY sub-agent sessions (sessions that HAVE
// a parentSessionId). The type doesn't include `subOnly` at all.
//
// Expected fix:
//   1. Add `subOnly?: boolean` to the options type in runListCommand.
//   2. Add validation that subOnly + rootsOnly is contradictory.
//   3. Add filter: `if (options.subOnly) sessions = sessions.filter(s => s.parentSessionId)`
// ============================================================================

describe("GAP 2 — --sub-only flag missing", () => {
  const allSessions = [
    makeSession("root-1", "opencode", "personal", "Root session"),
    makeSession("sub-1", "codex", "work", "Child session", { parentSessionId: "root-1" }),
    makeSession("root-2", "opencode", "personal", "Another root"),
    makeSession("sub-2", "codex", "work", "Another child", { parentSessionId: "root-2" }),
  ];

  const listService: ListService = async () => ({
    sessions: allSessions,
    errors: [],
  });

  /**
   * WHY RED: `subOnly` does not exist on the options type. This test uses
   * type assertion to pass it anyway, but runListCommand ignores it because
   * the filter code doesn't exist. After fix: only sessions with
   * parentSessionId should appear in the output.
   *
   * Fix: Add `subOnly?: boolean` to options type, add filter logic.
   */
  test("list_sub_only_filters_to_sessions_with_parent", async () => {
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      // @ts-expect-error — subOnly doesn't exist on the type yet (GAP 2)
      subOnly: true,
    });

    expect(result.exitCode).toBe(0);
    // Only sessions WITH parentSessionId should appear
    expect(result.stdout).toContain("sub-1");
    expect(result.stdout).toContain("sub-2");
    // Root sessions (no parentSessionId) should NOT appear
    expect(result.stdout).not.toContain("root-1");
    expect(result.stdout).not.toContain("root-2");
  });

  /**
   * WHY RED: Both `rootsOnly` and `subOnly` together is contradictory —
   * rootsOnly shows sessions WITHOUT a parent, subOnly shows sessions WITH
   * a parent. The combination is always empty. Currently there's no validation
   * for this conflict because subOnly doesn't exist.
   *
   * Fix: Add conflict detection similar to the rootsOnly + childrenOf check.
   */
  test("list_sub_only_and_roots_only_conflict_returns_error", async () => {
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      rootsOnly: true,
      // @ts-expect-error — subOnly doesn't exist on the type yet (GAP 2)
      subOnly: true,
    });

    // Should return an error because the combination is contradictory
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/cannot use|conflict|mutually exclusive/i);
  });
});

// ============================================================================
// GAP 3 — Boolean search terms NOT normalized for hyphen matching
// ============================================================================
// Root cause: When isBooleanQuery("sqlite-vec AND pattern") is true, the
// boolean search path calls searchTerm for each term. Inside searchTerm,
// for non-regex terms, the query is passed directly to searchSessions
// WITHOUT calling normalizeFuzzyQuery. This means "sqlite-vec" is sent
// literally, but the underlying FTS5 index may only have "sqlitevec".
//
// Note: The code at line 119 of search.ts does:
//   const query: SearchQuery = { cwd: process.cwd(), text: searchText };
// There is NO `normalizeFuzzyQuery(searchText)` call here, unlike the
// non-boolean path at line 175 which DOES normalize.
//
// Expected fix: Apply normalizeFuzzyQuery to the search text before passing
// it to searchSessions in the boolean searchTerm callback.
// ============================================================================

describe("GAP 3 — Boolean search terms not normalized for hyphen matching", () => {
  /**
   * WHY RED: The boolean path sends "sqlite-vec" literally to searchSessions.
   * The mock below simulates an FTS5 backend that normalizes by stripping
   * hyphens before matching. The query.text received by the mock will have
   * the hyphen still present ("sqlite-vec"), so matching fails → no results.
   * After fix: normalizeFuzzyQuery strips the hyphen → "sqlitevec" → match.
   *
   * Fix: In the searchTerm callback inside runSearchCommand (line ~119 of
   * search.ts), apply `normalizeFuzzyQuery(searchText)` to the text before
   * creating the SearchQuery.
   */
  test("boolean_AND_query_normalizes_hyphenated_terms", async () => {
    const sessions = [
      makeSession("ses-sqlitevec", "opencode", "personal", "sqlitevec integration patterns"),
      makeSession("ses-pattern", "opencode", "personal", "design pattern library"),
    ];

    let capturedQueryTexts: string[] = [];

    // Mock does NO normalization — it uses the query.text exactly as received.
    // This exposes whether the caller (runSearchCommand) normalizes hyphenated terms.
    const searchService: SearchService = async (query: SearchQuery) => {
      capturedQueryTexts.push(query.text);

      // Exact substring match on title — no normalization, no hyphen stripping
      // This means "sqlite-vec" won't match "sqlitevec" but "sqlitevec" will
      const results = sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(query.text.toLowerCase()) ||
          s.id.toLowerCase().includes(query.text.toLowerCase())
      );
      return { sessions: results, errors: [] };
    };

    const result = await runSearchCommand({
      text: "sqlite-vec AND pattern",
      config: baseConfig,
      searchSessions: searchService,
    });

    expect(result.exitCode).toBe(0);

    // GAP 3 proof: The production code passes "sqlite-vec" literally to the
    // search service (does NOT normalize to "sqlitevec"). The search service
    // then tries to find "sqlite-vec" as a substring of titles, but the title
    // has "sqlitevec" (no hyphen) → no match.
    //
    // RED because: result.stdout won't contain "ses-sqlitevec" since the
    // hyphenated term didn't match the non-hyphenated title.
    // After fix: normalizeFuzzyQuery is applied in the boolean path, so
    // the search service receives "sqlitevec" which DOES match.
    expect(result.stdout).toContain("ses-sqlitevec");

    // Additionally verify: the captured query text should have been normalized
    // (no hyphens) — but currently it won't be
    const sqliteVecQuery = capturedQueryTexts.find(
      (t) => t.includes("sqlite") || t.includes("vec")
    );
    expect(sqliteVecQuery).toBeDefined();
    // After fix: should be "sqlitevec" (hyphens stripped by normalizeFuzzyQuery)
    expect(sqliteVecQuery!).not.toContain("-");
  });
});

// ============================================================================
// GAP 4 — buildForkChain whitespace-only title shows spaces instead of ID
// ============================================================================
// Root cause: Line 331 of subagents.ts:
//   title: current.title || current.id
// The `||` operator treats whitespace-only strings like "   " as TRUTHY
// (non-empty string), so the chain node's title becomes "   " instead of
// falling back to the session ID.
//
// Expected fix: Use a proper check like:
//   title: (current.title?.trim() || current.id)
// or
//   title: (current.title && current.title.trim() ? current.title : current.id)
// ============================================================================

describe("GAP 4 — buildForkChain whitespace-only title shows spaces", () => {
  /**
   * WHY RED: buildForkChain uses `current.title || current.id`. The string
   * "   " (three spaces) is truthy for `||`, so the title becomes "   "
   * instead of falling back to the session ID. After fix: whitespace-only
   * titles should be treated as empty and fall back to the session ID.
   *
   * Fix: Change `current.title || current.id` to
   *   `(current.title?.trim() || current.id)` at line 331.
   */
  test("buildForkChain_whitespace_only_title_falls_back_to_id", async () => {
    const { buildForkChain: buildChain } = await import("../src/core/subagents");

    const whitespaceSession = {
      id: "whitespace-title-session",
      parentSessionId: undefined,
      agent: "opencode",
      alias: "personal",
      title: "   ", // three spaces — truthy for || but visually empty
    };

    const resolveParent = (_id: string) => null;

    const chain = buildChain(whitespaceSession, resolveParent);

    expect(chain.length).toBe(1);
    // Title should fall back to session ID, NOT be "   "
    expect(chain[0].title).toBe("whitespace-title-session");
  });
});

// ============================================================================
// GAP 5 — List output should show agent role tag (main vs sub)
// ============================================================================
// Root cause: formatSessionRow() in list.ts outputs:
//   `[agent:alias] title (id)`
// But there's no visual indicator of whether a session is a root/main session
// or a sub-agent session (has parentSessionId). Users cannot distinguish
// delegation relationships at a glance.
//
// Expected fix: formatSessionRow should include a role tag like [sub] or
// [main] based on whether parentSessionId is present:
//   Root session: `[opencode:personal] [main] Title (id)`
//   Sub session:  `[codex:work] [sub] Title (id)`
// ============================================================================

describe("GAP 5 — List output shows agent role tag (main vs sub)", () => {
  /**
   * WHY RED: formatSessionRow() doesn't check parentSessionId at all.
   * The output row for a session with parentSessionId looks identical to
   * a root session — no [sub] tag. After fix: sessions with parentSessionId
   * should display a [sub] indicator.
   *
   * Fix: In formatSessionRow(), check `session.parentSessionId` and append
   * `[sub]` to the label or add it as a separate column/tag.
   */
  test("list_output_shows_sub_tag_for_sessions_with_parent", async () => {
    const sessions = [
      makeSession("root-1", "opencode", "personal", "Root session"),
      makeSession("sub-1", "codex", "work", "Sub session", { parentSessionId: "root-1" }),
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
    // The sub session row should contain a [sub] indicator
    const sub1Line = result.stdout
      .split("\n")
      .find((line) => line.includes("sub-1"));
    expect(sub1Line).toBeDefined();
    expect(sub1Line!).toMatch(/\[sub\]|\(sub\)|sub-agent|child/i);
  });

  /**
   * WHY RED: Same as above — root sessions have no [main] tag. After fix:
   * sessions WITHOUT parentSessionId should display a [main] indicator to
   * provide symmetry and make the distinction clear.
   *
   * Fix: In formatSessionRow(), if no parentSessionId, add [main] tag.
   */
  test("list_output_shows_main_tag_for_root_sessions", async () => {
    const sessions = [
      // Title deliberately avoids the word "root" or "main" so the test
      // only passes when formatSessionRow adds a [main] tag explicitly
      makeSession("standalone-A", "opencode", "personal", "Independent session alpha"),
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
    // The root session row should contain a [main] indicator
    const standaloneLine = result.stdout
      .split("\n")
      .find((line) => line.includes("standalone-A"));
    expect(standaloneLine).toBeDefined();
    // Must match [main] or (main) — not just "main" in the title/id
    expect(standaloneLine!).toMatch(/\[main\]|\(main\)/);
  });
});
