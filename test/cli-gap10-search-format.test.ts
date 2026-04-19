/**
 * test/cli-gap10-search-format.test.ts
 *
 * RED tests for GAP 10b — `oas search --format json|text`.
 *
 * Gap requirement (_16apr_gaps.md):
 *   "oas search --format json — route to formatSessionsJson().
 *    oas search --format text — unchanged.
 *    Invalid --format value — same error behavior as sessions."
 *
 * Current state:
 *   - `search` command produces text-only output. No --format flag exists.
 *   - formatSessionsJson() already exists in src/cli/formatters/json.ts
 *   - Only CLI wiring is missing.
 *
 * After fix:
 *   - `oas search --text foo --format json` → stdout is valid JSON array
 *   - `oas search --text foo --format text` → unchanged text output
 *   - `oas search --text foo` (no --format) → behaves like --format text
 *   - `oas search --text foo --format invalid` → error returned
 *
 * These tests should FAIL until the --format flag is wired for `search`.
 * DO NOT modify source files.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { join } from "path";

// ============================================================================
// CLI helper
// ============================================================================

async function runCLI(args: string[], timeoutMs = 6000): Promise<{
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
// GAP 10b — `search --format json|text`
// ============================================================================

describe("GAP 10b: `oas search --format json|text`", () => {
  test("`oas search --text ast --format json` exits 0", async () => {
    const result = await runCLI(["search", "--text", "ast", "--format", "json", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas search --text ast --format json` returns valid JSON array (SessionSummary[])", async () => {
    const result = await runCLI(["search", "--text", "ast", "--format", "json", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    // Must be parseable as JSON
    let parsed: unknown;
    expect(() => { parsed = JSON.parse(result.stdout); }).not.toThrow();
    // Must be an array
    expect(Array.isArray(parsed)).toBe(true);
    const arr = parsed as Record<string, unknown>[];
    // Non-empty or empty result is OK — key is valid JSON format
    // Each element (if any) must be a SessionSummary object
    for (const item of arr) {
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("agent");
      expect(item).toHaveProperty("alias");
      expect(item).toHaveProperty("title");
      expect(item).toHaveProperty("created_at");
      expect(item).toHaveProperty("updated_at");
      expect(item).toHaveProperty("message_count");
    }
  });

  test("`oas search --text ast --format json` has no console.error noise", async () => {
    const result = await runCLI(["search", "--text", "ast", "--format", "json", "--limit", "3"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Error");
    expect(result.stderr).not.toContain("error:");
  });

  test("`oas search --text ast --format text` returns non-JSON text output", async () => {
    const result = await runCLI(["search", "--text", "ast", "--format", "text", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    // text output is NOT valid JSON (formatSessionRowSimple produces [agent:alias] prefix)
    expect(() => JSON.parse(result.stdout)).toThrow();
  });

  test("`oas search --text ast` (no --format) behaves like --format text (backwards compat)", async () => {
    const resultDefault = await runCLI(["search", "--text", "ast", "--limit", "5"]);
    const resultExplicit = await runCLI(["search", "--text", "ast", "--format", "text", "--limit", "5"]);
    expect(resultDefault.exitCode).toBe(0);
    expect(resultExplicit.exitCode).toBe(0);
    // Both should produce the same text format
    expect(resultDefault.stdout).toBe(resultExplicit.stdout);
  });

  test("`oas search --text ast --format invalid` returns an error", async () => {
    const result = await runCLI(["search", "--text", "ast", "--format", "garbage", "--limit", "5"]);
    const hasError = result.exitCode !== 0 || result.stdout.toLowerCase().includes("error");
    expect(hasError).toBe(true);
  });

  test("`oas search --text ast --format xml` returns an error (invalid format)", async () => {
    const result = await runCLI(["search", "--text", "ast", "--format", "xml", "--limit", "5"]);
    const hasError = result.exitCode !== 0 || result.stdout.toLowerCase().includes("error");
    expect(hasError).toBe(true);
  });
});
