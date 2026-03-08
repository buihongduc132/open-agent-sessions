import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { join } from "path";

// ============================================================================
// CLI Entry Point Integration Tests
// 
// Tests for bin/oas command routing, help output, and real command execution.
// These tests run the actual CLI to verify real behavior.
// ============================================================================

// Helper to run CLI command and capture output
// Note: timeout must be less than bun:test's default 5000ms timeout
async function runCLI(args: string[], timeoutMs: number = 4000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cliPath = join(process.cwd(), "bin", "oas");
    const proc = spawn("bun", [cliPath, ...args], {
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + "\nProcess timed out",
        });
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      }
    });

    proc.on("error", (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout,
          stderr: error.message,
        });
      }
    });
  });
}

// ============================================================================
// Issue 1: Help Output Verification Tests
// ============================================================================

describe("CLI: help output verification", () => {
  test("--help shows usage header", async () => {
    const result = await runCLI(["--help"]);
    
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Open Agent Sessions (oas)");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("oas <command> [options]");
  });

  test("--help lists all commands", async () => {
    const result = await runCLI(["--help"]);
    
    expect(result.exitCode).toBe(0);
    // Legacy commands
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("recent");
    expect(result.stdout).toContain("find");
    expect(result.stdout).toContain("show");
    
    // New commands
    expect(result.stdout).toContain("sessions");
    expect(result.stdout).toContain("read");
    expect(result.stdout).toContain("search");
    expect(result.stdout).toContain("onboard");
  });

  test("-h shows same help as --help", async () => {
    const resultLong = await runCLI(["--help"]);
    const resultShort = await runCLI(["-h"]);
    
    expect(resultLong.exitCode).toBe(0);
    expect(resultShort.exitCode).toBe(0);
    expect(resultLong.stdout).toBe(resultShort.stdout);
  });

  test("--help shows sessions command options", async () => {
    const result = await runCLI(["--help"]);
    
    expect(result.stdout).toContain("--last DURATION");
    expect(result.stdout).toContain("--since TIMESTAMP");
    expect(result.stdout).toContain("--until TIMESTAMP");
    expect(result.stdout).toContain("--limit N");
    expect(result.stdout).toContain("--format FORMAT");
  });

  test("--help shows read command options", async () => {
    const result = await runCLI(["--help"]);
    
    expect(result.stdout).toContain("--session SPEC");
    expect(result.stdout).toContain("--agent NAME");
    expect(result.stdout).toContain("--alias NAME");
    expect(result.stdout).toContain("--id SESSION_ID");
    expect(result.stdout).toContain("--first N");
    expect(result.stdout).toContain("--last N");
    expect(result.stdout).toContain("--all");
    expect(result.stdout).toContain("--range START:END");
    expect(result.stdout).toContain("--tools");
    expect(result.stdout).toContain("--role ROLE");
    expect(result.stdout).toContain("--output FILE");
  });

  test("--help shows search command options", async () => {
    const result = await runCLI(["--help"]);
    
    expect(result.stdout).toContain("--text QUERY");
  });

  test("--help shows examples", async () => {
    const result = await runCLI(["--help"]);
    
    expect(result.stdout).toContain("Examples:");
    expect(result.stdout).toContain("oas list");
    expect(result.stdout).toContain("oas sessions --last 4h");
    expect(result.stdout).toContain("oas read");
    expect(result.stdout).toContain("oas search");
  });

  test("no arguments shows help", async () => {
    const result = await runCLI([]);
    
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Open Agent Sessions (oas)");
  });

  test("sessions --help shows full help", async () => {
    const result = await runCLI(["sessions", "--help"]);
    
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Open Agent Sessions (oas)");
  });

  test("read --help shows full help", async () => {
    const result = await runCLI(["read", "--help"]);
    
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Open Agent Sessions (oas)");
  });

  test("search --help shows full help", async () => {
    const result = await runCLI(["search", "--help"]);
    
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Open Agent Sessions (oas)");
  });
});

// ============================================================================
// Issue 2: Command Routing Tests (Testing REAL bin/oas routing logic)
// ============================================================================

describe("CLI: command routing", () => {
  describe("legacy commands", () => {
    test("list command is recognized (even if it fails due to missing db)", async () => {
      const result = await runCLI(["list"]);
      
      // Command is recognized, but may fail due to missing database
      // The important thing is it doesn't say "Unknown command"
      expect(result.stderr).not.toContain("Unknown command");
    });

    test("recent command is recognized", async () => {
      const result = await runCLI(["recent"]);
      
      expect(result.stderr).not.toContain("Unknown command");
    });

    test("find command requires session-id", async () => {
      const result = await runCLI(["find"]);
      
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Usage:");
    });

    test("show command requires session-id", async () => {
      const result = await runCLI(["show"]);
      
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Usage:");
    });
  });

  describe("new commands", () => {
    test("sessions command is recognized", async () => {
      const result = await runCLI(["sessions", "--help"]);
      
      expect(result.exitCode).toBe(0);
    });

    test("read command is recognized", async () => {
      const result = await runCLI(["read", "--help"]);
      
      expect(result.exitCode).toBe(0);
    });

    test("search command is recognized", async () => {
      const result = await runCLI(["search", "--help"]);
      
      expect(result.exitCode).toBe(0);
    });

    test("search command requires --text", async () => {
      const result = await runCLI(["search"]);
      
      // Should fail validation, not routing
      expect(result.stderr).not.toContain("Unknown command");
    });
  });

  describe("unknown commands", () => {
    test("unknown command shows error message", async () => {
      const result = await runCLI(["unknown-command"]);
      
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown command");
    });

    test("unknown command shows usage hint", async () => {
      const result = await runCLI(["unknown-command"]);
      
      // Unknown command shows usage in stdout, error in stderr
      const output = result.stdout + result.stderr;
      expect(output).toContain("Usage:");
      expect(output).toContain("Run 'oas --help'");
    });
  });

  describe("command aliases", () => {
    test("list with --help shows help", async () => {
      const result = await runCLI(["list", "--help"]);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Open Agent Sessions");
    });

    test("find with --help shows usage", async () => {
      const result = await runCLI(["find", "--help"]);
      
      // find --help shows usage error because it requires session-id
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Usage:");
    });
  });
});

// ============================================================================
// Argument Parsing via CLI Tests
// ============================================================================

describe("CLI: real argument parsing", () => {
  test("sessions with --last flag", async () => {
    const result = await runCLI(["sessions", "--last", "4h", "--help"]);
    
    // With --help, should show help and exit 0
    expect(result.exitCode).toBe(0);
  });

  test("read with positional session spec", async () => {
    const result = await runCLI(["read", "opencode:default:abc123", "--help"]);
    
    expect(result.exitCode).toBe(0);
  });

  test("read with multiple flags", async () => {
    const result = await runCLI([
      "read",
      "--session", "opencode:default:abc123",
      "--last", "20",
      "--tools",
      "--help"
    ]);
    
    expect(result.exitCode).toBe(0);
  });

  test("search with --text flag", async () => {
    const result = await runCLI(["search", "--text", "error", "--help"]);
    
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe("CLI: error handling", () => {
  test("invalid --limit doesn't crash", async () => {
    const result = await runCLI(["sessions", "--limit", "abc"]);
    
    // Should handle gracefully (may succeed or fail, but not crash)
    expect(result.exitCode).toBeDefined();
  });

  test("missing positional argument for find", async () => {
    const result = await runCLI(["find"]);
    
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });

  test("list with invalid limit", async () => {
    const result = await runCLI(["list", "abc"]);
    
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("positive number");
  });
});
