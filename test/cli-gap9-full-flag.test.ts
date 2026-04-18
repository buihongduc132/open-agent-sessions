/**
 * test/cli-gap9-full-flag.test.ts
 *
 * RED tests for GAP 9a — `--full` flag for sessions/list commands.
 *
 * Gap requirement (_16apr_gaps.md):
 *   "Add `--full` flag to `sessions` / `list`. Title is never truncated
 *    when `--full` is set."
 *
 * Current behavior: Titles are always truncated to 40 chars in
 * `formatSessionRow` (text.ts:59: `truncateText(title, 40)`).
 *
 * After fix: `oas sessions --full` / `oas list --full` → full title
 * shown, no truncation. `--format json` is unaffected (JSON always has
 * full titles regardless).
 *
 * These tests should FAIL until the --full flag is wired through the
 * CLI entry point into the formatter.
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
// GAP 9a — `--full` flag: full titles, no truncation
// ============================================================================

describe("GAP 9a: `oas sessions --full` — full title, no truncation", () => {
  test("`oas sessions --full` exits 0", async () => {
    const result = await runCLI(["sessions", "--full"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas sessions --full` shows full title (no ellipsis truncation)", async () => {
    const result = await runCLI(["sessions", "--full", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    // When --full is set, titles are NOT truncated to 40 chars.
    // We check that there is NO truncated marker (e.g. no "..." in the title
    // position, and line lengths are > 40 chars where there are titles).
    const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
    const titleLines = lines.filter(
      (l) => !l.startsWith("[") || l.includes("opencode") || l.includes("codex") || l.includes("claude"),
    );
    // At least one title-bearing line should exceed the 40-char truncation limit
    const hasLongTitle = titleLines.some((l) => {
      // Extract the "title" portion after the [agent:alias] label + [main/sub] tag
      const match = l.match(/\] \[[^\]]+\] (.{50,})/);
      return match !== null;
    });
    expect(hasLongTitle).toBe(true);
  });

  test("`oas sessions` (no --full) still truncates titles to ~40 chars", async () => {
    const result = await runCLI(["sessions", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    // Without --full, titles ARE truncated. Lines with titles should have
    // content <= ~60 chars (40-char title + padding + metadata).
    const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0 && l.includes("msg"));
    // Lines with truncated titles are short (padding makes them ~60-80 chars)
    // but the TITLE portion itself should be <= 40 chars.
    // Check that no title-bearing line has a long run of non-space chars > 40
    // in the title position.
    const hasOverlongTitle = lines.some((l) => {
      // Title portion after ] [main] or ] [sub]  starts with non-space
      const m = l.match(/\] \[[^\]]+\]  ([^ ]+)/);
      if (!m) return false;
      // If a single "word" > 40 chars appears in title position → not truncated
      return m[1].length > 40;
    });
    expect(hasOverlongTitle).toBe(false);
  });

  test("`oas list --full` exits 0", async () => {
    const result = await runCLI(["list", "--full"]);
    // May return 0 even with no sessions — just needs to accept the flag
    expect(result.exitCode).toBe(0);
  });

  test("`oas sessions --format json --full` returns valid JSON (--format json unaffected)", async () => {
    const result = await runCLI(["sessions", "--format", "json", "--full", "--limit", "3"]);
    expect(result.exitCode).toBe(0);
    // --format json must not be affected by --full
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    // JSON must have full title (no truncation concept in JSON)
    expect(typeof parsed[0].title).toBe("string");
  });
});
