import { describe, expect, test } from "bun:test";
import { runCLI } from "./helpers/run-cli";

const CI = !!process.env.CI;

async function hasLongTitle(limit = 100): Promise<boolean> {
  const result = await runCLI(["sessions", "--last", "30d", "--format", "json", `--limit`, String(limit)]);
  if (result.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) && parsed.some((s: any) => (s.title?.length ?? 0) > 40);
  } catch { return false; }
}

describe.skipIf(CI)("GAP 9a: `oas sessions --full` — full title, no truncation", () => {
  test("`oas sessions --full` exits 0", async () => {
    const result = await runCLI(["sessions", "--full", "--last", "30d"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas sessions --full` shows titles that are NOT truncated", async () => {
    const hasLong = await hasLongTitle();
    if (!hasLong) return;
    const withFull = await runCLI(["sessions", "--full", "--last", "30d", "--limit", "50"], 15000);
    const withoutFull = await runCLI(["sessions", "--last", "30d", "--limit", "50"], 15000);
    expect(withFull.exitCode).toBe(0);
    expect(withoutFull.exitCode).toBe(0);
    expect(withFull.stdout.length).toBeGreaterThan(withoutFull.stdout.length);
  }, 20000);

  test("`oas sessions` (no --full) has truncated titles when they exceed 40 chars", async () => {
    const hasLong = await hasLongTitle();
    if (!hasLong) return;
    const withoutFull = await runCLI(["sessions", "--last", "30d", "--limit", "5"]);
    expect(withoutFull.exitCode).toBe(0);
    expect(withoutFull.stdout).toContain("...");
  });

  test("`oas list --full` exits 0", async () => {
    const result = await runCLI(["list", "--full"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas sessions --format json --full` returns valid JSON", async () => {
    const result = await runCLI(["sessions", "--format", "json", "--full", "--last", "30d"]);
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe.skipIf(CI)("GAP 9b: `oas sessions` — hide `default` alias by default", () => {
  test("`oas sessions` (default) — `:default]` must NOT appear in output", async () => {
    const result = await runCLI(["sessions", "--last", "30d", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(":default]");
  });

  test("`oas sessions --show-alias` — `:default]` MUST appear in output", async () => {
    const result = await runCLI(["sessions", "--show-alias", "--last", "30d", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(":default]");
  });

  test("`oas sessions --show-alias` exits 0", async () => {
    const result = await runCLI(["sessions", "--show-alias", "--last", "30d", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas sessions --format json` returns JSON unaffected by --show-alias", async () => {
    const result = await runCLI(["sessions", "--format", "json", "--last", "30d", "--limit", "3"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("`oas list-new --show-alias` exits 0", async () => {
    const result = await runCLI(["list-new", "--show-alias", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas list-new --show-alias` — `:default]` shown when flag is set", async () => {
    const result = await runCLI(["list-new", "--show-alias", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(":default]");
  });

  test("`oas list-new` (default) — `:default]` hidden", async () => {
    const result = await runCLI(["list-new", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(":default]");
  });
});

describe.skipIf(CI)("GAP 9a (new path): `oas session list --full` — full title, no truncation", () => {
  test("`oas session list --full` exits 0", async () => {
    const result = await runCLI(["session", "list", "--full", "--last", "30d"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas session list --full` shows titles that are NOT truncated", async () => {
    const hasLong = await hasLongTitle();
    if (!hasLong) return;
    const withFull = await runCLI(["session", "list", "--full", "--last", "30d", "--limit", "50"], 15000);
    const withoutFull = await runCLI(["session", "list", "--last", "30d", "--limit", "50"], 15000);
    expect(withFull.exitCode).toBe(0);
    expect(withoutFull.exitCode).toBe(0);
    expect(withFull.stdout.length).toBeGreaterThan(withoutFull.stdout.length);
  }, 20000);

  test("`oas session list` (no --full) has truncated titles when they exceed 40 chars", async () => {
    const hasLong = await hasLongTitle();
    if (!hasLong) return;
    const withoutFull = await runCLI(["session", "list", "--last", "30d", "--limit", "5"]);
    expect(withoutFull.exitCode).toBe(0);
    expect(withoutFull.stdout).toContain("...");
  });

  test("`oas session list --format json --full` returns valid JSON", async () => {
    const result = await runCLI(["session", "list", "--format", "json", "--full", "--last", "30d"]);
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe.skipIf(CI)("GAP 10a: `oas list --format json|text`", () => {
  test("`oas list --format json` exits 0", async () => {
    const result = await runCLI(["list", "--format", "json", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas list --format json` returns valid JSON array", async () => {
    const result = await runCLI(["list", "--format", "json", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    if (parsed.length > 0) {
      const first = parsed[0];
      expect(first).toHaveProperty("id");
      expect(first).toHaveProperty("agent");
      expect(first).toHaveProperty("alias");
      expect(first).toHaveProperty("title");
    }
  });

  test("`oas list --format json` has no console.error noise", async () => {
    const result = await runCLI(["list", "--format", "json", "--limit", "3"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Error");
    expect(result.stderr).not.toContain("error:");
  });

  test("`oas list --format text` returns non-JSON text output", async () => {
    const result = await runCLI(["list", "--format", "text", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).toThrow();
  });

  test("`oas list` (no --format) behaves like --format text", async () => {
    const resultDefault = await runCLI(["list", "--limit", "5"]);
    const resultExplicit = await runCLI(["list", "--format", "text", "--limit", "5"]);
    expect(resultDefault.exitCode).toBe(0);
    expect(resultExplicit.exitCode).toBe(0);
    expect(resultDefault.stdout).toBe(resultExplicit.stdout);
  });

  test("`oas list --format invalid` returns an error", async () => {
    const result = await runCLI(["list", "--format", "garbage", "--limit", "5"]);
    const hasError = result.exitCode !== 0 || result.stdout.toLowerCase().includes("error");
    expect(hasError).toBe(true);
  });

  test("`oas list --format xml` returns an error", async () => {
    const result = await runCLI(["list", "--format", "xml", "--limit", "5"]);
    const hasError = result.exitCode !== 0 || result.stdout.toLowerCase().includes("error");
    expect(hasError).toBe(true);
  });
});

describe.skipIf(CI)("GAP 10a (new path): `oas session list --format json|text`", () => {
  test("`oas session list --format json` exits 0", async () => {
    const result = await runCLI(["session", "list", "--format", "json", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas session list --format json` returns valid JSON array", async () => {
    const result = await runCLI(["session", "list", "--format", "json", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    if (parsed.length > 0) {
      const first = parsed[0];
      expect(first).toHaveProperty("id");
      expect(first).toHaveProperty("agent");
      expect(first).toHaveProperty("alias");
      expect(first).toHaveProperty("title");
    }
  });

  test("`oas session list --format json` has no console.error noise", async () => {
    const result = await runCLI(["session", "list", "--format", "json", "--limit", "3"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Error");
    expect(result.stderr).not.toContain("error:");
  });

  test("`oas session list --format text` returns non-JSON text output", async () => {
    const result = await runCLI(["session", "list", "--format", "text", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).toThrow();
  });

  test("`oas session list` (no --format) behaves like --format text", async () => {
    const resultDefault = await runCLI(["session", "list", "--limit", "5"]);
    const resultExplicit = await runCLI(["session", "list", "--format", "text", "--limit", "5"]);
    expect(resultDefault.exitCode).toBe(0);
    expect(resultExplicit.exitCode).toBe(0);
    expect(resultDefault.stdout).toBe(resultExplicit.stdout);
  });

  test("`oas session list --format invalid` returns an error", async () => {
    const result = await runCLI(["session", "list", "--format", "garbage", "--limit", "5"]);
    const hasError = result.exitCode !== 0 || result.stdout.toLowerCase().includes("error");
    expect(hasError).toBe(true);
  });

  test("`oas session list --format xml` returns an error", async () => {
    const result = await runCLI(["session", "list", "--format", "xml", "--limit", "5"]);
    const hasError = result.exitCode !== 0 || result.stdout.toLowerCase().includes("error");
    expect(hasError).toBe(true);
  });
});
