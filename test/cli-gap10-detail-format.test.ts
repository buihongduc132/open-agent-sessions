/**
 * test/cli-gap10-detail-format.test.ts
 *
 * RED tests for GAP 10c — `oas detail --format json|text`.
 *
 * Gap requirement (_16apr_gaps.md):
 *   "oas detail --format json — route to formatSessionDetailJson().
 *    oas detail --format text — unchanged.
 *    Invalid --format value — same error behavior as sessions."
 *
 * Current state:
 *   - `detail` command produces text-only output. No --format flag exists.
 *   - formatSessionDetailJson() already exists in src/cli/formatters/json.ts
 *   - Only CLI wiring is missing.
 *
 * After fix:
 *   - `oas detail ses_xxx --format json` → stdout is valid JSON object
 *   - `oas detail ses_xxx --format text` → unchanged text output
 *   - `oas detail ses_xxx` (no --format) → behaves like --format text
 *   - `oas detail ses_xxx --format invalid` → error returned
 *
 * These tests should FAIL until the --format flag is wired for `detail`.
 * DO NOT modify source files.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { join } from "path";

const CI = !!process.env.CI;

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
// GAP 10c — `detail --format json|text`
// Discovery: get a real session ID from `oas sessions` to test detail command
// ============================================================================

describe.skipIf(CI)("GAP 10c: `oas detail --format json|text`", () => {
  // Discover a real session ID before running tests
  let realSessionId: string | null = null;

  async function discoverSession(): Promise<string | null> {
    // Fetch multiple sessions and pick the one with fewest messages.
    // Large sessions (100+ messages) can overflow the stdout pipe buffer
    // (~65536 bytes), producing truncated JSON that fails to parse.
    const result = await runCLI(["list", "--format", "json", "--limit", "20"], 8000);
    if (result.exitCode !== 0) return null;
    try {
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      // Pick session with the fewest messages to avoid pipe buffer truncation
      const sorted = [...parsed].sort((a: any, b: any) =>
        (a.message_count ?? 999) - (b.message_count ?? 999)
      );
      return sorted[0].id as string;
    } catch {}
    return null;
  }

  test("discover a real session ID for detail tests", async () => {
    const id = await discoverSession();
    realSessionId = id;
    // We expect at least one session to exist in the test environment
    // If this fails, the test environment may have no sessions
    expect(id).toBeTruthy();
  });

  test("`oas detail <id> --format json` exits 0", async () => {
    if (!realSessionId) return; // skip if no session found
    const result = await runCLI(["detail", realSessionId, "--format", "json"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas detail <id> --format json` returns valid JSON object (SessionDetail)", async () => {
    if (!realSessionId) return; // skip if no session found
    const result = await runCLI(["detail", realSessionId, "--format", "json"]);
    expect(result.exitCode).toBe(0);
    // Must be parseable as JSON
    let parsed: unknown;
    expect(() => { parsed = JSON.parse(result.stdout); }).not.toThrow();
    // Must be an object (not array) — SessionDetail is a single object
    expect(parsed).toBeTypeOf("object");
    expect(Array.isArray(parsed)).toBe(false);
    const obj = parsed as Record<string, unknown>;
    // Must have SessionDetail fields (nested under .session per formatMessagesJson)
    const session = obj.session as Record<string, unknown> | undefined;
    expect(session).toBeDefined();
    expect(session!).toHaveProperty("id");
    expect(session!).toHaveProperty("agent");
    expect(session!).toHaveProperty("alias");
    expect(session!).toHaveProperty("title");
    expect(session!).toHaveProperty("created_at");
    expect(session!).toHaveProperty("updated_at");
    // messages is the key field that distinguishes SessionDetail from SessionSummary
    expect(obj).toHaveProperty("messages");
  });

  test("`oas detail <id> --format json` has no console.error noise", async () => {
    if (!realSessionId) return; // skip if no session found
    const result = await runCLI(["detail", realSessionId, "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Error");
    expect(result.stderr).not.toContain("error:");
  });

  test("`oas detail <id> --format text` returns non-JSON text output", async () => {
    if (!realSessionId) return; // skip if no session found
    const result = await runCLI(["detail", realSessionId, "--format", "text"]);
    expect(result.exitCode).toBe(0);
    // text output is NOT valid JSON (formatDetail produces multi-line key:value lines)
    expect(() => JSON.parse(result.stdout)).toThrow();
  });

  test("`oas detail <id>` (no --format) behaves like --format text (backwards compat)", async () => {
    if (!realSessionId) return; // skip if no session found
    const resultDefault = await runCLI(["detail", realSessionId]);
    const resultExplicit = await runCLI(["detail", realSessionId, "--format", "text"]);
    expect(resultDefault.exitCode).toBe(0);
    expect(resultExplicit.exitCode).toBe(0);
    // Both should produce the same text format
    expect(resultDefault.stdout).toBe(resultExplicit.stdout);
  });

  test("`oas detail <id> --format invalid` returns an error", async () => {
    if (!realSessionId) return; // skip if no session found
    const result = await runCLI(["detail", realSessionId, "--format", "garbage"]);
    const hasError = result.exitCode !== 0 || result.stdout.toLowerCase().includes("error");
    expect(hasError).toBe(true);
  });

  test("`oas detail <id> --format csv` returns an error (invalid format)", async () => {
    if (!realSessionId) return; // skip if no session found
    const result = await runCLI(["detail", realSessionId, "--format", "csv"]);
    const hasError = result.exitCode !== 0 || result.stdout.toLowerCase().includes("error");
    expect(hasError).toBe(true);
  });
});
