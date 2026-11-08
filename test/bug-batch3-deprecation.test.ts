import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  deprecationNotice,
  resetDeprecationNotices,
} from "../src/cli/deprecation";
import { runCLI } from "./helpers/run-cli";

// ============================================================================
// BUG-10: deprecation notice mechanism (src/cli/deprecation.ts)
//
// Policy:
// - First-class documented commands NEVER emit a notice.
// - Genuine legacy aliases emit AT MOST once per process.
// - OAS_QUIET=1 fully suppresses the notice.
// ============================================================================

describe("deprecation notice mechanism", () => {
  let captured: string[];

  beforeEach(() => {
    resetDeprecationNotices();
    delete process.env["OAS_QUIET"];
    captured = [];
  });

  afterEach(() => {
    delete process.env["OAS_QUIET"];
  });

  const write = (line: string) => captured.push(line);

  test("emits the notice with the new command name", () => {
    deprecationNotice("oas session list", write);
    expect(captured).toEqual(["DEPRECATED: use 'oas session list' instead.\n"]);
  });

  test("is emitted at most once per process per target command", () => {
    deprecationNotice("oas session list", write);
    deprecationNotice("oas session list", write);
    deprecationNotice("oas session list", write);
    expect(captured).toHaveLength(1);
  });

  test("different target commands each get their own single notice", () => {
    deprecationNotice("oas session list", write);
    deprecationNotice("oas session detail", write);
    deprecationNotice("oas session list", write);
    expect(captured).toHaveLength(2);
  });

  test("OAS_QUIET=1 suppresses the notice entirely", () => {
    process.env["OAS_QUIET"] = "1";
    deprecationNotice("oas session list", write);
    expect(captured).toHaveLength(0);
  });

  test("any non-'1' OAS_QUIET value does NOT suppress (explicit opt-in only)", () => {
    process.env["OAS_QUIET"] = "true";
    deprecationNotice("oas session list", write);
    expect(captured).toHaveLength(1);
  });

  test("resetDeprecationNotices allows the notice again", () => {
    deprecationNotice("oas session list", write);
    deprecationNotice("oas session list", write);
    expect(captured).toHaveLength(1);
    resetDeprecationNotices();
    deprecationNotice("oas session list", write);
    expect(captured).toHaveLength(2);
  });
});

// ============================================================================
// BUG-10: help / shim alignment (live CLI)
//
// Commands documented as first-class must NOT print DEPRECATED. Only the
// legacy aliases do.
// ============================================================================

const FIRST_CLASS = [
  ["list"],
  ["sessions"],
  ["list-new"],
  ["find"],
  ["detail"],
  ["read"],
  ["search"],
  ["clone"],
  ["similar"],
] as const;

describe("BUG-10: first-class commands are silent (live CLI)", () => {
  test("first-class commands with --help never print DEPRECATED", async () => {
    for (const cmd of FIRST_CLASS) {
      const result = await runCLI([...cmd, "--help"]);
      expect(result.stderr).not.toContain("DEPRECATED");
      expect(result.stdout).not.toContain("DEPRECATED");
    }
  });

  test("oas detail <bare-id> exits 0 with empty stderr and valid JSON", async () => {
    // BUG-10 companion: bare-id detail must route to the owning adapter.
    const result = await runCLI([
      "detail",
      "01a1ad98-ec62-7553-8045-80efb4b66635",
      "--format",
      "json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.session.id).toBe("01a1ad98-ec62-7553-8045-80efb4b66635");
    expect(parsed.session.message_count).toBeGreaterThan(0);
  });

  test("oas list forwards silently (stderr empty)", async () => {
    const result = await runCLI(["list", "1", "--agent", "codex", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].message_count).toBeGreaterThan(0);
    expect(typeof parsed[0].title).toBe("string");
  });
});

describe("BUG-10: legacy aliases still warn (live CLI)", () => {
  test("oas recent emits DEPRECATED once pointing at session list", async () => {
    const result = await runCLI(["recent", "--help"]);
    expect(result.stderr).toContain("DEPRECATED");
    expect(result.stderr).toContain("oas session list");
  });

  test("oas show emits DEPRECATED pointing at session detail", async () => {
    const result = await runCLI(["show", "abc123"]);
    expect(result.stderr).toContain("DEPRECATED");
    expect(result.stderr).toContain("oas session detail");
  });

  test("OAS_QUIET=1 suppresses the notice on a legacy alias", async () => {
    const result = await runCLI(["show", "abc123"], 4000, {
      ...process.env,
      OAS_QUIET: "1",
    });
    expect(result.exitCode).toBe(1); // bare bogus id errors, but...
    expect(result.stderr).not.toContain("DEPRECATED");
  });

  test("without OAS_QUIET, list-new is silent (first-class, BUG-10)", async () => {
    const result = await runCLI(["list-new", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("DEPRECATED");
  });

  test("without OAS_QUIET, show warns exactly once per process (one call = one line)", async () => {
    const result = await runCLI(["show", "abc123"]);
    const lines = result.stderr.split("\n").filter((l) => l.includes("DEPRECATED"));
    expect(lines).toHaveLength(1);
  });
});

describe("BUG-10: help alignment", () => {
  test("--help documents legacy aliases under a Legacy aliases note", async () => {
    const result = await runCLI(["--help"]);
    expect(result.stdout).toContain("Legacy aliases");
    expect(result.stdout).toContain("OAS_QUIET=1");
  });

  test("--help shows first-class commands without any DEPRECATED flag", async () => {
    const result = await runCLI(["--help"]);
    expect(result.stdout).not.toContain("DEPRECATED:");
    // First-class surface present:
    expect(result.stdout).toContain("session detail");
    expect(result.stdout).toContain("session similar");
  });
});
