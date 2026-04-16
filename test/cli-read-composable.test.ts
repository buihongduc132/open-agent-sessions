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
// Gap 4: Composable --last N --user-only flags
// ============================================================================
// These tests verify that --user-only can be COMPOSED with --first/--last/--all/--range
// as an additive filter, not as a replacement selection mode.
//
// Current behavior: parseSelectionOptions() treats --user-only as a standalone mode
// and throws "Cannot use --last and --user-only together" (modes.length > 1).
//
// Expected behavior: --user-only appends `userOnly: true` to the selection object,
// keeping the primary mode (first/last/all/range) intact.
// ============================================================================

describe("Gap 4: Composable --last N --user-only flags", () => {
  // ==========================================================================
  // test_last_n_user_only_is_composable
  // ==========================================================================
  describe("test_last_n_user_only_is_composable", () => {
    test("--last 20 --user-only composes without conflict error", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        last: 20,
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      // RED expectation: currently this FAILS with exitCode=1 and
      // "Cannot use --last and --user-only together" — this test documents the desired behavior
      expect(result.exitCode).toBe(0); // ← will fail until composable implementation is added
      expect(result.stderr).not.toContain("Cannot use --last and --user-only together");
    });

    test("passes last=20 count AND userOnly=true to service", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      await runReadCommand({
        session: "opencode:personal:session-001",
        last: 20,
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      // Primary mode is still "last"
      expect(receivedOptions?.selection?.mode).toBe("last");
      expect(receivedOptions?.selection?.count).toBe(20);
      // userOnly is an additive boolean, not a replacement mode
      expect((receivedOptions?.selection as any).userOnly).toBe(true);
    });

    test("returns only user-role messages (from last 20) in output", async () => {
      // Build a session with known roles so we can verify filtering
      const messages: SessionMessage[] = [
        makeMessage("user", "User message 1", "msg-1"),
        makeMessage("assistant", "Assistant message 1", "msg-2"),
        makeMessage("user", "User message 2", "msg-3"),
        makeMessage("system", "System message", "msg-4"),
        makeMessage("user", "User message 3", "msg-5"),
        makeMessage("assistant", "Assistant message 2", "msg-6"),
      ];

      const detail = makeSessionDetail({
        messages,
        message_count: 6,
      });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        last: 6,
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      // Only user messages should appear
      expect(result.stdout).toContain("User message 1");
      expect(result.stdout).toContain("User message 2");
      expect(result.stdout).toContain("User message 3");
      // Assistant and system messages must NOT appear
      expect(result.stdout).not.toContain("Assistant message");
      expect(result.stdout).not.toContain("System message");
    });
  });

  // ==========================================================================
  // test_first_n_user_only_is_composable
  // ==========================================================================
  describe("test_first_n_user_only_is_composable", () => {
    test("--first 5 --user-only composes without conflict error", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        first: 5,
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      // RED: currently fails with "Cannot use --first and --user-only together"
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("Cannot use --first and --user-only together");
    });

    test("passes first=5 count AND userOnly=true to service", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      await runReadCommand({
        session: "opencode:personal:session-001",
        first: 5,
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(receivedOptions?.selection?.mode).toBe("first");
      expect(receivedOptions?.selection?.count).toBe(5);
      expect((receivedOptions?.selection as any).userOnly).toBe(true);
    });

    test("returns only user-role messages from first N in output", async () => {
      const messages: SessionMessage[] = [
        makeMessage("user", "First user msg", "msg-1"),
        makeMessage("assistant", "First assistant", "msg-2"),
        makeMessage("user", "Second user msg", "msg-3"),
        makeMessage("assistant", "Second assistant", "msg-4"),
      ];

      const detail = makeSessionDetail({ messages, message_count: 4 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        first: 4,
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("First user msg");
      expect(result.stdout).toContain("Second user msg");
      expect(result.stdout).not.toContain("First assistant");
      expect(result.stdout).not.toContain("Second assistant");
    });
  });

  // ==========================================================================
  // test_all_user_only_is_composable
  // ==========================================================================
  describe("test_all_user_only_is_composable", () => {
    test("--all --user-only composes without conflict error", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        all: true,
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      // RED: currently fails with "Cannot use --all and --user-only together"
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("Cannot use --all and --user-only together");
    });

    test("passes mode=all AND userOnly=true to service", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      await runReadCommand({
        session: "opencode:personal:session-001",
        all: true,
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(receivedOptions?.selection?.mode).toBe("all");
      expect((receivedOptions?.selection as any).userOnly).toBe(true);
    });

    test("returns only user-role messages from all messages in output", async () => {
      const messages: SessionMessage[] = [
        makeMessage("assistant", "Assistant A", "msg-a"),
        makeMessage("user", "User A", "msg-b"),
        makeMessage("assistant", "Assistant B", "msg-c"),
        makeMessage("user", "User B", "msg-d"),
        makeMessage("system", "System msg", "msg-e"),
        makeMessage("user", "User C", "msg-f"),
      ];

      const detail = makeSessionDetail({ messages, message_count: 6 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        all: true,
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("User A");
      expect(result.stdout).toContain("User B");
      expect(result.stdout).toContain("User C");
      expect(result.stdout).not.toContain("Assistant A");
      expect(result.stdout).not.toContain("Assistant B");
      expect(result.stdout).not.toContain("System msg");
    });
  });

  // ==========================================================================
  // test_range_user_only_is_composable
  // ==========================================================================
  describe("test_range_user_only_is_composable", () => {
    test("--range 1:50 --user-only composes without conflict error", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "1:50",
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      // RED: currently fails with "Cannot use --range and --user-only together"
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("Cannot use --range and --user-only together");
    });

    test("passes range start=1 end=50 AND userOnly=true to service", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      await runReadCommand({
        session: "opencode:personal:session-001",
        range: "1:50",
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(receivedOptions?.selection?.mode).toBe("range");
      expect(receivedOptions?.selection?.start).toBe(1);
      expect(receivedOptions?.selection?.end).toBe(50);
      expect((receivedOptions?.selection as any).userOnly).toBe(true);
    });

    test("returns only user-role messages within range in output", async () => {
      const messages: SessionMessage[] = [
        makeMessage("assistant", "Msg 1 assistant", "msg-1"),
        makeMessage("user", "Msg 2 user", "msg-2"),
        makeMessage("assistant", "Msg 3 assistant", "msg-3"),
        makeMessage("system", "Msg 4 system", "msg-4"),
        makeMessage("user", "Msg 5 user", "msg-5"),
        makeMessage("assistant", "Msg 6 assistant", "msg-6"),
      ];

      const detail = makeSessionDetail({ messages, message_count: 6 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "2:5",
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      // Should contain user messages in range 2:5
      expect(result.stdout).toContain("Msg 2 user");
      expect(result.stdout).toContain("Msg 5 user");
      // Should NOT contain non-user messages in range 2:5
      expect(result.stdout).not.toContain("Msg 1 assistant");
      expect(result.stdout).not.toContain("Msg 3 assistant");
      expect(result.stdout).not.toContain("Msg 4 system");
      expect(result.stdout).not.toContain("Msg 6 assistant");
    });
  });

  // ==========================================================================
  // test_user_only_alone_defaults_to_last_10
  // ==========================================================================
  describe("test_user_only_alone_defaults_to_last_10", () => {
    test("--user-only without other selection flags defaults to last 10 user messages", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      // When --user-only is used alone (no --first/--last/--all/--range):
      // - Primary mode should default to "last"
      // - Count should default to 10
      // - userOnly: true should be present as additive filter
      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.mode).toBe("last");
      expect(receivedOptions?.selection?.count).toBe(10);
      expect((receivedOptions?.selection as any).userOnly).toBe(true);
    });

    test("--user-only alone returns only user messages in stdout", async () => {
      const messages: SessionMessage[] = [
        makeMessage("user", "Last user message 1", "msg-1"),
        makeMessage("assistant", "Should not appear 1", "msg-2"),
        makeMessage("user", "Last user message 2", "msg-3"),
        makeMessage("assistant", "Should not appear 2", "msg-4"),
        makeMessage("user", "Last user message 3", "msg-5"),
      ];

      const detail = makeSessionDetail({ messages, message_count: 5 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Last user message 1");
      expect(result.stdout).toContain("Last user message 2");
      expect(result.stdout).toContain("Last user message 3");
      expect(result.stdout).not.toContain("Should not appear");
    });
  });

  // ==========================================================================
  // test_last_n_alone_returns_all_roles
  // ==========================================================================
  describe("test_last_n_alone_returns_all_roles", () => {
    test("--last N without --user-only returns messages from ALL roles", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        last: 5,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.mode).toBe("last");
      expect(receivedOptions?.selection?.count).toBe(5);
      // When --user-only is NOT set, userOnly should be undefined/false
      expect((receivedOptions?.selection as any).userOnly).toBeFalsy();
    });

    test("--last 10 without --user-only shows all role types in output", async () => {
      const messages: SessionMessage[] = [
        makeMessage("user", "User content", "msg-1"),
        makeMessage("assistant", "Assistant content", "msg-2"),
        makeMessage("system", "System content", "msg-3"),
      ];

      const detail = makeSessionDetail({ messages, message_count: 3 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        last: 10,
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("User content");
      expect(result.stdout).toContain("Assistant content");
      expect(result.stdout).toContain("System content");
    });

    test("--last 5 without --user-only does NOT pass userOnly flag to service", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      await runReadCommand({
        session: "opencode:personal:session-001",
        last: 5,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      // The selection object should NOT have userOnly: true when --user-only is absent
      const sel = receivedOptions?.selection as any;
      expect(sel).not.toBeUndefined();
      expect(sel?.userOnly).toBeUndefined();
    });
  });

  // ==========================================================================
  // Composability edge cases
  // ==========================================================================
  describe("composability edge cases", () => {
    test("--last 1 --user-only composes (single message filter)", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        last: 1,
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedOptions?.selection?.mode).toBe("last");
      expect(receivedOptions?.selection?.count).toBe(1);
      expect((receivedOptions?.selection as any).userOnly).toBe(true);
    });

    test("--last 20 --user-only does NOT create a 'user-only' mode in selection", async () => {
      let receivedOptions: SessionReadOptions | undefined;
      const detail = makeSessionDetail();

      await runReadCommand({
        session: "opencode:personal:session-001",
        last: 20,
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail, (_, opts) => {
          receivedOptions = opts;
        }),
      });

      // The mode must remain "last", not become "user-only"
      // This ensures composability, not mode replacement
      expect(receivedOptions?.selection?.mode).toBe("last");
      expect(receivedOptions?.selection?.mode).not.toBe("user-only");
    });

    test("--first 1 --user-only with exactly one user message returns it", async () => {
      const messages: SessionMessage[] = [
        makeMessage("assistant", "Assistant only", "msg-1"),
      ];

      const detail = makeSessionDetail({ messages, message_count: 1 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        first: 1,
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      // Only assistant message exists; with first=1 --user-only, no user messages exist
      // The adapter/service should return empty selection for user-only within first N
      expect(result.stdout).not.toContain("Assistant only");
    });

    test("--range with --user-only with no user messages in range returns empty", async () => {
      const messages: SessionMessage[] = [
        makeMessage("assistant", "Assistant in range", "msg-1"),
        makeMessage("assistant", "Another assistant", "msg-2"),
      ];

      const detail = makeSessionDetail({ messages, message_count: 2 });

      const result = await runReadCommand({
        session: "opencode:personal:session-001",
        range: "1:2",
        userOnly: true,
        config: baseConfig,
        getSession: makeReadService(detail),
      });

      expect(result.exitCode).toBe(0);
      // No user messages in range 1:2, so nothing should appear
      expect(result.stdout).not.toContain("Assistant in range");
      expect(result.stdout).not.toContain("Another assistant");
    });
  });
});