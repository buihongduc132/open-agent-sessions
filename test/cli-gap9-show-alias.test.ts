import { describe, expect, test } from "bun:test";
import { runCLI } from "./helpers/run-cli";

const CI = !!process.env.CI;

async function hasAliasInData(alias: string): Promise<boolean> {
  const result = await runCLI(["sessions", "--last", "30d", "--format", "json", "--limit", "100"]);
  if (result.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) && parsed.some((s: any) => s.alias === alias);
  } catch { return false; }
}

describe.skipIf(CI)("GAP 9b: `oas sessions` — hide `default` alias by default", () => {
  test("`oas sessions` (default) — no `:default]` in output when default aliases exist", async () => {
    const hasDefault = await hasAliasInData("default");
    if (!hasDefault) return;
    const result = await runCLI(["sessions", "--last", "30d", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(":default]");
  });

  test("`oas sessions --show-alias` — `:default]` shown when flag is set AND default aliases exist", async () => {
    const hasDefault = await hasAliasInData("default");
    if (!hasDefault) return;
    const result = await runCLI(["sessions", "--show-alias", "--last", "30d", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(":default]");
  });

  test("`oas sessions --show-alias` exits 0", async () => {
    const result = await runCLI(["sessions", "--show-alias", "--last", "30d", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas sessions --format json` returns valid JSON", async () => {
    const result = await runCLI(["sessions", "--format", "json", "--last", "30d", "--limit", "3"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("`oas list-new --show-alias` exits 0", async () => {
    const result = await runCLI(["list-new", "--show-alias", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas list-new` (default) — no `:default]` when no default aliases", async () => {
    const hasDefault = await hasAliasInData("default");
    if (!hasDefault) return;
    const result = await runCLI(["list-new", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(":default]");
  });

  test("`oas list-new --show-alias` — `:default]` shown when flag is set AND default aliases exist", async () => {
    const hasDefault = await hasAliasInData("default");
    if (!hasDefault) return;
    const result = await runCLI(["list-new", "--show-alias", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(":default]");
  });
});

describe.skipIf(CI)("GAP 9b (new path): `oas session list` — hide `default` alias by default", () => {
  test("`oas session list` (default) — no `:default]` in output when default aliases exist", async () => {
    const hasDefault = await hasAliasInData("default");
    if (!hasDefault) return;
    const result = await runCLI(["session", "list", "--last", "30d", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(":default]");
  });

  test("`oas session list --show-alias` — `:default]` shown when flag is set AND default aliases exist", async () => {
    const hasDefault = await hasAliasInData("default");
    if (!hasDefault) return;
    const result = await runCLI(["session", "list", "--show-alias", "--last", "30d", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(":default]");
  });

  test("`oas session list --show-alias` exits 0", async () => {
    const result = await runCLI(["session", "list", "--show-alias", "--last", "30d", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
  });

  test("`oas session list --format json` returns valid JSON", async () => {
    const result = await runCLI(["session", "list", "--format", "json", "--last", "30d", "--limit", "3"]);
    expect(result.exitCode).toBe(0);
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
    // Text output starts with [agent:alias] which is NOT valid JSON
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