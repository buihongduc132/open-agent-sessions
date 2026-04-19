/**
 * test/cli-gap10-list-format.test.ts
 *
 * RED tests for GAP 10a — `oas list --format json|text`.
 *
 * Gap requirement (_16apr_gaps.md):
 *   "oas list --format json — route to formatSessionsJson().
 *    oas list --format text — unchanged.
 *    Invalid --format value — same error behavior as sessions."
 *
 * Current state:
 *   - `list` command produces text-only output. No --format flag exists.
 *   - formatSessionsJson() already exists in src/cli/formatters/json.ts
 *   - Only CLI wiring is missing.
 *
 * After fix:
 *   - `oas list --format json` → stdout is valid JSON array (SessionSummary[])
 *   - `oas list --format text` → unchanged text output
 *   - `oas list` (no --format) → behaves like --format text (backwards compat)
 *   - `oas list --format invalid` → error returned
 *
 * These tests should FAIL until the --format flag is wired for `list`.
 * DO NOT modify source files.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { join } from "path";

const CI = !!process.env.CI;

// ============================================================================
// CLI helper
// ============================================================================

async function runCLI(args: string[], timeoutMs = 4000): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const cliPath = join(process.cwd(), "bin", "oas");
    const proc = spawn("bun", [cliPath, ...args], { cwd: process.cwd() });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve({ exitCode: 1, stdout, stderr: stderr + "\n[timeout]" });
      }
    }, timeoutMs);

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      }
    });
    proc.on("error", (e) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ exitCode: 1, stdout, stderr: e.message });
      }
    });
  });
}

// ============================================================================
// GAP 10a — `list --format json|text`
// ============================================================================

describe.skipIf(CI)("GAP 10a: `oas list --format json|text`", () => {
  test("`oas list --format json` exits 0", async () => {
    const result = await runCLI(["list", "--format", "json", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas list --format json` returns valid JSON array (SessionSummary[])", async () => {
    const result = await runCLI(["list", "--format", "json", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    // Must be parseable as JSON
    let parsed: unknown;
    expect(() => { parsed = JSON.parse(result.stdout); }).not.toThrow();
    // Must be an array
    expect(Array.isArray(parsed)).toBe(true);
    const arr = parsed as Record<string, unknown>[];
    if (arr.length === 0) return;
    // Each element must be a SessionSummary object
    const first = arr[0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("agent");
    expect(first).toHaveProperty("alias");
    expect(first).toHaveProperty("title");
    expect(first).toHaveProperty("created_at");
    expect(first).toHaveProperty("updated_at");
    expect(first).toHaveProperty("message_count");
  });

  test("`oas list --format json` has no console.error noise", async () => {
    const result = await runCLI(["list", "--format", "json", "--limit", "3"]);
    expect(result.exitCode).toBe(0);
    // stderr must not contain error messages
    expect(result.stderr).not.toContain("Error");
    expect(result.stderr).not.toContain("error:");
  });

  test("`oas list --format text` returns non-JSON text output", async () => {
    const result = await runCLI(["list", "--format", "text", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    // text output is NOT valid JSON (formatSessionRow produces [agent:alias] prefix)
    expect(() => JSON.parse(result.stdout)).toThrow();
  });

  test("`oas list` (no --format) behaves like --format text (backwards compat)", async () => {
    const resultDefault = await runCLI(["list", "--limit", "5"]);
    const resultExplicit = await runCLI(["list", "--format", "text", "--limit", "5"]);
    expect(resultDefault.exitCode).toBe(0);
    expect(resultExplicit.exitCode).toBe(0);
    // Both should produce the same text format
    expect(resultDefault.stdout).toBe(resultExplicit.stdout);
  });

  test("`oas list --format invalid` returns an error", async () => {
    const result = await runCLI(["list", "--format", "invalid_format", "--limit", "5"]);
    // Must either exit non-zero OR return an error message in output
    const hasError = result.exitCode !== 0 || result.stdout.toLowerCase().includes("error");
    expect(hasError).toBe(true);
  });

  test("`oas list --format xml` returns an error (invalid format)", async () => {
    const result = await runCLI(["list", "--format", "xml", "--limit", "5"]);
    const hasError = result.exitCode !== 0 || result.stdout.toLowerCase().includes("error");
    expect(hasError).toBe(true);
  });
});
