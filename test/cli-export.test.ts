import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExportCommand } from "../src/cli/export";
import type { SessionDetail } from "../src/core/types";
import { Config } from "../src/config/types";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
    { agent: "claude", alias: "team", enabled: false },
  ],
};

function makeDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "ses-001",
    agent: "opencode",
    alias: "personal",
    title: "Test Session",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-02T00:00:00.000Z",
    message_count: 2,
    storage: "db",
    messages: [
      {
        id: "msg-1",
        role: "user",
        created_at: "2024-01-01T00:00:01.000Z",
        parts: [{ type: "text", text: "Hello" }],
      },
      {
        id: "msg-2",
        role: "assistant",
        created_at: "2024-01-01T00:00:02.000Z",
        parts: [{ type: "text", text: "Hi there!" }],
      },
    ],
    ...overrides,
  };
}

const sessionFound = async () => makeDetail();
const sessionNotFound = async () => null;

// ---------------------------------------------------------------------------
// Tests — happy path
// ---------------------------------------------------------------------------

describe("cli export", () => {
  test("exports session to CSF by default", async () => {
    const result = await runExportCommand({
      sessionRef: "ses-001",
      config: baseConfig,
      getSession: async () => makeDetail(),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.version).toBe("1.0");
    expect(parsed.source.session_id).toBe("ses-001");
    expect(parsed.source.agent).toBe("opencode");
    expect(parsed.source.alias).toBe("personal");
    expect(parsed.messages).toHaveLength(2);
  });

  test("exports session to CSF via --from flag", async () => {
    const result = await runExportCommand({
      from: "ses-001",
      config: baseConfig,
      getSession: async () => makeDetail(),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.version).toBe("1.0");
  });

  test("exports session to Markdown format", async () => {
    const result = await runExportCommand({
      sessionRef: "ses-001",
      format: "markdown",
      config: baseConfig,
      getSession: async () => makeDetail({ title: "My Title" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# My Title");
    expect(result.stdout).toContain("agent: opencode");
    expect(result.stdout).toContain("alias: personal");
    expect(result.stdout).toContain("Hello");
  });

  test("exports session to Text format", async () => {
    const result = await runExportCommand({
      sessionRef: "ses-001",
      format: "text",
      config: baseConfig,
      getSession: async () => makeDetail({ title: "My Title" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Session: My Title");
    expect(result.stdout).toContain("Agent: opencode:personal");
    expect(result.stdout).toContain("Hello");
  });

  test("writes to file when --output is specified", async () => {
    const fs = await import("node:fs");
    const filePath = join(tmpdir(), `oas-export-test-${Date.now()}.txt`);

    try {
      const result = await runExportCommand({
        sessionRef: "ses-001",
        format: "text",
        output: filePath,
        config: baseConfig,
        getSession: async () => makeDetail({ title: "File Test" }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Output written to:");
      expect(fs.readFileSync(filePath, "utf-8")).toContain("File Test");
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  test("resolves alias:session_id spec", async () => {
    let capturedQuery: { agent: string; alias: string; id: string } | undefined;
    const getSession = async (
      query: { agent: string; alias: string; id: string },
      _opts?: unknown
    ) => {
      capturedQuery = query;
      return makeDetail();
    };

    const result = await runExportCommand({
      sessionRef: "personal:ses-001",
      config: baseConfig,
      getSession,
    });

    expect(result.exitCode).toBe(0);
    expect(capturedQuery).toEqual({ agent: "opencode", alias: "personal", id: "ses-001" });
  });

  test("resolves full agent:alias:session_id spec", async () => {
    let capturedQuery: { agent: string; alias: string; id: string } | undefined;
    const getSession = async (
      query: { agent: string; alias: string; id: string },
      _opts?: unknown
    ) => {
      capturedQuery = query;
      return makeDetail();
    };

    const result = await runExportCommand({
      sessionRef: "codex:work:cx-100",
      config: baseConfig,
      getSession,
    });

    expect(result.exitCode).toBe(0);
    expect(capturedQuery).toEqual({ agent: "codex", alias: "work", id: "cx-100" });
  });

  test("resolves --from spec with explicit alias", async () => {
    let capturedQuery: { agent: string; alias: string; id: string } | undefined;
    const getSession = async (
      query: { agent: string; alias: string; id: string },
      _opts?: unknown
    ) => {
      capturedQuery = query;
      return makeDetail();
    };

    const result = await runExportCommand({
      from: "opencode:personal:ses-001",
      config: baseConfig,
      getSession,
    });

    expect(result.exitCode).toBe(0);
    expect(capturedQuery).toEqual({ agent: "opencode", alias: "personal", id: "ses-001" });
  });
});

// ---------------------------------------------------------------------------
// Tests — error paths
// ---------------------------------------------------------------------------

describe("cli export error paths", () => {
  test("returns error when session not found", async () => {
    const result = await runExportCommand({
      sessionRef: "ses-404",
      config: baseConfig,
      getSession: sessionNotFound,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ses-404");
    expect(result.stderr).toContain("not found");
  });

  test("returns error when --format is unknown", async () => {
    const result = await runExportCommand({
      sessionRef: "ses-001",
      format: "xml" as any,
      config: baseConfig,
      getSession: sessionFound,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --format");
  });

  test("returns error for unknown agent in full spec", async () => {
    const result = await runExportCommand({
      sessionRef: "unknown-agent:default:ses-001",
      config: baseConfig,
      getSession: sessionFound,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown agent");
    expect(result.stderr).toContain("unknown-agent");
  });

  test("returns error for unknown alias in full spec", async () => {
    const result = await runExportCommand({
      sessionRef: "opencode:unknown-alias:ses-001",
      config: baseConfig,
      getSession: sessionFound,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown alias");
    expect(result.stderr).toContain("unknown-alias");
  });

  test("surfaces service error with context label", async () => {
    const getSession = async () => {
      throw new Error("database locked");
    };

    const result = await runExportCommand({
      sessionRef: "ses-001",
      config: baseConfig,
      getSession,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("opencode:personal");
    expect(result.stderr).toContain("database locked");
  });

  test("surfaces service error with explicit alias in spec", async () => {
    const getSession = async () => {
      throw new Error("permission denied");
    };

    const result = await runExportCommand({
      sessionRef: "codex:work:cx-100",
      config: baseConfig,
      getSession,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("codex:work");
    expect(result.stderr).toContain("permission denied");
  });

  test("returns error for invalid spec format (too many parts)", async () => {
    const result = await runExportCommand({
      sessionRef: "a:b:c:d",
      config: baseConfig,
      getSession: sessionFound,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid session reference");
  });

  test("returns error for too many parts in spec (4 segments)", async () => {
    const result = await runExportCommand({
      sessionRef: "a:b:c:d",
      config: baseConfig,
      getSession: sessionFound,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid session reference");
  });

  test("surfaces string-thrown error", async () => {
    const getSession = async () => {
      throw "string error";
    };

    const result = await runExportCommand({
      sessionRef: "ses-001",
      config: baseConfig,
      getSession,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("string error");
  });

  test("surfaces non-Error object-thrown error as unknown", async () => {
    const getSession = async () => {
      throw { code: "ERR_SQLITE_CANTOPEN" };
    };

    const result = await runExportCommand({
      sessionRef: "ses-001",
      config: baseConfig,
      getSession,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown error");
  });

  test("warns on large output when not using --output", async () => {
    const longText = "x".repeat(70000);
    const result = await runExportCommand({
      sessionRef: "ses-001",
      format: "text",
      config: baseConfig,
      getSession: async () =>
        makeDetail({ messages: [{ id: "msg-long", role: "user", created_at: "2024-01-01T00:00:00.000Z", parts: [{ type: "text", text: longText }] }] }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(60000);
    expect(result.stderr).toContain("Large output");
  });

  test("surfaces file write error", async () => {
    const result = await runExportCommand({
      sessionRef: "ses-001",
      output: "/nonexistent/directory/file.txt",
      config: baseConfig,
      getSession: sessionFound,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to write to file");
  });
});

// ---------------------------------------------------------------------------
// Tests — config edge cases
// ---------------------------------------------------------------------------

describe("cli export config edge cases", () => {
  test("uses first enabled entry when session_id only", async () => {
    let capturedQuery: { agent: string; alias: string; id: string } | undefined;
    const getSession = async (
      query: { agent: string; alias: string; id: string },
      _opts?: unknown
    ) => {
      capturedQuery = query;
      return makeDetail({ agent: "opencode", alias: "personal" });
    };

    const result = await runExportCommand({
      sessionRef: "ses-001",
      config: baseConfig,
      getSession,
    });

    expect(result.exitCode).toBe(0);
    expect(capturedQuery?.agent).toBe("opencode");
    expect(capturedQuery?.alias).toBe("personal");
  });

  test("finds agent by alias in two-part spec", async () => {
    // "work" alias belongs to codex, not opencode
    let capturedQuery: { agent: string; alias: string; id: string } | undefined;
    const getSession = async (
      query: { agent: string; alias: string; id: string },
      _opts?: unknown
    ) => {
      capturedQuery = query;
      return makeDetail({ agent: "codex", alias: "work" });
    };

    const result = await runExportCommand({
      sessionRef: "work:cx-001",
      config: baseConfig,
      getSession,
    });

    expect(result.exitCode).toBe(0);
    expect(capturedQuery).toEqual({ agent: "codex", alias: "work", id: "cx-001" });
  });

  test("CSF export includes clone metadata when present", async () => {
    const result = await runExportCommand({
      sessionRef: "ses-001",
      format: "csf",
      config: baseConfig,
      getSession: async () =>
        makeDetail({
          clone: {
            src: { agent: "codex", session_id: "cx-src", version: "1.0" },
            dst: { agent: "opencode", session_id: "ses-001", version: "1.0" },
          },
        }),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.clone).toBeDefined();
    expect(parsed.clone.src.agent).toBe("codex");
    expect(parsed.clone.dst.agent).toBe("opencode");
  });

  test("no enabled agents returns error", async () => {
    const emptyConfig: Config = { agents: [] };

    const result = await runExportCommand({
      sessionRef: "ses-001",
      config: emptyConfig,
      getSession: sessionFound,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No enabled agents");
  });
});
