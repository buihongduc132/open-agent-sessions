import { describe, expect, test } from "bun:test";
import { type SearchService, type SearchResult } from "../src/cli/search";
import { type Config } from "../src/config/types";
import { type SessionSummary, type SearchQuery } from "../src/core/types";
import { runSearchCommand } from "../src/cli/search";

// ============================================================================
// Fixtures
// ============================================================================

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
  ],
};

/**
 * Test sessions — each title is carefully constructed so that a plain
 * substring match on the full raw query string returns DIFFERENT results
 * than the intended boolean interpretation.  This guarantees tests fail
 * for the RIGHT reason (boolean operators not parsed) rather than by
 * accident (literal keyword appearing in a title).
 *
 * CRITICAL: IDs are chosen so no ID is a prefix of another.  bun:test's
 * `.toContain()` does a plain substring match, so "ses-ag" inside
 * "ses-agcb" would cause spurious failures on `not.toContain("ses-ag")`.
 *
 * Key insight:
 *   - "ast-grep" and "comby" are unique tokens that never appear inside other words
 *   - The session titled "ast-grep and gritql integration" contains the word "and"
 *     in the middle — a raw literal search for "ast-grep AND comby" would
 *     NEVER match it (no "comby"), but the BOOLEAN query would (intersection:
 *     has "ast-grep" AND does NOT have "comby" ✓)
 *
 * Session map:
 *   ses_AG     "Working with ast-grep for AST diffing"              → has: ast-grep only
 *   ses_CB     "Comby pattern rewrite tool exploration"              → has: comby only
 *   ses_GQ     "Evaluating gritql for code queries"                  → has: gritql only
 *   ses_AG_CB  "ast-grep vs comby comparison"                       → has: ast-grep, comby
 *   ses_AG_GQ  "ast-grep and gritql integration"                    → has: ast-grep, gritql
 *   ses_ALL    "ast-grep, comby, gritql — full comparison"         → has: all three
 *   ses_NONE   "General debugging session"                          → has: none
 *
 * Note: IDs use underscores and mixed case so none is a prefix of another.
 */

const sessionAg   = makeSession("ses_AG",   "opencode", "personal", "Working with ast-grep for AST diffing");
const sessionCb   = makeSession("ses_CB",   "codex",    "work",     "Comby pattern rewrite tool exploration");
const sessionGq   = makeSession("ses_GQ",   "opencode", "personal", "Evaluating gritql for code queries");
const sessionAgCb = makeSession("ses_AG_CB", "opencode", "personal", "ast-grep vs comby comparison");
const sessionAgGq = makeSession("ses_AG_GQ", "opencode", "personal", "ast-grep and gritql integration");
const sessionAll  = makeSession("ses_ALL",  "codex",    "work",     "ast-grep, comby, gritql — full comparison");
const sessionNone = makeSession("ses_NONE", "opencode", "personal", "General debugging session");

function makeSession(
  id: string,
  agent: string,
  alias: string,
  title: string,
): SessionSummary {
  return {
    id,
    agent,
    alias,
    title,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 5,
    storage: "db",
  };
}

// ============================================================================
// Mock strategy
// ============================================================================
//
// The mock MUST return results that differ based on whether the CLI has
// already parsed boolean operators out of the query text.
//
// If the CLI HAS parsed "ast-grep AND comby" into separate terms and called
// the service once per term (or transformed the query into a structured form),
// the raw query.text will contain neither "AND" nor "OR" nor "NOT" — and the
// mock does a plain substring match.
//
// If the CLI has NOT parsed operators and passes "ast-grep AND comby" as a
// single literal query.text string, the mock sees the raw operators and
// applies the BOOLEAN evaluation instead.
//
// Because our session titles are designed so that a literal match on the
// full raw query string returns a DIFFERENT (smaller or empty) set of sessions
// than the boolean evaluation, each test assertion will uniquely identify
// whether boolean parsing has been wired in.
//
// Returns from boolean-aware branch (query.text still contains operators):
//   "ast-grep AND comby"          → ses-agcb, ses-all
//   "ast-grep OR comby"           → ses-ag, ses-cb, ses-agcb, ses-all
//   "ast-grep NOT comby"          → ses-ag, ses-agpq, ses-all (NOT ses-agcb)
//   "ast-grep AND nonexistent"    → []
//   "nonexistent1 OR nonexistent2" → []
//   "ast-grep NOT nonexistent"    → ses-ag, ses-agcb, ses-agpq, ses-all
//   "ast-grep AND comby OR gritql" → ses-agcb, ses-gq, ses-agpq, ses-all
//   "(ast-grep OR comby) AND gritql" → ses-agpq, ses-all
//
// Returns from plain-substring branch (query.text has no operators):
//   "ast-grep"                    → ses-ag, ses-agcb, ses-agpq, ses-all
//   "comby"                       → ses-cb, ses-agcb, ses-all
//   "gritql"                      → ses-gq, ses-agpq, ses-all
//   "nonexistent"                 → []

const BOOLEAN_OPS = / AND | OR | NOT /i;

function buildBooleanAwareMock(sessions: SessionSummary[]): SearchService {
  return async (query: SearchQuery) => {
    const text: string = query.text.trim();

    if (BOOLEAN_OPS.test(text)) {
      // CLI has NOT parsed boolean operators — evaluate as a boolean query
      const results = booleanFilter(text, sessions);
      return { sessions: results, errors: [] };
    } else {
      // CLI HAS parsed operators and is passing pre-filtered terms —
      // do plain substring match so the test can distinguish the two states
      const term = text.toLowerCase();
      const results = term.length > 0
        ? sessions.filter((s) => s.title.toLowerCase().includes(term))
        : [];
      return { sessions: results, errors: [] };
    }
  };
}

// Minimal boolean query engine mirroring what the CLI should wire in.
// NOT part of the production code — used only inside test mocks.
//
// Operator precedence (highest → lowest):  AND  =  NOT  >  OR
//   "ast-grep AND comby OR gritql"  →  ((ast-grep AND comby) OR gritql)
//   "ast-grep NOT comby"           →  (ast-grep AND NOT(comby))
function booleanFilter(query: string, sessions: SessionSummary[]): SessionSummary[] {
  let q = query.trim();

  // Strip non-evaluating outer parentheses
  while (q.startsWith("(") && q.endsWith(")")) {
    const inner = q.slice(1, -1).trim();
    if (!inner.includes("(")) break;
    q = inner;
  }

  // Top-level OR (lowest precedence)
  const orIdx = findTopLevelOp(q, " OR ");
  if (orIdx !== -1) {
    return union(
      booleanFilter(q.slice(0, orIdx).trim(), sessions),
      booleanFilter(q.slice(orIdx + 4).trim(), sessions),
    );
  }

  // Top-level AND — also handles "X AND NOT Y" form
  const andIdx = findTopLevelOp(q, " AND ");
  if (andIdx !== -1) {
    const left = q.slice(0, andIdx).trim();
    const right = q.slice(andIdx + 5).trim();

    // "X AND NOT Y"  →  filter left results to exclude right NOT-term
    if (right.startsWith("NOT ")) {
      const exclude = right.slice(4).trim().toLowerCase();
      const lcExclude = exclude.toLowerCase();
      return booleanFilter(left, sessions).filter(
        (s) => !s.title.toLowerCase().includes(lcExclude),
      );
    }

    return intersection(
      booleanFilter(left, sessions),
      booleanFilter(right, sessions),
    );
  }

  // Standalone NOT (no top-level AND on left to attach to)
  if (q.startsWith("NOT ")) {
    const term = q.slice(4).trim().toLowerCase();
    return sessions.filter((s) => !s.title.toLowerCase().includes(term));
  }

  // Parenthesised group
  if (q.startsWith("(")) {
    const end = findMatchingParen(q, 0);
    if (end !== -1) return booleanFilter(q.slice(0, end + 1), sessions);
  }

  // Simple term
  const term = q.toLowerCase();
  return sessions.filter((s) => s.title.toLowerCase().includes(term));
}

function findTopLevelOp(query: string, op: string): number {
  let depth = 0;
  for (let i = 0; i <= query.length - op.length; i++) {
    const ch = query[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && query.slice(i, i + op.length) === op) {
      return i;
    }
  }
  return -1;
}

function findMatchingParen(query: string, start: number): number {
  let depth = 0;
  for (let i = start; i < query.length; i++) {
    if (query[i] === "(") depth++;
    else if (query[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function intersection(a: SessionSummary[], b: SessionSummary[]): SessionSummary[] {
  const ids = new Set(b.map((s) => s.id));
  return a.filter((s) => ids.has(s.id));
}

function union(a: SessionSummary[]): SessionSummary[];
function union(a: SessionSummary[], b: SessionSummary[]): SessionSummary[];
function union(a: SessionSummary[], b?: SessionSummary[]): SessionSummary[] {
  if (b === undefined) return a;
  const seen = new Set(a.map((s) => s.id));
  return [...a, ...b.filter((s) => !seen.has(s.id))];
}

// ============================================================================
// RED tests — all MUST fail until boolean operators are implemented
// ============================================================================

describe("cli search — boolean operators", () => {
  const allSessions = [
    sessionAg, sessionCb, sessionGq,
    sessionAgCb, sessionAgGq, sessionAll, sessionNone,
  ];

  // Helper: check for exact session-id lines, avoiding substring collisions
  // e.g. `expectNoSession(result.stdout, "ses_AG")` — ensures "(ses_AG)" appears
  // on its own line, not as part of a longer id like "ses_AG_CB".
  function expectSession(stdout: string, id: string) {
    expect(stdout).toContain(`(${id})`);
  }
  function expectNoSession(stdout: string, id: string) {
    // Match the "(id)" form only, on its own or at end-of-line, to avoid
    // accidentally matching it as a substring of a longer ID.
    expect(stdout).not.toContain(`(${id})`);
  }

  // -------------------------------------------------------------------------
  // AND
  // -------------------------------------------------------------------------
  describe("AND operator", () => {

    test("and_operator_returns_only_sessions_with_both_terms", async () => {
      // BEFORE fix: CLI passes raw "ast-grep AND comby" → mock sees operators
      //             and returns ses-agcb + ses-all (boolean AND: both terms present)
      //             BUT ses-all is NOT in the substring-only branch,
      //             so `not.toContain("ses-all")` FAILS → proves "AND" not parsed
      //
      // AFTER fix:  CLI splits into two separate single-term calls,
      //             OR transforms to structured query, OR removes operators
      //             → mock enters substring branch → only exact "ast-grep AND comby"
      //               literal match → likely empty → test still fails unless
      //               CLI correctly calls service per-term.
      //
      // The definitive check: query.text must NOT contain raw boolean operators.
      let capturedQuery: SearchQuery | null = null;
      const capturingMock: SearchService = async (q) => {
        capturedQuery = q;
        return buildBooleanAwareMock(allSessions)(q);
      };

      const result = await runSearchCommand({
        text: "ast-grep AND comby",
        config: baseConfig,
        searchSessions: capturingMock,
      });

      expect(result.exitCode).toBe(0);
      // ses_AG_CB has BOTH terms in its title — must appear
      expectSession(result.stdout, "ses_AG_CB");
      // ses_ALL has all three terms — must also appear (AND: all terms present)
      expectSession(result.stdout, "ses_ALL");
      // ses_AG and ses_CB have only ONE of the two terms — must NOT appear
      expectNoSession(result.stdout, "ses_AG");
      expectNoSession(result.stdout, "ses_CB");
      // ses_GQ has gritql only — has neither → must not appear
      expectNoSession(result.stdout, "ses_GQ");
      expectNoSession(result.stdout, "ses_NONE");

      // Definitive proof: the service must NOT receive raw boolean operators
      expect(capturedQuery!.text).not.toMatch(/ AND /i);
      expect(capturedQuery!.text).not.toMatch(/ OR /i);
    });

    test("and_with_no_match_returns_empty", async () => {
      let capturedQuery: SearchQuery | null = null;
      const capturingMock: SearchService = async (q) => {
        capturedQuery = q;
        return buildBooleanAwareMock([sessionAg, sessionCb, sessionAll])(q);
      };

      const result = await runSearchCommand({
        text: "ast-grep AND nonexistent",
        config: baseConfig,
        searchSessions: capturingMock,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No sessions found");
      // Definitively prove operators were parsed
      expect(capturedQuery!.text).not.toMatch(/ AND /i);
    });
  });

  // -------------------------------------------------------------------------
  // OR
  // -------------------------------------------------------------------------
  describe("OR operator", () => {

    test("or_operator_returns_union", async () => {
      let capturedQuery: SearchQuery | null = null;
      const capturingMock: SearchService = async (q) => {
        capturedQuery = q;
        return buildBooleanAwareMock(allSessions)(q);
      };

      const result = await runSearchCommand({
        text: "ast-grep OR comby",
        config: baseConfig,
        searchSessions: capturingMock,
      });

      expect(result.exitCode).toBe(0);
      // Union of sessions containing "ast-grep" OR "comby":
      expectSession(result.stdout, "ses_AG");   // ast-grep
      expectSession(result.stdout, "ses_CB");   // comby
      expectSession(result.stdout, "ses_AG_CB"); // both
      expectSession(result.stdout, "ses_ALL");   // all three
      // ses_GQ has gritql only — not in union
      expectNoSession(result.stdout, "ses_GQ");
      expectNoSession(result.stdout, "ses_NONE");

      expect(capturedQuery!.text).not.toMatch(/ OR /i);
    });

    test("or_with_no_match_returns_empty", async () => {
      let capturedQuery: SearchQuery | null = null;
      const capturingMock: SearchService = async (q) => {
        capturedQuery = q;
        return buildBooleanAwareMock([sessionAg, sessionCb, sessionAll])(q);
      };

      const result = await runSearchCommand({
        text: "nonexistent1 OR nonexistent2",
        config: baseConfig,
        searchSessions: capturingMock,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No sessions found");
      expect(capturedQuery!.text).not.toMatch(/ OR /i);
    });
  });

  // -------------------------------------------------------------------------
  // NOT
  // -------------------------------------------------------------------------
  describe("NOT operator", () => {

    test("not_operator_excludes_term", async () => {
      let capturedQuery: SearchQuery | null = null;
      const capturingMock: SearchService = async (q) => {
        capturedQuery = q;
        return buildBooleanAwareMock(allSessions)(q);
      };

      const result = await runSearchCommand({
        text: "ast-grep NOT comby",
        config: baseConfig,
        searchSessions: capturingMock,
      });

      expect(result.exitCode).toBe(0);
      // NOT has higher precedence than AND, so "ast-grep NOT comby"
      // is parsed as: (ast-grep) AND (NOT comby)
      // → sessions with "ast-grep" whose titles do NOT contain "comby"
      expectSession(result.stdout, "ses_AG");   // ast-grep only
      expectSession(result.stdout, "ses_AG_GQ"); // ast-grep + gritql (no comby)
      // ses_ALL: has comby → excluded by NOT comby
      expectNoSession(result.stdout, "ses_ALL");
      // ses_AG_CB: has comby → excluded
      expectNoSession(result.stdout, "ses_AG_CB");
      // ses_CB: has no ast-grep → excluded by the left side
      expectNoSession(result.stdout, "ses_CB");

      expect(capturedQuery!.text).not.toMatch(/ NOT /i);
    });

    test("not_with_no_match_still_filters", async () => {
      let capturedQuery: SearchQuery | null = null;
      const capturingMock: SearchService = async (q) => {
        capturedQuery = q;
        return buildBooleanAwareMock([sessionAg, sessionAgCb, sessionAgGq, sessionAll])(q);
      };

      const result = await runSearchCommand({
        text: "ast-grep NOT nonexistent",
        config: baseConfig,
        searchSessions: capturingMock,
      });

      expect(result.exitCode).toBe(0);
      // "nonexistent" doesn't appear in any title → NOT removes nothing
      // → all sessions with "ast-grep" should be returned
      expectSession(result.stdout, "ses_AG");
      expectSession(result.stdout, "ses_AG_CB");
      expectSession(result.stdout, "ses_AG_GQ");
      expectSession(result.stdout, "ses_ALL");
      expect(capturedQuery!.text).not.toMatch(/ NOT /i);
    });
  });

  // -------------------------------------------------------------------------
  // Precedence
  // -------------------------------------------------------------------------
  describe("operator precedence", () => {

    test("mixed_operators_and_higher_precedence_than_or", async () => {
      // "ast-grep AND comby OR gritql" with AND > OR
      // → "(ast-grep AND comby) OR gritql"
      //   = sessions with (ast-grep AND comby)  [ses-agcb, ses-all]
      //     UNION sessions with gritql          [ses-gq, ses-agpq, ses-all]
      //   = ses-agcb, ses-gq, ses-agpq, ses-all
      let capturedQuery: SearchQuery | null = null;
      const capturingMock: SearchService = async (q) => {
        capturedQuery = q;
        return buildBooleanAwareMock(allSessions)(q);
      };

      const result = await runSearchCommand({
        text: "ast-grep AND comby OR gritql",
        config: baseConfig,
        searchSessions: capturingMock,
      });

      expect(result.exitCode).toBe(0);
      expectSession(result.stdout, "ses_AG_CB"); // ast-grep AND comby
      expectSession(result.stdout, "ses_GQ");   // gritql (OR side)
      expectSession(result.stdout, "ses_AG_GQ"); // gritql (OR side)
      expectSession(result.stdout, "ses_ALL");   // all three

      // ses_AG (ast-grep only) and ses_CB (comby only):
      // neither satisfies (ast-grep AND comby) nor has gritql → excluded
      expectNoSession(result.stdout, "ses_AG");
      expectNoSession(result.stdout, "ses_CB");
      expectNoSession(result.stdout, "ses_NONE");

      expect(capturedQuery!.text).not.toMatch(/ AND /i);
      expect(capturedQuery!.text).not.toMatch(/ OR /i);
    });
  });

  // -------------------------------------------------------------------------
  // Parentheses
  // -------------------------------------------------------------------------
  describe("parentheses grouping", () => {

    test("parentheses_grouping_respects_precedence_override", async () => {
      // "(ast-grep OR comby) AND gritql"
      // → (sessions with ast-grep OR sessions with comby) AND sessions with gritql
      //   = [ses-ag, ses-cb, ses-agcb, ses-all] ∩ [ses-gq, ses-agpq, ses-all]
      //   = ses-agpq, ses-all
      let capturedQuery: SearchQuery | null = null;
      const capturingMock: SearchService = async (q) => {
        capturedQuery = q;
        return buildBooleanAwareMock(allSessions)(q);
      };

      const result = await runSearchCommand({
        text: "(ast-grep OR comby) AND gritql",
        config: baseConfig,
        searchSessions: capturingMock,
      });

      expect(result.exitCode).toBe(0);
      expectSession(result.stdout, "ses_AG_GQ"); // ast-grep + gritql
      expectSession(result.stdout, "ses_ALL");    // all three

      // ses_GQ: has gritql but NEITHER ast-grep nor comby → excluded
      expectNoSession(result.stdout, "ses_GQ");
      // ses_AG (ast-grep only) and ses_CB (comby only): no gritql → excluded
      expectNoSession(result.stdout, "ses_AG");
      expectNoSession(result.stdout, "ses_CB");
      expectNoSession(result.stdout, "ses_AG_CB"); // has ast-grep+comby, no gritql

      expect(capturedQuery!.text).not.toMatch(/\(/);
      expect(capturedQuery!.text).not.toMatch(/ AND /i);
      expect(capturedQuery!.text).not.toMatch(/ OR /i);
    });
  });

  // -------------------------------------------------------------------------
  // Gap 2 extension: Fuzzy / substring matching (explicit requirement from gaps.md)
  // gaps.md says: "No fuzzy / substring matching" — should be added
  // -------------------------------------------------------------------------
  describe("Gap 2 extension — fuzzy and substring matching", () => {

    test("substring_match_finds_term_as_part_of_word", async () => {
      // "sqlite-vec" should match session titled "sqlitevec session" (no hyphen)
      // Fuzzy/substring search should NOT require exact word boundary.
      let capturedQuery: SearchQuery | null = null;
      const fuzzyMock: SearchService = async (q) => {
        capturedQuery = q;
        return buildBooleanAwareMock([
          makeSession("oc-sql", "opencode", "personal", "sqlitevec session"),
          makeSession("oc-ts", "codex", "work", "typescript patterns"),
        ])(q);
      };

      const result = await runSearchCommand({
        text: "sqlite-vec",
        config: baseConfig,
        searchSessions: fuzzyMock,
      });

      expect(result.exitCode).toBe(0);
      // fuzzy search: "sqlite-vec" matches "sqlitevec" (hyphen dropped = substring)
      expect(result.stdout).toContain("oc-sql");
    });

    test("case_insensitive_substring_match", async () => {
      // Search "AST-GREP" should match "ast-grep integration" (case insensitive)
      let capturedQuery: SearchQuery | null = null;
      const caseMock: SearchService = async (q) => {
        capturedQuery = q;
        return buildBooleanAwareMock([
          makeSession("oc-upper", "opencode", "personal", "AST-GREP PATTERNS"),
          makeSession("oc-lower", "codex", "work", "ast-grep basics"),
        ])(q);
      };

      const result = await runSearchCommand({
        text: "AST-GREP",
        config: baseConfig,
        searchSessions: caseMock,
      });

      expect(result.exitCode).toBe(0);
      // Should match BOTH uppercase and lowercase titles
      expect(result.stdout).toContain("oc-upper");
      expect(result.stdout).toContain("oc-lower");
    });
  });
});
