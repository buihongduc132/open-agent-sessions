import { describe, expect, test } from "bun:test";
import { runSearchCommand, type SearchService } from "../src/cli/search";
import { type Config } from "../src/config/types";
import { type SessionSummary } from "../src/core/types";

// ============================================================================
// Test fixture helpers
// ============================================================================

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
  ],
};

function makeSession(id: string, title: string): SessionSummary {
  return {
    id,
    agent: "opencode",
    alias: "personal",
    title,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 1,
    storage: "db",
  };
}

// ============================================================================
// BUG 1: /g flag causes stateful regex.test() to silently drop results
// ============================================================================
// Root cause: parseRegex() preserves the 'g' flag from user input.
// RegExp.test() with 'g' flag is stateful — lastIndex advances after each call.
// In .filter() loops at lines ~97-99 and ~161-163, the same regex instance is
// reused across iterations, causing alternating match/no-match due to lastIndex
// not being reset between calls.
// ============================================================================

describe("BUG 1: /g flag stateful regex.test()", () => {
  test("regex with /g flag does not drop results in simple search", async () => {
    const sessions = [
      makeSession("s1", "test session 1"),
      makeSession("s2", "test session 2"),
      makeSession("s3", "test session 3"),
      makeSession("s4", "test session 4"),
    ];

    const svc: SearchService = async () => ({ sessions, errors: [] });

    // /test/gi — global flag + case-insensitive
    // BUG: With 'g' flag, regex.test() alternates true/false due to lastIndex
    // Expected: all 4 sessions returned
    // Actual (buggy): only 2 sessions returned (every other one dropped)
    const result = await runSearchCommand({
      text: "/test/gi",
      config: baseConfig,
      searchSessions: svc,
    });

    expect(result.exitCode).toBe(0);
    // ALL 4 sessions must be present — none silently dropped
    expect(result.stdout).toContain("s1");
    expect(result.stdout).toContain("s2");
    expect(result.stdout).toContain("s3");
    expect(result.stdout).toContain("s4");
  });

  test("regex with /g flag does not drop results when matching on session id", async () => {
    const sessions = [
      makeSession("alpha-test-1", "unrelated title"),
      makeSession("alpha-test-2", "unrelated title"),
      makeSession("alpha-test-3", "unrelated title"),
      makeSession("alpha-test-4", "unrelated title"),
      makeSession("alpha-test-5", "unrelated title"),
      makeSession("alpha-test-6", "unrelated title"),
    ];

    const svc: SearchService = async () => ({ sessions, errors: [] });

    // Regex matches against id field (contains "alpha-test")
    // With /g flag, every other test() call returns false
    const result = await runSearchCommand({
      text: "/alpha-test/g",
      config: baseConfig,
      searchSessions: svc,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("alpha-test-1");
    expect(result.stdout).toContain("alpha-test-2");
    expect(result.stdout).toContain("alpha-test-3");
    expect(result.stdout).toContain("alpha-test-4");
    expect(result.stdout).toContain("alpha-test-5");
    expect(result.stdout).toContain("alpha-test-6");
  });

  test("regex with /g flag in boolean query does not drop results", async () => {
    const sessions = [
      makeSession("s1", "test alpha"),
      makeSession("s2", "test beta"),
      makeSession("s3", "test gamma"),
      makeSession("s4", "test delta"),
    ];

    const svc: SearchService = async () => ({ sessions, errors: [] });

    // Boolean query with /g flag regex term
    const result = await runSearchCommand({
      text: "/test/gi AND test",
      config: baseConfig,
      searchSessions: svc,
    });

    expect(result.exitCode).toBe(0);
    // All sessions have "test" in title — regex AND literal should match all
    expect(result.stdout).toContain("s1");
    expect(result.stdout).toContain("s2");
    expect(result.stdout).toContain("s3");
    expect(result.stdout).toContain("s4");
  });

  test("regex with /g flag matches all even with many sessions", async () => {
    // Use 10 sessions to stress the lastIndex bug — with 'g' flag,
    // a stateful regex alternates: match, no-match, match, no-match...
    const sessions = Array.from({ length: 10 }, (_, i) =>
      makeSession(`session-${i}`, `test number ${i}`)
    );

    const svc: SearchService = async () => ({ sessions, errors: [] });

    const result = await runSearchCommand({
      text: "/test/gi",
      config: baseConfig,
      searchSessions: svc,
    });

    expect(result.exitCode).toBe(0);
    // All 10 sessions must be returned
    for (let i = 0; i < 10; i++) {
      expect(result.stdout).toContain(`session-${i}`);
    }
  });
});

// ============================================================================
// BUG 2: ReDoS — no protection against catastrophic backtracking
// ============================================================================
// Root cause: parseRegex() accepts ANY regex pattern including patterns like
// /(a+)+$/ which cause exponential backtracking. On strings with many 'a'
// characters, execution time explodes exponentially.
//
// Expected fix: either reject dangerous patterns, strip problematic
// quantifiers, or enforce a timeout.
// ============================================================================

describe("BUG 2: ReDoS — catastrophic backtracking", () => {
  test("catastrophic backtracking pattern does not hang the process", async () => {
    // Longer strings trigger exponential backtracking on /(a+)+$/
    // At length 30+ the regex engine tries exponentially many partitions
    const sessions = Array.from({ length: 5 }, (_, i) =>
      makeSession(`s${i}`, "a".repeat(35) + "!")
    );

    const svc: SearchService = async () => ({ sessions, errors: [] });

    // This pattern causes catastrophic backtracking on strings of 'a's.
    // The regex engine tries exponentially many ways to partition the 'a's.
    // Must complete within a reasonable time (not hang for minutes)
    const start = Date.now();
    const result = await runSearchCommand({
      text: "/(a+)+$/",
      config: baseConfig,
      searchSessions: svc,
    });
    const elapsed = Date.now() - start;

    // Should not crash — either reject the pattern or complete within timeout
    expect([0, 1]).toContain(result.exitCode);
    // Must complete within 5 seconds — if it takes longer, ReDoS is happening
    expect(elapsed).toBeLessThan(5000);
  });

  test("nested quantifier pattern does not hang", async () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      makeSession(`s${i}`, "x".repeat(30) + "!")
    );

    const svc: SearchService = async () => ({ sessions, errors: [] });

    // Another classic ReDoS pattern: (x+)+y
    const start = Date.now();
    const result = await runSearchCommand({
      text: "/(x+)+y/",
      config: baseConfig,
      searchSessions: svc,
    });
    const elapsed = Date.now() - start;

    expect([0, 1]).toContain(result.exitCode);
    expect(elapsed).toBeLessThan(5000);
  });

  test("alternation with overlapping quantifier does not hang", async () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      makeSession(`s${i}`, "a".repeat(28) + "c")
    );

    const svc: SearchService = async () => ({ sessions, errors: [] });

    // (a|a)+ type patterns with backtracking pressure
    const start = Date.now();
    const result = await runSearchCommand({
      text: "/(a|a)+b$/",
      config: baseConfig,
      searchSessions: svc,
    });
    const elapsed = Date.now() - start;

    expect([0, 1]).toContain(result.exitCode);
    expect(elapsed).toBeLessThan(5000);
  });
});
