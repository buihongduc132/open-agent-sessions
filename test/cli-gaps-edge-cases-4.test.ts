/**
 * test/cli-gaps-edge-cases-4.test.ts
 *
 * RED tests for SPECIFIC UNCOVERED gaps in the oas CLI.
 *
 * Gaps covered:
 *   GAP 1  — buildForkChain circular reference → infinite loop
 *   GAP 2  — --sub-only flag missing
 *   GAP 3  — boolean query hyphen normalization broken
 *   GAP 4  — whitespace-only title causes empty rows
 *   GAP 5  — list output missing [main] / [sub] role tag
 *   GAP 6  — sub-agents shown by default (no filter)
 *   GAP 7  — parentSessionId never populated by adapters (CLI contract)
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
import { resolve } from "path";

const RESULT_FILE = "/tmp/oas-fork-chain-result.txt";
// Resolve the project root so the subprocess can import source files regardless of cwd
const PROJECT_ROOT = resolve(__dirname, "..");

function runForkChainInSubprocess(
  sessionSetupCode: string,
  startSessionVar: string,
): { completed: boolean; chainLength: number | null; error: string | null } {
    const script = `
import { buildForkChain } from "${PROJECT_ROOT}/src/core/subagents";

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

    // GAP 6 supersedes the original GAP 5 expectation: child sessions are hidden
    // by default. Use --children-of (drill-down) to reveal them, matching GAP 6's
    // intended context for [sub] tags.
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      childrenOf: "root-1",
    });

    expect(result.exitCode).toBe(0);
    // The sub session row should contain a [sub] indicator in the drill-down view
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

// ============================================================================
// GAP 6 — Sub-agent sessions shown by default in CLI and TUI (no filter)
// ============================================================================
// Root cause: Both `runListCommand` (CLI) and `applyFilters` / list view (TUI)
// display ALL sessions including sub-agent sessions (sessions with a parentSessionId).
// Users see noise from child sessions mixed with root sessions.
//
// Requirement: By DEFAULT, sub-agent sessions must be FILTERED OUT.
// The root session row MUST carry an indicator showing how many child sessions
// exist (e.g. "[main] +3"). This tells users at a glance that the session has
// sub-agents without cluttering the list.
//
// When the user wants to see sub-agents, they can:
//   CLI  : use `--children-of <session-id>` or `--sub-only`
//   TUI  : press Enter / navigate into the root session to see its children
//
// ---- CLI default view ----
//
//   [opencode:personal] [main] +4  My research session (ses_001)
//   [opencode:personal] [main] -   Quick patch (ses_002)
//   [codex:work]       [main] +1  PRD draft (ses_003)
//   [opencode:personal] [main] -   Standalone root (ses_004)
//
//   - Rows with `parentSessionId` are NEVER shown in the default view.
//   - `+N` label appears only when N > 0, `-` when the session has no children.
//   - Drill-down in CLI: `--children-of ses_001` to list children.
//
// ---- TUI default list view ----
//
//   ▸ opencode   personal  My research session         4   ██████  10:32
//     opencode   personal  Quick patch                -   █████   09:14
//   ▸ codex      work      PRD draft                   1   ████    09:01
//     opencode   personal  Standalone root            -   ██      08:55
//
//   - `▸` appears ONLY on rows with children > 0 (not on rows with `-`).
//   - Children column: bare NUMBER (e.g. 4, 1) or `-` when zero.
//   - Rows with `parentSessionId` are hidden by default.
//   - Cursor + Enter on a ▸ row → drill-down view for that session.
//
// ---- TUI drill-down view (after Enter on a ▸ row) ----
//
//   ← BACK  │  ses_001 "My research session"
//   opencode   personal  [sub] Sub-session A (ses_005)     ████    10:30
//   codex      work      [sub] Sub-session B (ses_006)     ███     10:28
//   opencode   personal  [sub] Sub-session C (ses_007)     ██      10:25
//   opencode   personal  [sub] (no title) (ses_008)       █       10:20
//
//   - "← BACK" returns to the root-only list view.
//
// Implementation notes:
//   1. CLI `runListCommand` — the DEFAULT path (no flags) must filter:
//        sessions = sessions.filter(s => !s.parentSessionId)
//      BEFORE applying rootsOnly / childrenOf / subOnly / includeSubagents flags.
//      childCount must be computed from the FULL (unfiltered) list of sessions:
//        childCount = allSessions.filter(s => s.parentSessionId === session.id).length
//      Append `+N` badge if N > 0, `-` if N === 0.
//   2. TUI `applyFilters` — add filter: exclude sessions with parentSessionId.
//      childCount must be computed from allSessions (unfiltered), not filteredSessions.
//   3. TUI row renderer — children column: bare number or `-`; `▸` only when children > 0.
//   4. TUI navigation — add a TuiEffect variant: { type: "drill-down"; parent: SessionSummary }.
//      Map Enter key on a ▸ row to the drill-down view.
//   5. CLI: add `includeSubagents?: boolean` to ListOptions.
//      When true, skip the default roots-only filter (show everything, no +N badges).
//      Mutual conflict: `rootsOnly` + `includeSubagents` returns exit 1.
//   6. `childrenOf` + `subOnly` — add mutual conflict validation (returns exit 1).
// ============================================================================

describe("GAP 6 — Sub-agent sessions shown by default (no filter)", () => {
  const allSessions = [
    makeSession("ses_001", "opencode", "personal", "My research session"),
    makeSession("ses_005", "opencode", "personal", "Sub-session A", { parentSessionId: "ses_001" }),
    makeSession("ses_006", "codex", "work", "Sub-session B", { parentSessionId: "ses_001" }),
    makeSession("ses_007", "opencode", "personal", "Sub-session C", { parentSessionId: "ses_001" }),
    makeSession("ses_008", "opencode", "personal", "Untitled sub", { parentSessionId: "ses_001" }),
    makeSession("ses_010", "opencode", "personal", "Nested child", { parentSessionId: "ses_005" }), // nested child
    makeSession("ses_002", "opencode", "personal", "Quick patch"),
    makeSession("ses_003", "codex", "work", "PRD draft"),
    makeSession("ses_009", "codex", "work", "Child of PRD", { parentSessionId: "ses_003" }),
    makeSession("ses_004", "opencode", "personal", "Standalone root"),
  ];

  const listService: ListService = async () => ({
    sessions: allSessions,
    errors: [],
  });

  /**
   * WHY RED: By default, runListCommand shows ALL sessions including sub-agents.
   * ses_005 through ses_010 all have parentSessionId and should NOT appear.
   * ses_001 and ses_003 must show "+N" child count badges.
   */
  test("list_default_hides_child_sessions_and_shows_child_count_badge", async () => {
    const result = await runListCommand({ config: baseConfig, list: listService });

    expect(result.exitCode).toBe(0);

    // Root sessions appear
    expect(result.stdout).toContain("ses_001");
    expect(result.stdout).toContain("ses_002");
    expect(result.stdout).toContain("ses_003");
    expect(result.stdout).toContain("ses_004");

    // All sessions with parentSessionId are hidden (including nested)
    expect(result.stdout).not.toContain("ses_005"); // parent: ses_001
    expect(result.stdout).not.toContain("ses_006"); // parent: ses_001
    expect(result.stdout).not.toContain("ses_007"); // parent: ses_001
    expect(result.stdout).not.toContain("ses_008"); // parent: ses_001
    expect(result.stdout).not.toContain("ses_009"); // parent: ses_003
    expect(result.stdout).not.toContain("ses_010"); // nested: parent ses_005

    // Child count badges: ses_001 has 4 direct children, ses_003 has 1
    const lines = result.stdout.split("\n").filter(Boolean);
    const ses001Line = lines.find((l) => l.includes("ses_001"));
    const ses003Line = lines.find((l) => l.includes("ses_003"));
    const ses002Line = lines.find((l) => l.includes("ses_002"));

    expect(ses001Line).toMatch(/\+4/);
    expect(ses003Line).toMatch(/\+1/);
    // ses_002 has no children — must show "-" not "+N"
    expect(ses002Line).toMatch(/-/);
  });

  /**
   * WHY RED: `--sub-only` should show ONLY child sessions (no roots).
   * The opposite of the default. ses_005–ses_010 only.
   */
  test("list_sub_only_shows_only_child_sessions", async () => {
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      subOnly: true,
    });

    expect(result.exitCode).toBe(0);

    // Only sessions WITH parentSessionId appear (includes nested)
    expect(result.stdout).toContain("ses_005");
    expect(result.stdout).toContain("ses_006");
    expect(result.stdout).toContain("ses_007");
    expect(result.stdout).toContain("ses_008");
    expect(result.stdout).toContain("ses_009");
    expect(result.stdout).toContain("ses_010"); // nested child

    // Root sessions are hidden
    expect(result.stdout).not.toContain("ses_001");
    expect(result.stdout).not.toContain("ses_002");
    expect(result.stdout).not.toContain("ses_003");
    expect(result.stdout).not.toContain("ses_004");
  });

  /**
   * WHY RED: `--children-of ses_001` shows only DIRECT children of ses_001.
   * ses_005–ses_008 only. ses_010 (nested child of ses_005) is NOT shown.
   */
  test("list_children_of_shows_only_direct_children", async () => {
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      childrenOf: "ses_001",
    });

    expect(result.exitCode).toBe(0);

    expect(result.stdout).toContain("ses_005");
    expect(result.stdout).toContain("ses_006");
    expect(result.stdout).toContain("ses_007");
    expect(result.stdout).toContain("ses_008");

    // ses_010 is nested (child of ses_005), not a direct child of ses_001
    expect(result.stdout).not.toContain("ses_010");
    // ses_009 is child of ses_003, not ses_001
    expect(result.stdout).not.toContain("ses_009");
    // Root sessions are hidden in childrenOf view
    expect(result.stdout).not.toContain("ses_001");
  });

  /**
   * WHY RED: `--children-of` with a nonexistent parent ID returns exit 0
   * with "No sessions found." (empty result, not an error).
   */
  test("list_children_of_nonexistent_parent_returns_empty", async () => {
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      childrenOf: "ses_999",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no sessions found/i);
  });

  /**
   * WHY RED: `--children-of` on a session that IS itself a leaf child (has no
   * children) returns 0 sessions (exit 0, not an error). ses_009 is a child
   * of ses_003 and has no children of its own, so childrenOf: ses_009 is an
   * empty result.
   */
  test("list_children_of_child_session_with_no_direct_children_returns_empty", async () => {
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      childrenOf: "ses_009",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no sessions found/i);
  });

  /**
   * WHY RED: `--sub-only` + `--children-of` together is contradictory:
   * subOnly says "sessions WITH a parent", childrenOf says "sessions whose
   * parent is X". The intersection is valid in theory but the combination
   * is confusing UX — reject it explicitly.
   */
  test("list_sub_only_and_children_of_conflict_returns_error", async () => {
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      subOnly: true,
      childrenOf: "ses_001",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/cannot use|conflict|mutually exclusive/i);
  });

  /**
   * WHY RED: `--include-subagents` overrides the default filter so all sessions
   * are shown, including child sessions. No +N badges, no - indicators.
   */
  test("list_include_subagents_overrides_default_and_shows_all", async () => {
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      includeSubagents: true,
    });

    expect(result.exitCode).toBe(0);

    // All 10 sessions appear
    for (const id of ["ses_001", "ses_002", "ses_003", "ses_004", "ses_005", "ses_006", "ses_007", "ses_008", "ses_009", "ses_010"]) {
      expect(result.stdout).toContain(id);
    }

    // No +N badges in include-subagents mode
    expect(result.stdout).not.toMatch(/\+\d/);
    // No - indicators either
    expect(result.stdout).not.toMatch(/\s-\s/);
  });

  /**
   * WHY RED: `rootsOnly` and `includeSubagents` are contradictory.
   * rootsOnly says "only roots", includeSubagents says "show everything".
   */
  test("list_include_subagents_and_roots_only_conflict", async () => {
    const result = await runListCommand({
      config: baseConfig,
      list: listService,
      rootsOnly: true,
      includeSubagents: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/cannot use|conflict|mutually exclusive/i);
  });
});

// ============================================================================
// GAP 7 — parentSessionId field exists but is never populated by any adapter
// ============================================================================
// Root cause: SessionSummary has parentSessionId?: string, and runListCommand
// filters on it, but ZERO adapters populate it when building SessionSummary[].
//
// The CLI filters (rootsOnly, subOnly, childrenOf, default child filter)
// are dead code — they always receive sessions with undefined parentSessionId.
//
// Sources:
//   opencode DB: schema has parent_id column (session.parent_id) but
//                listSessionsFromDb never reads it (opencode.ts:360-369)
//   opencode JSONL: session.clone.src.session_id exists but is never read
//   codex: unknown — JSONL schema may not store parent info at all
//   claude: unknown — JSONL schema may not store parent info at all
//
// The CLI-layer GAP 6 tests pass pre-populated parentSessionId via mock
// ListService — but the real ListService never sees those values because
// adapters drop them.
//
// Gap 8 tests (adapter tests) verify that EACH adapter sets parentSessionId
// when the source storage has the information available.
//
// GAP 7 is the acknowledgment that the CLI layer is already correct (verified
// by GAP 6 tests), but only works when adapters are fixed (GAP 8).
// ============================================================================

describe("GAP 7 — parentSessionId never populated by adapters (downstream CLI contract)", () => {
  /**
   * WHY RED: This test documents the current broken state.
   *
   * A real ListService (backed by createListService from core/list.ts) calls
   * each adapter's listSessions(). If the adapters return sessions WITHOUT
   * parentSessionId, then the CLI default filter will show ALL sessions as
   * roots — no [sub] rows, no +N badges, GAP 6 is broken in production.
   *
   * This test simulates the production broken state: a ListService that
   * returns sessions the way the current adapters do (no parentSessionId).
   *
   * After GAP 8 (adapters fixed), this test should STILL pass — because
   * the real ListService will return sessions WITH parentSessionId populated.
   *
   * The test confirms that runListCommand CORRECTLY propagates whatever
   * parentSessionId values it receives. The adapters are the broken link.
   */
  test("runlistcommand_preserves_parentSessionId_when_provided_by_listService", async () => {
    // Sessions returned exactly as current adapters return them: no parentSessionId
    const sessionsWithoutParent: SessionSummary[] = [
      makeSession("ses_root", "opencode", "personal", "Root session"),
      makeSession("ses_child", "codex", "work", "Child session"),
    ];

    // Sessions WITH parentSessionId — what adapters SHOULD return after GAP 8
    const sessionsWithParent: SessionSummary[] = [
      makeSession("ses_root", "opencode", "personal", "Root session"),
      makeSession("ses_child", "codex", "work", "Child session", { parentSessionId: "ses_root" }),
    ];

    // BROKEN: adapters return sessions WITHOUT parentSessionId
    const brokenListService: ListService = async () => ({
      sessions: sessionsWithoutParent,
      errors: [],
    });

    // FIXED: adapters return sessions WITH parentSessionId
    const fixedListService: ListService = async () => ({
      sessions: sessionsWithParent,
      errors: [],
    });

    // With broken adapters (no parentSessionId): CLI shows ALL sessions.
    // childCounts map is empty (all sessions have parentSessionId=undefined),
    // so every session gets count=0 → badge = "-".
    // ses_root and ses_child both show "-" — no way to know ses_child is a child.
    const brokenResult = await runListCommand({ config: baseConfig, list: brokenListService });
    expect(brokenResult.exitCode).toBe(0);
    expect(brokenResult.stdout).toContain("ses_root");
    expect(brokenResult.stdout).toContain("ses_child"); // child NOT filtered — adapters dropped parentSessionId!
    // ses_root shows "-" badge (broken state — no +1 because childCounts is empty)
    const brokenSesRootLine = brokenResult.stdout.split("\n").find((l) => l.includes("ses_root"));
    expect(brokenSesRootLine).toMatch(/\s-/);        // shows "-" in broken state
    expect(brokenSesRootLine).not.toMatch(/\s\+1/);  // never +1 in broken state

    // With fixed adapters (parentSessionId populated): CLI correctly filters children
    const fixedResult = await runListCommand({ config: baseConfig, list: fixedListService });
    expect(fixedResult.exitCode).toBe(0);
    expect(fixedResult.stdout).toContain("ses_root");
    // ses_child has parentSessionId: ses_root, so it is filtered from default view
    expect(fixedResult.stdout).not.toContain("ses_child");

    // In fixed mode, ses_root should show " +1" child badge (leading space from formatSessionRow)
    const sesRootLine = fixedResult.stdout.split("\n").find((l) => l.includes("ses_root"));
    expect(sesRootLine).toMatch(/\s\+1/);
  });

  /**
   * WHY RED: GAP 6 default filter is meaningless until adapters are fixed.
   *
   * With the broken (current) adapter behavior, ses_001 shows "-" because
   * the adapter didn't populate parentSessionId on ses_002 — so the CLI has
   * no way to know ses_001 has a child. All sessions appear as isolated roots.
   *
   * After GAP 8, ses_002 will have parentSessionId = "ses_001", and the CLI
   * will correctly show "+1" on ses_001.
   */
  test("broken_adapters_make_all_sessions_appear_as_roots_with_dash_badge", async () => {
    // BROKEN: adapters return sessions WITHOUT parentSessionId (simulates current state)
    // ses_002 has no parentSessionId — CLI can't know it's a child of ses_001
    const sessionsFromBrokenAdapters: SessionSummary[] = [
      makeSession("ses_001", "opencode", "personal", "Research session"),
      makeSession("ses_002", "codex", "work", "Child of 001"),
      // ^ no parentSessionId — simulates current broken adapter behavior
    ];

    // FIXED: adapters return sessions WITH parentSessionId populated
    const sessionsAfterGap8: SessionSummary[] = [
      makeSession("ses_001", "opencode", "personal", "Research session"),
      makeSession("ses_002", "codex", "work", "Child of 001", { parentSessionId: "ses_001" }),
    ];

    // BROKEN state: ses_001 shows "-" because childCounts is empty
    // (ses_002 has no parentSessionId → no entry in childCounts map → count=0 → "-")
    const brokenResult = await runListCommand({
      config: baseConfig,
      list: async () => ({ sessions: sessionsFromBrokenAdapters, errors: [] }),
    });
    expect(brokenResult.exitCode).toBe(0);
    const brokenLines = brokenResult.stdout.split("\n").filter(Boolean);
    const brokenSes001Line = brokenLines.find((l) => l.includes("ses_001"));
    // Broken state: shows "-" (no children detected)
    expect(brokenSes001Line).toMatch(/\s-/);       // ← RED: currently shows "-"
    expect(brokenSes001Line).not.toMatch(/\s\+1/); // never shows +1 in broken state

    // FIXED state: ses_001 shows "+1" badge (ses_002 has parentSessionId=ses_001)
    const fixedResult = await runListCommand({
      config: baseConfig,
      list: async () => ({ sessions: sessionsAfterGap8, errors: [] }),
    });
    expect(fixedResult.exitCode).toBe(0);
    const fixedLines = fixedResult.stdout.split("\n").filter(Boolean);
    const fixedSes001Line = fixedLines.find((l) => l.includes("ses_001"));
    expect(fixedSes001Line).toMatch(/\s\+1/);
  });

  /**
   * WHY RED: childrenOf with broken adapters returns "No sessions found."
   * ses_002's parentSessionId was dropped, so childrenOf:"ses_001" finds nothing.
   */
  test("childrenOf_returns_no_sessions_when_adapters_drop_parentSessionId", async () => {
    const brokenSessions: SessionSummary[] = [
      makeSession("ses_001", "opencode", "personal", "Research session"),
      makeSession("ses_002", "codex", "work", "Child of 001"), // parentSessionId dropped
    ];

    const result = await runListCommand({
      config: baseConfig,
      list: async () => ({ sessions: brokenSessions, errors: [] }),
      childrenOf: "ses_001",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no sessions found/i);
    // With fixed adapters, ses_002 would have parentSessionId: "ses_001",
    // so childrenOf:"ses_001" would return ses_002
  });
});
