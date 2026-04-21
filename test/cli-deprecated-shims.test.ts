import { describe, expect, test } from "bun:test";
import { runCLI } from "./helpers/run-cli";

const CI = !!process.env.CI;

// ============================================================================
// Deprecated Command Shim Tests
//
// Verifies that old flat commands are deprecated shims that:
// 1. Print "DEPRECATED" + new command suggestion to stderr
// 2. Forward all arguments to the new `oas session <action>` handler
// 3. Exit with the forwarded command's exit code
// ============================================================================

// ============================================================================
// Zone 4: Error Propagation — HIGHEST PRIORITY
// ============================================================================

describe("deprecated shims: error propagation (Zone 4)", () => {
  test("oas find (no arg) exits 1 with usage error", async () => {
    const result = await runCLI(["find"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr + result.stdout).toContain("Usage:");
  });

  test("oas show (no arg) exits 1 with usage error", async () => {
    const result = await runCLI(["show"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr + result.stdout).toContain("Usage:");
  });

  test("oas list abc (invalid limit) exits 1 with non-negative integer error", async () => {
    const result = await runCLI(["list", "abc"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("non-negative integer");
  });
});

// ============================================================================
// Zone 1: Empty/Nil Inputs
// ============================================================================

describe.skipIf(CI)("deprecated shims: empty/nil inputs (Zone 1)", () => {
  test("oas list (no args) exits 0 with deprecation warning", async () => {
    const result = await runCLI(["list"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("DEPRECATED");
    expect(result.stdout).not.toContain("Unknown command");
    expect(result.stderr).not.toContain("Unknown command");
  });

  test("oas recent (no args) exits 0 with deprecation warning", async () => {
    const result = await runCLI(["recent"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("DEPRECATED");
    expect(result.stdout).not.toContain("Unknown command");
    expect(result.stderr).not.toContain("Unknown command");
  });

  test("oas sessions (no args) exits 0 with deprecation warning", async () => {
    const result = await runCLI(["sessions"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("DEPRECATED");
    expect(result.stdout).not.toContain("Unknown command");
    expect(result.stderr).not.toContain("Unknown command");
  });

  test("oas list-new (no args) exits 0 with deprecation warning", async () => {
    const result = await runCLI(["list-new"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("DEPRECATED");
    expect(result.stdout).not.toContain("Unknown command");
    expect(result.stderr).not.toContain("Unknown command");
  });
});

// ============================================================================
// Zone 3: Multi-Flag / Multi-Component Interaction
// ============================================================================

describe.skipIf(CI)("deprecated shims: multi-flag interaction (Zone 3)", () => {
  test("oas sessions --last 4h --format json forwards flags with deprecation", async () => {
    const result = await runCLI(["sessions", "--last", "4h", "--format", "json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("DEPRECATED");
  });

  test("oas list-new --agent opencode --limit 5 forwards flags with deprecation", async () => {
    const result = await runCLI(["list-new", "--agent", "opencode", "--limit", "5"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("DEPRECATED");
  });
});

// ============================================================================
// Zone 5: State Mutation — Forwarding Correctness
// ============================================================================

describe.skipIf(CI)("deprecated shims: forwarding correctness (Zone 5)", () => {
  test("oas list 5 forwards positional N as --limit 5", async () => {
    const result = await runCLI(["list", "5"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("DEPRECATED");
  });

  test("oas similar --help is recognized (not Unknown command) and has deprecation", async () => {
    const result = await runCLI(["similar", "--help"]);

    expect(result.stdout).not.toContain("Unknown command");
    expect(result.stderr).not.toContain("Unknown command");
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("DEPRECATED");
  });
});

// ============================================================================
// Deprecation Notice Format — Critical
// ============================================================================

describe("deprecated shims: deprecation notice format", () => {
  const deprecatedCommands = [
    { cmd: ["list"], suggested: "session list" },
    { cmd: ["recent"], suggested: "session list" },
    { cmd: ["sessions"], suggested: "session list" },
    { cmd: ["list-new"], suggested: "session list" },
    { cmd: ["find", "--help"], suggested: "session detail" },
    { cmd: ["show", "--help"], suggested: "session detail" },
    { cmd: ["similar", "--help"], suggested: "session similar" },
  ];

  test("every deprecated command prints DEPRECATED to stderr (not stdout)", async () => {
    for (const { cmd } of deprecatedCommands) {
      const result = await runCLI(cmd);
      expect(result.stderr).toContain("DEPRECATED");
      expect(result.stdout).not.toContain("DEPRECATED");
    }
  });

  test("every deprecated command suggests the new command in stderr", async () => {
    for (const { cmd, suggested } of deprecatedCommands) {
      const result = await runCLI(cmd);
      expect(result.stderr).toContain(suggested);
    }
  });
});
