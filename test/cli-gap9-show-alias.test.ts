/**
 * test/cli-gap9-show-alias.test.ts
 *
 * RED tests for GAP 9b — `--show-alias` flag.
 *
 * Gap requirement (_16apr_gaps.md):
 *   "Hide `default` alias by default. Show it only with `--show-alias`."
 *
 * Current behavior: Every row shows `[opencode:default]` — the `:default`
 * alias clutters every line with zero informational value.
 *
 * Flag composition from gap doc:
 *   | --full | --show-alias | Result                        |
 *   | ❌     | ❌           | Title truncated, default hidden |
 *   | ✅     | ❌           | Title full, default hidden      |
 *   | ❌     | ✅           | Title truncated, all aliases    |
 *   | ✅     | ✅           | Title full, all aliases shown   |
 *
 * After fix:
 *   - Default (no --show-alias): `[opencode:default]` must NOT appear
 *   - With --show-alias: `[opencode:default]` MUST appear
 *
 * These tests should FAIL until the --show-alias flag is wired through
 * the CLI entry point into the formatter.
 * DO NOT modify source files.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { join } from "path";

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
// GAP 9b — `--show-alias` flag: hide `:default` by default
// ============================================================================

describe("GAP 9b: `oas sessions` — hide `default` alias by default", () => {
  test("`oas sessions` (default) — `[opencode:default]` must NOT appear in output", async () => {
    const result = await runCLI(["sessions", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    // The :default alias provides zero value on every row. It must be hidden.
    expect(result.stdout).not.toContain("[opencode:default]");
    expect(result.stdout).not.toContain("[claude:default]");
    expect(result.stdout).not.toContain("[codex:default]");
  });

  test("`oas sessions --show-alias` — `[opencode:default]` MUST appear in output", async () => {
    const result = await runCLI(["sessions", "--show-alias", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    // With --show-alias, ALL aliases must be shown, including default
    expect(result.stdout).toContain("[opencode:");
    // Non-default aliases (if present) should also be visible
    // The default alias specifically must be shown when --show-alias is set
    const hasDefaultAlias = result.stdout.includes(":default]");
    expect(hasDefaultAlias).toBe(true);
  });

  test("`oas sessions --show-alias` — non-default aliases also shown", async () => {
    const result = await runCLI(["sessions", "--show-alias", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    // At minimum, opencode: should appear at least once
    expect(result.stdout).toContain("[opencode:");
  });

  test("`oas sessions --format json` — alias visibility irrelevant (JSON has no text labels)", async () => {
    const result = await runCLI(["sessions", "--format", "json", "--limit", "3"]);
    expect(result.exitCode).toBe(0);
    // JSON output has no text-format labels — --show-alias has no effect
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("`oas sessions --show-alias` exits 0", async () => {
    const result = await runCLI(["sessions", "--show-alias", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas list --show-alias` exits 0", async () => {
    const result = await runCLI(["list", "--show-alias", "--limit", "5"]);
    // Should accept the flag cleanly
    expect(result.exitCode).toBe(0);
  });

  test("`oas list --show-alias` — default alias shown when flag is set", async () => {
    const result = await runCLI(["list", "--show-alias", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    // When --show-alias is set, default alias must appear
    expect(result.stdout).toContain(":default]");
  });

  test("`oas list` (default) — default alias hidden", async () => {
    const result = await runCLI(["list", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(":default]");
  });
});
