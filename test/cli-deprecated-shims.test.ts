import { describe, expect, test } from "bun:test";
import { runCLI } from "./helpers/run-cli";

const CI = !!process.env.CI;

// ============================================================================
// Deprecated Command Shim Tests
//
// BUG-10 policy: only genuine legacy aliases (recent, show, and the top-level
// tree/children spellings) print "DEPRECATED" + the new command to stderr.
// First-class documented commands (list, sessions, list-new, find, detail,
// read, search, clone, export, similar) forward SILENTLY to the same handlers.
//
// All shims still forward all arguments to the `oas session <action>` handler
// and exit with the forwarded command's exit code.
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
  // NOTE: unfiltered `oas list` performs a full cross-agent scan (>60s on this
  // machine, pre-existing at HEAD) — filtered variants are used instead.
  test("oas list (filtered) exits 0 and is SILENT (first-class, BUG-10)", async () => {
    const result = await runCLI(["list", "1", "--agent", "codex"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("DEPRECATED");
    expect(result.stdout).not.toContain("Unknown command");
    expect(result.stderr).not.toContain("Unknown command");
  });

  test("oas recent (filtered) exits 0 with deprecation warning", async () => {
    const result = await runCLI(["recent", "1", "--agent", "codex"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("DEPRECATED");
    expect(result.stdout).not.toContain("Unknown command");
    expect(result.stderr).not.toContain("Unknown command");
  });

  test("oas sessions (filtered) exits 0 and is SILENT (first-class, BUG-10)", async () => {
    // NOTE: unscoped time-range queries scan ALL adapters (pi alone takes
    // 30s+, pre-existing at HEAD) — always scope by --agent here.
    const result = await runCLI(["sessions", "--last", "4h", "--agent", "codex", "--limit", "1"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("DEPRECATED");
    expect(result.stdout).not.toContain("Unknown command");
    expect(result.stderr).not.toContain("Unknown command");
  });

  test("oas list-new (filtered) exits 0 and is SILENT (first-class, BUG-10)", async () => {
    const result = await runCLI(["list-new", "--agent", "codex", "--limit", "1"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("DEPRECATED");
    expect(result.stdout).not.toContain("Unknown command");
    expect(result.stderr).not.toContain("Unknown command");
  });
});

// ============================================================================
// Zone 3: Multi-Flag / Multi-Component Interaction
// ============================================================================

describe.skipIf(CI)("deprecated shims: multi-flag interaction (Zone 3)", () => {
  test("oas sessions --last 4h --format json forwards flags silently (first-class)", async () => {
    const result = await runCLI(["sessions", "--last", "4h", "--format", "json", "--agent", "codex", "--limit", "1"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("DEPRECATED");
  });

  test("oas list-new --agent opencode --limit 5 forwards flags silently (first-class)", async () => {
    const result = await runCLI(["list-new", "--agent", "opencode", "--limit", "5"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("DEPRECATED");
  });
});

// ============================================================================
// Zone 5: State Mutation — Forwarding Correctness
// ============================================================================

describe.skipIf(CI)("deprecated shims: forwarding correctness (Zone 5)", () => {
  test("oas list 5 forwards positional N as --limit 5 silently (first-class)", async () => {
    const result = await runCLI(["list", "5", "--agent", "codex"], 8000);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("DEPRECATED");
  });

  test("oas similar --help is recognized (not Unknown command) and is silent (first-class)", async () => {
    const result = await runCLI(["similar", "--help"]);

    expect(result.stdout).not.toContain("Unknown command");
    expect(result.stderr).not.toContain("Unknown command");
    expect(result.stderr).not.toContain("DEPRECATED");
  });
});

// ============================================================================
// Deprecation Notice Format — Critical
// ============================================================================

describe("deprecated shims: deprecation notice format", () => {
  const legacyAliases = [
    { cmd: ["recent", "--help"], suggested: "session list" },
    { cmd: ["show", "abc"], suggested: "session detail" },
    { cmd: ["tree", "--help"], suggested: "session tree" },
    { cmd: ["children", "--help"], suggested: "session children" },
  ];

  test("every legacy alias prints DEPRECATED to stderr (not stdout)", async () => {
    for (const { cmd } of legacyAliases) {
      // `show` probes every enabled adapter for the bare id (BUG-10 owner
      // resolution, 2-3.5s standalone) — needs more than the default 4s
      // under full-suite parallel load.
      const result = await runCLI(cmd, 15000);
      expect(result.stderr).toContain("DEPRECATED");
      expect(result.stderr).not.toContain("[timeout]");
      expect(result.stdout).not.toContain("DEPRECATED");
    }
  });

  test("every legacy alias suggests the new command in stderr", async () => {
    for (const { cmd, suggested } of legacyAliases) {
      const result = await runCLI(cmd, 15000);
      expect(result.stderr).toContain(suggested);
      expect(result.stderr).not.toContain("[timeout]");
    }
  });

  test("first-class commands never print DEPRECATED (BUG-10)", async () => {
    for (const cmd of [
      ["list", "--help"],
      ["sessions", "--help"],
      ["list-new", "--help"],
      ["find", "--help"],
      ["detail", "--help"],
      ["read", "--help"],
      ["search", "--help"],
      ["similar", "--help"],
    ]) {
      const result = await runCLI(cmd);
      expect(result.stderr).not.toContain("DEPRECATED");
      expect(result.stdout).not.toContain("DEPRECATED");
    }
  });
});
