import { describe, expect, test } from "bun:test";
import { runReadCommand, type ReadService } from "../src/cli/read";
import { type Config } from "../src/config/types";
import {
  type SessionDetail,
  type SessionReadOptions,
  type SessionMessage,
} from "../src/core/types";

// ============================================================================
// Test Fixtures
// ============================================================================

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
    { agent: "claude", alias: "team", enabled: false },
  ],
};

function makeReadService(
  detail: SessionDetail | null,
  onCall?: (query: { agent: string; alias: string; id: string }, options: SessionReadOptions) => void
): ReadService {
  return async (query, options) => {
    if (onCall) {
      onCall(query, options);
    }
    return detail;
  };
}

function makeSessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "session-001",
    agent: "opencode",
    alias: "personal",
    title: "Test Session",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 5,
    storage: "db",
    messages: [],
    ...overrides,
  };
}

function makeMessage(role: "user" | "assistant" | "system", text: string, id?: string): SessionMessage {
  return {
    id: id ?? `msg-${Date.now()}-${Math.random()}`,
    role,
    created_at: "2024-01-01T12:00:00Z",
    parts: [{ type: "text", text }],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("cli read", () => {
  // ==========================================================================
  // AC1: Parse --first N
  // ==========================================================================
  describe("AC1: --first N", () => {
    test("parses --first 5 and passes to service", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        first: 5,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.mode).toBe("first");
      expect(receivedOptions?.selection?.count).toBe(5);
    });

    test("rejects --first 0", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        first: 0,
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --first value");
      expect(result.stderr).toContain("positive number");
    });

    test("rejects --first -1", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        first: -1,
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --first value");
    });
  });

  // ==========================================================================
  // AC2: Parse --last N (default 10)
  // ==========================================================================
  describe("AC2: --last N (default 10)", () => {
    test("parses --last 20 and passes to service", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        last: 20,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.mode).toBe("last");
      expect(receivedOptions?.selection?.count).toBe(20);
    });

    test("defaults to last 10 when no selection specified", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.mode).toBe("last");
      expect(receivedOptions?.selection?.count).toBe(10);
    });

    test("rejects --last 0", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        last: 0,
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --last value");
    });
  });

  // ==========================================================================
  // AC3: Parse --all
  // ==========================================================================
  describe("AC3: --all", () => {
    test("parses --all and passes to service", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        all: true,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.mode).toBe("all");
    });
  });

  // ==========================================================================
  // AC4: Parse --range START:END (1-indexed, inclusive)
  // ==========================================================================
  describe("AC4: --range START:END", () => {
    test("parses --range 1:5 and passes to service", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "1:5",
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.mode).toBe("range");
      expect(receivedOptions?.selection?.start).toBe(1);
      expect(receivedOptions?.selection?.end).toBe(5);
    });

    test("parses --range 10:20", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "10:20",
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.start).toBe(10);
      expect(receivedOptions?.selection?.end).toBe(20);
    });
  });

  // ==========================================================================
  // AC5: Tool visibility control (--tools, flag, default hide)
  // ==========================================================================
  describe("AC5: Tool visibility", () => {
    test("default hides tools (all_no_tools mode)", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(receivedOptions?.mode).toBe("all_no_tools");
    });

    test("--tools flag includes tools (all_with_tools mode)", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      await runReadCommand({
        session: "opencode:personal:session-001",
        tools: true,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(receivedOptions?.mode).toBe("all_with_tools");
    });
  });

  // ==========================================================================
  // AC6: Error on conflicting flags
  // ==========================================================================
  describe("AC6: Conflicting flags", () => {
    test("--first + --last = error", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        first: 5,
        last: 10,
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Cannot use --first and --last together");
    });

    test("--first + --all = error", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        first: 5,
        all: true,
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Cannot use --first and --all together");
    });

    test("--last + --range = error", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        last: 5,
        range: "1:10",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Cannot use --last and --range together");
    });

    test("--all + --range = error", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        all: true,
        range: "1:10",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Cannot use --all and --range together");
    });
  });

  // ==========================================================================
  // AC7: Error on invalid ranges
  // ==========================================================================
  describe("AC7: Invalid ranges", () => {
    test("rejects --range 0:5 (start = 0)", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "0:5",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("start (0) must be >= 1");
    });

    test("rejects --range 5:0 (end = 0)", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "5:0",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("end (0) must be >= 1");
    });

    test("rejects --range -1:5 (negative start)", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "-1:5",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("start (-1) must be >= 1");
    });

    test("rejects --range 1:-5 (negative end)", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "1:-5",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("end (-5) must be >= 1");
    });

    test("rejects --range 10:5 (start > end)", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "10:5",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("start (10) > end (5)");
    });

    test("rejects invalid --range format (missing colon)", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "10",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --range format");
    });

    test("rejects invalid --range format (non-numeric)", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "abc:def",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("START and END must be numbers");
    });
  });

  // ==========================================================================
  // AC8: Full session ID required (no short form in v1)
  // ==========================================================================
  describe("AC8: Full session ID required", () => {
    test("accepts full session ID (agent:alias:id)", async () => {
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
    });

    test("rejects short form (agent:id) - missing alias", async () => {
      const result = await runReadCommand({
        session: "opencode:session-001",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Full session ID required");
      expect(result.stderr).toContain("agent:alias:session_id");
    });

    test("rejects just session ID", async () => {
      const result = await runReadCommand({
        session: "session-001",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Full session ID required");
    });
  });

  // ==========================================================================
  // Output Formatting
  // ==========================================================================
  describe("output formatting", () => {
    test("prints session header with all fields", async () => {
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Session [opencode:personal]");
      expect(result.stdout).toContain("id: session-001");
      expect(result.stdout).toContain("title: Test Session");
      expect(result.stdout).toContain("created_at: 2024-01-01T00:00:00Z");
      expect(result.stdout).toContain("updated_at: 2024-01-02T00:00:00Z");
      expect(result.stdout).toContain("message_count: 5");
      expect(result.stdout).toContain("storage: db");
    });

    test("shows metadata only when session has 0 messages (no 'No messages.' text)", async () => {
      const detail = makeSessionDetail({ messages: [], message_count: 0 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      // Should show metadata
      expect(result.stdout).toContain("Session [opencode:personal]");
      expect(result.stdout).toContain("id: session-001");
      expect(result.stdout).toContain("title: Test Session");
      expect(result.stdout).toContain("created_at: 2024-01-01T00:00:00Z");
      expect(result.stdout).toContain("updated_at: 2024-01-02T00:00:00Z");
      expect(result.stdout).toContain("message_count: 0");
      expect(result.stdout).toContain("storage: db");
      // Should NOT contain "No messages." or "Messages (0):"
      expect(result.stdout).not.toContain("No messages.");
      expect(result.stdout).not.toContain("Messages (0):");
      expect(result.stdout).not.toContain("Messages (");
    });

    test("displays messages with role and timestamp", async () => {
      const detail = makeSessionDetail({
        messages: [
          makeMessage("user", "Hello world"),
          makeMessage("assistant", "Hi there!"),
        ],
      });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Messages (2):");
      expect(result.stdout).toContain("> USER");
      expect(result.stdout).toContain("< ASSISTANT");
      expect(result.stdout).toContain("Hello world");
      expect(result.stdout).toContain("Hi there!");
    });

    test("displays warning when present", async () => {
      const detail = makeSessionDetail({
        warning: "Large message count: consider using --range",
      });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Warning:");
      expect(result.stdout).toContain("Large message count");
    });
  });

  // ==========================================================================
  // Error Cases
  // ==========================================================================
  describe("error cases", () => {
    test("session not found returns error", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:missing-session",
        config: baseConfig,
        getSession: makeReadService(null),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Session not found");
    });

    test("unknown agent lists available agents", async () => {
      const result = await runReadCommand({
        session: "unknown:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(null),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown agent");
      expect(result.stderr).toContain("opencode");
      expect(result.stderr).toContain("codex");
    });

    test("unknown alias lists available aliases", async () => {
      const result = await runReadCommand({
        session: "opencode:unknown:session-001",
        config: baseConfig,
        getSession: makeReadService(null),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown alias");
      expect(result.stderr).toContain("personal");
    });

    test("empty session segment shows usage", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:",
        config: baseConfig,
        getSession: makeReadService(null),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --session value");
    });

    test("missing config returns error", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        getSession: makeReadService(null),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing config");
    });

    test("service errors are labeled", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: async () => {
          throw new Error("Database connection failed");
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[opencode:personal]");
      expect(result.stderr).toContain("Database connection failed");
    });
  });

  // ==========================================================================
  // Range Exceeds Message Count (Range Clamping)
  // ==========================================================================
  describe("range exceeds message count", () => {
    test("--range 1:50 with 10 messages returns all 10 messages (not an error)", async () => {
      // Create 10 messages
      const messages = Array.from({ length: 10 }, (_, i) =>
        makeMessage("user" as const, `Message ${i + 1}`, `msg-${i + 1}`)
      );

      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail({ messages, message_count: 10 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "1:50",
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.mode).toBe("range");
      expect(receivedOptions?.selection?.start).toBe(1);
      expect(receivedOptions?.selection?.end).toBe(50);
      // The adapter handles clamping - we verify the output contains all messages
      expect(result.stdout).toContain("Messages (10):");
    });

    test("--range 5:100 with 10 messages returns messages 5-10", async () => {
      // Create 10 messages
      const messages = Array.from({ length: 10 }, (_, i) =>
        makeMessage("user" as const, `Message ${i + 1}`, `msg-${i + 1}`)
      );

      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail({ messages, message_count: 10 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "5:100",
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.mode).toBe("range");
      expect(receivedOptions?.selection?.start).toBe(5);
      expect(receivedOptions?.selection?.end).toBe(100);
    });

    test("--range 1:1 with 0 messages returns empty (no error)", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail({ messages: [], message_count: 0 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "1:1",
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.mode).toBe("range");
      expect(receivedOptions?.selection?.start).toBe(1);
      expect(receivedOptions?.selection?.end).toBe(1);
      // Should show metadata only, no messages
      expect(result.stdout).toContain("Session [opencode:personal]");
      expect(result.stdout).not.toContain("Messages (");
    });

    test("--first 50 with 10 messages returns all 10 messages", async () => {
      // Create 10 messages
      const messages = Array.from({ length: 10 }, (_, i) =>
        makeMessage("user" as const, `Message ${i + 1}`, `msg-${i + 1}`)
      );

      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail({ messages, message_count: 10 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        first: 50,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.mode).toBe("first");
      expect(receivedOptions?.selection?.count).toBe(50);
      expect(result.stdout).toContain("Messages (10):");
    });

    test("--last 50 with 10 messages returns all 10 messages", async () => {
      // Create 10 messages
      const messages = Array.from({ length: 10 }, (_, i) =>
        makeMessage("user" as const, `Message ${i + 1}`, `msg-${i + 1}`)
      );

      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail({ messages, message_count: 10 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        last: 50,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.mode).toBe("last");
      expect(receivedOptions?.selection?.count).toBe(50);
      expect(result.stdout).toContain("Messages (10):");
    });
  });

  // ==========================================================================
  // AC9: JSON Format
  // ==========================================================================
  describe("AC9: --format json", () => {
    test("outputs valid JSON for session", async () => {
      const messages = [
        makeMessage("user" as const, "Hello"),
        makeMessage("assistant" as const, "Hi there!"),
      ];
      const detail = makeSessionDetail({ messages, message_count: 2 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        format: "json",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.session.id).toBe("session-001");
      expect(parsed.session.agent).toBe("opencode");
      expect(parsed.session.alias).toBe("personal");
      expect(parsed.session.title).toBe("Test Session");
      expect(parsed.session.message_count).toBe(2);
      expect(Array.isArray(parsed.messages)).toBe(true);
      expect(parsed.messages.length).toBe(2);
    });

    test("JSON includes all session metadata", async () => {
      const detail = makeSessionDetail({
        id: "test-session-id",
        title: "JSON Test Session",
        message_count: 5,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        storage: "db",
      });

      const result = await runReadCommand({
        session: "opencode:personal:test-session-id",
        format: "json",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.session.id).toBe("test-session-id");
      expect(parsed.session.title).toBe("JSON Test Session");
      expect(parsed.session.message_count).toBe(5);
      expect(parsed.session.created_at).toBe("2024-01-01T00:00:00Z");
      expect(parsed.session.updated_at).toBe("2024-01-02T00:00:00Z");
      expect(parsed.session.storage).toBe("db");
    });

    test("JSON includes message parts", async () => {
      const messages = [
        {
          id: "msg-1",
          role: "user" as const,
          created_at: "2024-01-01T12:00:00Z",
          parts: [
            { type: "text", text: "Hello world" },
            { type: "tool", tool: "bash", state: { status: "completed" } },
          ],
        },
      ];
      const detail = makeSessionDetail({ messages, message_count: 1 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        format: "json",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.messages[0].parts.length).toBe(2);
      expect(parsed.messages[0].parts[0].type).toBe("text");
      expect(parsed.messages[0].parts[0].text).toBe("Hello world");
      expect(parsed.messages[0].parts[1].type).toBe("tool");
    });
  });

  // ==========================================================================
  // AC10: --output FILE
  // ==========================================================================
  describe("AC10: --output FILE", () => {
    test("writes output to file", async () => {
      const { mkdtempSync, rmSync, existsSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");

      const tempDir = mkdtempSync(join(tmpdir(), "oas-test-"));
      const outputPath = join(tempDir, "output.json");

      try {
        const detail = makeSessionDetail({ message_count: 1 });

        const result = await runReadCommand({
          session: "opencode:personal:session-001",
          format: "json",
          output: outputPath,
          config: baseConfig,
          getSession: makeReadService(detail),
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(outputPath)).toBe(true);
        expect(result.stderr).toContain("Output written to:");

        const content = readFileSync(outputPath, "utf-8");
        const parsed = JSON.parse(content);
        expect(parsed.session.id).toBe("session-001");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test("handles write errors gracefully", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        format: "json",
        output: "/nonexistent/path/output.json",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Failed to write to file");
    });

    test("works with text format", async () => {
      const { mkdtempSync, rmSync, existsSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");

      const tempDir = mkdtempSync(join(tmpdir(), "oas-test-"));
      const outputPath = join(tempDir, "output.txt");

      try {
        const messages = [makeMessage("user" as const, "Test message")];
        const detail = makeSessionDetail({ messages, message_count: 1 });

        const result = await runReadCommand({
          session: "opencode:personal:session-001",
          output: outputPath,
          config: baseConfig,
          getSession: makeReadService(detail),
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(outputPath)).toBe(true);

        const content = readFileSync(outputPath, "utf-8");
        expect(content).toContain("Session [opencode:personal]");
        expect(content).toContain("Test message");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // ==========================================================================
  // AC11: Role Filtering
  // ==========================================================================
  describe("AC11: --role filtering", () => {
    test("rejects invalid role", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        role: "invalid",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --role value");
      expect(result.stderr).toContain("user, assistant, system");
    });

    test("accepts valid roles", async () => {
      for (const role of ["user", "assistant", "system"] as const) {
        let receivedOptions: SessionReadOptions | undefined;
        const detail = makeSessionDetail();

        const result = await runReadCommand({
          session: "opencode:personal:session-001",
          role,
          config: baseConfig,
          getSession: makeReadService(detail, (_, opts) => {
            receivedOptions = opts;
          }),
        });

        expect(result.exitCode).toBe(0);
        expect(receivedOptions?.role).toBe(role);
      }
    });
  });

  // ==========================================================================
  // AC12: Large Output Warning
  // ==========================================================================
  describe("AC12: Large output warning", () => {
    test("warns for large outputs", async () => {
      // Create a large message to trigger the warning (>60KB)
      const largeText = "x".repeat(70000);
      const messages = [makeMessage("user" as const, largeText)];
      const detail = makeSessionDetail({ messages, message_count: 1 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Large output");
      expect(result.stderr).toContain("--output");
    });

    test("no warning for small outputs", async () => {
      const messages = [makeMessage("user" as const, "Small message")];
      const detail = makeSessionDetail({ messages, message_count: 1 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("Large output");
    });
  });

  // ==========================================================================
  // AC13: Range Parsing Edge Cases
  // ==========================================================================
  describe("AC13: Range parsing edge cases", () => {
    test("rejects range with only start", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "5:",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --range format");
    });

    test("rejects range with only end", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: ":5",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --range format");
    });

    test("rejects range with non-numeric values", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "abc:def",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --range values");
    });

    test("rejects range where start > end", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "10:5",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("start (10) > end (5)");
    });
  });
});
