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
// Coverage Tests for src/cli/read.ts
// ============================================================================

describe("CLI read: coverage boost", () => {
  // ==========================================================================
  // Lines 180-183: Config loading error path
  // ==========================================================================
  describe("config loading errors", () => {
    test("loadConfig throws error", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        configPath: "/nonexistent/config.yaml",
        loadConfig: () => {
          throw new Error("Config file not found");
        },
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Config file not found");
    });

    test("loadConfig throws non-Error object", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        configPath: "/nonexistent/config.yaml",
        loadConfig: () => {
          throw "String error";
        },
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("String error");
    });
  });

  // ==========================================================================
  // Lines 252-270: Explicit target parsing (agent, alias, id flags)
  // ==========================================================================
  describe("explicit target parsing", () => {
    test("--agent, --alias, --id flags work", async () => {
      let receivedQuery: { agent: string; alias: string; id: string } | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        agent: "opencode",
        alias: "personal",
        id: "session-001",
        config: baseConfig,
        getSession: makeReadService(detail, (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery?.agent).toBe("opencode");
      expect(receivedQuery?.alias).toBe("personal");
      expect(receivedQuery?.id).toBe("session-001");
    });

    test("explicit flags reject unknown agent", async () => {
      const result = await runReadCommand({
        agent: "unknown",
        alias: "personal",
        id: "session-001",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown agent");
    });

    test("explicit flags reject unknown alias", async () => {
      const result = await runReadCommand({
        agent: "opencode",
        alias: "unknown",
        id: "session-001",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown alias");
    });

    test("explicit flags reject missing agent", async () => {
      const result = await runReadCommand({
        alias: "personal",
        id: "session-001",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid arguments");
    });

    test("explicit flags reject missing alias", async () => {
      const result = await runReadCommand({
        agent: "opencode",
        id: "session-001",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid arguments");
    });

    test("explicit flags reject missing id", async () => {
      const result = await runReadCommand({
        agent: "opencode",
        alias: "personal",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid arguments");
    });

    test("explicit flags reject empty strings", async () => {
      const result = await runReadCommand({
        agent: "  ",
        alias: "personal",
        id: "session-001",
        config: baseConfig,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid arguments");
    });
  });

  // ==========================================================================
  // Lines 475-477, 496-509: Message part formatting
  // ==========================================================================
  describe("message part formatting", () => {
    test("formats reasoning parts", async () => {
      const messages: SessionMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          created_at: "2024-01-01T12:00:00Z",
          parts: [
            { type: "reasoning", text: "Let me think about this..." },
          ],
        },
      ];
      const detail = makeSessionDetail({ messages, message_count: 1 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[reasoning]");
      expect(result.stdout).toContain("Let me think about this");
    });

    test("formats tool parts (with --tools flag)", async () => {
      const messages: SessionMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          created_at: "2024-01-01T12:00:00Z",
          parts: [
            { type: "tool", tool: "bash", state: { status: "completed" } },
          ],
        },
      ];
      const detail = makeSessionDetail({ messages, message_count: 1 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        tools: true,  // Tools only shown with --tools flag
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[tool: bash - completed]");
    });

    test("hides tool parts by default (without --tools flag)", async () => {
      const messages: SessionMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          created_at: "2024-01-01T12:00:00Z",
          parts: [
            { type: "tool", tool: "bash", state: { status: "completed" } },
          ],
        },
      ];
      const detail = makeSessionDetail({ messages, message_count: 1 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        // No tools flag - tools should be hidden
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("[tool:");
    });

    test("formats unknown part types", async () => {
      const messages: SessionMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          created_at: "2024-01-01T12:00:00Z",
          parts: [
            { type: "unknown_type" as any },
          ],
        },
      ];
      const detail = makeSessionDetail({ messages, message_count: 1 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[unknown_type]");
    });

    test("formats message with agent and model", async () => {
      const messages: SessionMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          created_at: "2024-01-01T12:00:00Z",
          agent: "claude-3",
          modelID: "claude-3-opus",
          parts: [{ type: "text", text: "Hello" }],
        },
      ];
      const detail = makeSessionDetail({ messages, message_count: 1 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("claude-3");
      expect(result.stdout).toContain("claude-3-opus");
    });

    test("formats message with agent only", async () => {
      const messages: SessionMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          created_at: "2024-01-01T12:00:00Z",
          agent: "claude-3",
          parts: [{ type: "text", text: "Hello" }],
        },
      ];
      const detail = makeSessionDetail({ messages, message_count: 1 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("claude-3");
    });

    test("formats message with model only", async () => {
      const messages: SessionMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          created_at: "2024-01-01T12:00:00Z",
          modelID: "claude-3-opus",
          parts: [{ type: "text", text: "Hello" }],
        },
      ];
      const detail = makeSessionDetail({ messages, message_count: 1 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("claude-3-opus");
    });
  });

  // ==========================================================================
  // Line 562: formatList with empty array
  // ==========================================================================
  describe("formatList edge case", () => {
    test("shows (none) when no agents enabled", async () => {
      const config: Config = {
        agents: [
          { agent: "opencode", alias: "personal", enabled: false, storage: { mode: "auto" } },
        ],
      };

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config,
        getSession: makeReadService(makeSessionDetail()),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown agent");
      expect(result.stderr).toContain("(none)");
    });
  });

  // ==========================================================================
  // Line 575: withLabel when label already in message
  // ==========================================================================
  describe("withLabel edge case", () => {
    test("doesn't duplicate label if already present", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: async () => {
          throw new Error("[opencode:personal] Already has label");
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[opencode:personal]");
      // Count occurrences - should only appear once
      const matches = result.stderr.match(/\[opencode:personal\]/g);
      expect(matches?.length).toBe(1);
    });
  });

  // ==========================================================================
  // Lines 587-591: errorMessage for non-Error types
  // ==========================================================================
  describe("errorMessage edge cases", () => {
    test("handles string errors", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: async () => {
          throw "String error message";
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("String error message");
    });

    test("handles unknown error types", async () => {
      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: async () => {
          throw { custom: "error" };
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown error");
    });
  });

  // ==========================================================================
  // Additional edge cases
  // ==========================================================================
  describe("additional edge cases", () => {
    test("normalizes empty title to session id", async () => {
      const detail = makeSessionDetail({ title: "   " });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("title: session-001");
    });

    test("handles text parts with leading/trailing whitespace", async () => {
      const messages: SessionMessage[] = [
        {
          id: "msg-1",
          role: "user",
          created_at: "2024-01-01T12:00:00Z",
          parts: [{ type: "text", text: "  Hello world  \n  " }],
        },
      ];
      const detail = makeSessionDetail({ messages, message_count: 1 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Hello world");
    });

    test("handles multiline text parts", async () => {
      const messages: SessionMessage[] = [
        {
          id: "msg-1",
          role: "user",
          created_at: "2024-01-01T12:00:00Z",
          parts: [{ type: "text", text: "Line 1\nLine 2\nLine 3" }],
        },
      ];
      const detail = makeSessionDetail({ messages, message_count: 1 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Line 1");
      expect(result.stdout).toContain("Line 2");
      expect(result.stdout).toContain("Line 3");
    });

    test("JSON output includes clone metadata", async () => {
      const detail = makeSessionDetail({
        clone: {
          src: { agent: "codex", session_id: "cx-100" },
          dst: { agent: "opencode", session_id: "session-001" },
        },
      });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        format: "json",
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.session.clone).toBeDefined();
      expect(parsed.session.clone.src.agent).toBe("codex");
      expect(parsed.session.clone.dst.agent).toBe("opencode");
    });
  });
});
