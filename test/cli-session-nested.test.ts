import { describe, expect, test } from "bun:test";
import { runCLI } from "./helpers/run-cli";

const CI = !!process.env.CI;

// ============================================================================
// CLI Nested `oas session <action>` — Integration Tests
//
// Tests the handleSessionCommand() routing in bin/oas.
// Covers: read, detail, export, clone, search, similar subcommands.
// ============================================================================

// ============================================================================
// Zone 4: Error Propagation — HIGHEST PRIORITY
//
// These test that missing required args exit non-zero and do NOT produce
// "Unknown command" — meaning the routing works, validation fails.
// ============================================================================

describe("CLI: oas session — error propagation (Zone 4)", () => {
  test("session read with no args exits non-zero, NOT 'Unknown command'", async () => {
    const result = await runCLI(["session", "read"]);

    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("Unknown command");
  });

  test("session search with no --text exits non-zero, NOT 'Unknown command'", async () => {
    const result = await runCLI(["session", "search"]);

    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("Unknown command");
  });

  test("session detail with no id exits non-zero, NOT 'Unknown command'", async () => {
    const result = await runCLI(["session", "detail"]);

    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("Unknown command");
  });

  test("session clone with no --from/--to exits non-zero, NOT 'Unknown command'", async () => {
    const result = await runCLI(["session", "clone"]);

    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("Unknown command");
  });
});

// ============================================================================
// Zone 1: Empty / Bare Inputs
//
// Bare `oas session` should default to list (exit 0).
// `oas session --help` should show help (exit 0).
// ============================================================================

describe.skipIf(CI)("CLI: oas session — empty/bare (Zone 1)", () => {
  test("bare 'session' defaults to list, exits 0", async () => {
    const result = await runCLI(["session"]);

    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("Unknown command");
  });

  test("session --help shows help, exits 0", async () => {
    const result = await runCLI(["session", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Open Agent Sessions");
  });
});

// ============================================================================
// Happy Path: --help on every subcommand
//
// Each `oas session <action> --help` should exit 0 and NOT produce
// "Unknown command" — proving routing reaches the correct handler.
// ============================================================================

describe("CLI: oas session subcommand --help (happy path)", () => {
  test("session read --help exits 0, NOT 'Unknown command'", async () => {
    const result = await runCLI(["session", "read", "--help"]);

    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("Unknown command");
  });

  test("session detail --help exits 0, NOT 'Unknown command'", async () => {
    const result = await runCLI(["session", "detail", "--help"]);

    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("Unknown command");
  });

  test("session search --help exits 0, NOT 'Unknown command'", async () => {
    const result = await runCLI(["session", "search", "--help"]);

    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("Unknown command");
  });

  test("session export --help exits 0, NOT 'Unknown command'", async () => {
    const result = await runCLI(["session", "export", "--help"]);

    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("Unknown command");
  });

  test("session clone --help exits 0, NOT 'Unknown command'", async () => {
    const result = await runCLI(["session", "clone", "--help"]);

    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("Unknown command");
  });

  test("session similar --help exits 0, NOT 'Unknown command'", async () => {
    const result = await runCLI(["session", "similar", "--help"]);

    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("Unknown command");
  });
});

// ============================================================================
// Zone 6: Unknown Subcommand
//
// `oas session bogus` should exit 1 and contain an error message.
// ============================================================================

describe("CLI: oas session — unknown subcommand (Zone 6)", () => {
  test("session bogus exits 1, contains error", async () => {
    const result = await runCLI(["session", "bogus"]);

    expect(result.exitCode).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/Unknown|unknown|error/i);
  });
});
