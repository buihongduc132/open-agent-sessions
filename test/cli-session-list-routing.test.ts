import { describe, expect, test } from "bun:test";
import { runCLI } from "./helpers/run-cli";

const CI = !!process.env.CI;

// ============================================================================
// CLI `oas session list` Routing Tests
//
// Tests the `oas session <action>` command routing refactored from flat commands
// to AWS/GCP-style `oas session list` pattern.
//
// Routing logic (bin/oas handleSessionListSubcommand):
//   --last/--since/--until present  → handleSessionsCommand (time-range)
//   otherwise                        → handleListNewCommand (filter-based)
//   bare `oas session`               → defaults to `oas session list`
// ============================================================================

// ============================================================================
// Zone 3: Multi-flag interaction — HIGHEST PRIORITY
// ============================================================================

describe.skipIf(CI)("session list routing: Zone 3 multi-flag interaction", () => {
  test("session list --last 4h --agent opencode routes to time-range handler", async () => {
    //#given: --last time flag AND --agent filter flag together
    const result = await runCLI(["session", "list", "--last", "4h", "--agent", "opencode"]);
    //#when: both flags are present
    //#then: time flag takes priority (routes to handleSessionsCommand), no crash
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Unknown");
  });

  test("session list --since 2026-01-01 --until 2026-03-01 --format json routes to time-range with json", async () => {
    //#given: dual time flags + format flag
    const result = await runCLI([
      "session", "list",
      "--since", "2026-01-01T00:00:00Z",
      "--until", "2026-03-01T00:00:00Z",
      "--format", "json",
    ]);
    //#when: both --since and --until present alongside --format
    //#then: routes to time-range handler, outputs valid JSON
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("session list --full --show-alias --limit 5 routes to filter handler with output flags", async () => {
    //#given: output flags (--full, --show-alias) + limit, NO time flags
    const result = await runCLI(["session", "list", "--full", "--show-alias", "--limit", "5"]);
    //#when: no time flags present, multiple output flags combined
    //#then: routes to handleListNewCommand, shows alias column, respects limit
    expect(result.exitCode).toBe(0);
    // --show-alias should reveal :default] in output
    expect(result.stdout).toContain(":default]");
  });
});

// ============================================================================
// Zone 1: Empty / bare inputs
// ============================================================================

describe.skipIf(CI)("session list routing: Zone 1 empty/bare", () => {
  test("bare `oas session` defaults to list — not 'Unknown command'", async () => {
    //#given: bare `oas session` with no subcommand
    const result = await runCLI(["session"]);
    //#when: no subcommand provided
    //#then: defaults to list, does NOT say "Unknown command"
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Unknown command");
  });

  test("session list with no flags exits 0", async () => {
    //#given: `oas session list` with zero flags
    const result = await runCLI(["session", "list"]);
    //#when: explicit list subcommand, no flags
    //#then: routes to handleListNewCommand, exits cleanly
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Unknown command");
  });
});

// ============================================================================
// Zone 4: Error propagation
// ============================================================================

describe.skipIf(CI)("session list routing: Zone 4 error propagation", () => {
  test("session list --format garbage rejected when routed to time-range handler", async () => {
    //#given: --format garbage WITH a time flag (routes to handleSessionsCommand)
    const result = await runCLI(["session", "list", "--last", "4h", "--format", "garbage"]);
    //#when: invalid format value
    //#then: exits non-zero with error message
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --format");
  });

  test("session list --format garbage rejected when routed to filter handler", async () => {
    //#given: --format garbage WITHOUT time flags (routes to handleListNewCommand)
    const result = await runCLI(["session", "list", "--format", "garbage"]);
    //#when: invalid format value on filter path
    //#then: exits non-zero or shows error
    const hasError = result.exitCode !== 0 || result.stdout.toLowerCase().includes("error") || result.stderr.toLowerCase().includes("error");
    expect(hasError).toBe(true);
  });

  test("session list --limit abc rejected when routed to time-range handler", async () => {
    //#given: --limit abc WITH a time flag (routes to handleSessionsCommand)
    const result = await runCLI(["session", "list", "--last", "4h", "--limit", "abc"]);
    //#when: non-numeric limit value
    //#then: exits non-zero with error message
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--limit must be a non-negative integer");
  });

  test("session list --limit abc on filter path exits 1 (validated before routing)", async () => {
    //#given: --limit abc WITHOUT time flags (routes to handleListNewCommand)
    const result = await runCLI(["session", "list", "--limit", "abc"]);
    //#when: non-numeric limit value on filter path
    //#then: --limit is validated in handleSessionListSubcommand before routing
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--limit must be a non-negative integer");
  });
});

// ============================================================================
// Happy path (last — per worst-first-testing priority)
// ============================================================================

describe.skipIf(CI)("session list routing: happy path", () => {
  test("session list --last 4h routes to time-range handler", async () => {
    //#given: --last 4h time flag
    const result = await runCLI(["session", "list", "--last", "4h"]);
    //#when: time flag triggers handleSessionsCommand
    //#then: exits 0, no "Unknown" errors
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Unknown");
  });

  test("session list --agent opencode routes to filter handler", async () => {
    //#given: --agent opencode filter flag, no time flags
    const result = await runCLI(["session", "list", "--agent", "opencode"]);
    //#when: filter flag triggers handleListNewCommand
    //#then: exits 0, no "Unknown" errors
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Unknown");
  });

  test("session list --format json --limit 3 routes to filter handler, returns valid JSON", async () => {
    //#given: --format json + --limit 3, no time flags
    const result = await runCLI(["session", "list", "--format", "json", "--limit", "3"]);
    //#when: filter handler with JSON format
    //#then: exits 0, returns valid JSON array
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    if (parsed.length > 0) {
      expect(parsed[0]).toHaveProperty("id");
      expect(parsed[0]).toHaveProperty("agent");
    }
  });
});
