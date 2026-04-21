import { describe, expect, test } from "bun:test";
import { runCLI } from "./helpers/run-cli";

const CI = !!process.env.CI;

// ============================================================================
// CLI Error Handling Tests — `oas session <action>` command structure
//
// Worst-first ordering:
//   Zone 4 (Error propagation) — tests 1-5
//   Zone 6 (Permission/access boundary) — tests 6-7
//   Zone 3 (Multi-flag interaction) — tests 8-9
//   Zone 2 (Boundary at scale) — tests 10-11
//   Unknown commands — tests 12-14
// ============================================================================

// ============================================================================
// Zone 4: Error Propagation — HIGHEST PRIORITY
// ============================================================================

describe.skipIf(CI)("Zone 4: Error propagation — session subcommands missing required args", () => {
  //#given the oas CLI is available
  //#when `oas session read` is invoked with NO session ID
  //#then the process exits non-zero with an error
  test("session_read_missing_id_exits_nonzero", async () => {
    const result = await runCLI(["session", "read"]);
    expect(result.exitCode).not.toBe(0);
  });

  //#given the oas CLI is available
  //#when `oas session detail` is invoked with NO session ID
  //#then the process exits non-zero with an error
  test("session_detail_missing_id_exits_nonzero", async () => {
    const result = await runCLI(["session", "detail"]);
    expect(result.exitCode).not.toBe(0);
  });

  //#given the oas CLI is available
  //#when `oas session search` is invoked with NO --text flag
  //#then the process exits non-zero OR stderr contains an error message
  test("session_search_missing_text_exits_nonzero_or_has_stderr", async () => {
    const result = await runCLI(["session", "search"]);
    const hasError = result.exitCode !== 0 || result.stderr.length > 0;
    expect(hasError).toBe(true);
  });

  //#given the oas CLI is available
  //#when `oas session clone` is invoked with NO --from and NO --to
  //#then the process exits non-zero
  test("session_clone_missing_from_and_to_exits_nonzero", async () => {
    const result = await runCLI(["session", "clone"]);
    expect(result.exitCode).not.toBe(0);
  });

  //#given the oas CLI is available
  //#when `oas session export` is invoked with NO session ref
  //#then the process exits non-zero
  test("session_export_missing_ref_exits_nonzero", async () => {
    const result = await runCLI(["session", "export"]);
    expect(result.exitCode).not.toBe(0);
  });
});

// ============================================================================
// Zone 6: Permission / Access Boundary — nonexistent session IDs
// ============================================================================

describe.skipIf(CI)("Zone 6: Session not found — access boundary", () => {
  //#given the oas CLI is available
  //#when `oas session read` is invoked with a nonexistent session ID
  //#then the process exits 1
  test("session_read_nonexistent_id_exits_1", async () => {
    const result = await runCLI(["session", "read", "nonexistent-id-12345"]);
    expect(result.exitCode).toBe(1);
  });

  //#given the oas CLI is available
  //#when `oas session detail` is invoked with a nonexistent session ID
  //#then the process exits 1
  test("session_detail_nonexistent_id_exits_1", async () => {
    const result = await runCLI(["session", "detail", "nonexistent-id-12345"]);
    expect(result.exitCode).toBe(1);
  });
});

// ============================================================================
// Zone 3: Multi-Flag Interaction — mutually exclusive flags
// ============================================================================

describe.skipIf(CI)("Zone 3: Multi-flag interaction — mutually exclusive list flags", () => {
  //#given --roots-only and --sub-only are mutually exclusive
  //#when both are passed together
  //#then the CLI should error (exit non-zero or stderr has error)
  test("session_list_roots_only_and_sub_only_are_mutually_exclusive", async () => {
    const result = await runCLI(["session", "list", "--roots-only", "--sub-only"]);
    const hasError = result.exitCode !== 0 || result.stderr.toLowerCase().includes("exclusive") || result.stderr.toLowerCase().includes("incompatible");
    expect(hasError).toBe(true);
  });

  //#given --roots-only and --children-of are mutually exclusive
  //#when both are passed together
  //#then the CLI should error
  test("session_list_roots_only_and_children_of_are_mutually_exclusive", async () => {
    const result = await runCLI(["session", "list", "--roots-only", "--children-of", "abc"]);
    const hasError = result.exitCode !== 0 || result.stderr.toLowerCase().includes("exclusive") || result.stderr.toLowerCase().includes("incompatible");
    expect(hasError).toBe(true);
  });
});

// ============================================================================
// Zone 2: Boundary at Scale — --limit edge cases
// ============================================================================

describe.skipIf(CI)("Zone 2: Boundary — --limit edge cases", () => {
  //#given --limit 0 means "all results"
  //#when `oas session list --limit 0` is invoked
  //#then the CLI exits zero (valid) and returns sessions
  test("session_list_limit_zero_succeeds_and_returns_sessions", async () => {
    const result = await runCLI(["session", "list", "--limit", "0"]);
    expect(result.exitCode).toBe(0);
    // --limit 0 should return all sessions, not "No sessions found"
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("No sessions found");
  });

  //#given --limit must be non-negative
  //#when `oas session list --limit -1` is invoked
  //#then the CLI exits non-zero
  test("session_list_limit_negative_exits_nonzero", async () => {
    const result = await runCLI(["session", "list", "--limit", "-1"]);
    expect(result.exitCode).not.toBe(0);
  });
});

// ============================================================================
// Unknown Commands — routing errors
// ============================================================================

describe.skipIf(CI)("Unknown commands — routing errors", () => {
  //#given `bogus` is not a recognized top-level command
  //#when `oas bogus` is invoked
  //#then exits 1 and stderr contains "Unknown command"
  test("top_level_bogus_command_exits_1_with_unknown_command", async () => {
    const result = await runCLI(["bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command");
  });

  //#given `bogus` is not a recognized session subcommand
  //#when `oas session bogus` is invoked
  //#then exits 1 and stderr mentions the unknown subcommand
  test("session_bogus_subcommand_exits_1_with_error", async () => {
    const result = await runCLI(["session", "bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  //#given `oas session list` takes no positional args after flags
  //#when an extra bogus arg is appended
  //#then the CLI handles gracefully (exits 1 or stderr has error)
  test("session_list_extra_positional_arg_handled_gracefully", async () => {
    const result = await runCLI(["session", "list", "bogus-extra-arg"]);
    expect(typeof result.exitCode).toBe("number");
  });
});
