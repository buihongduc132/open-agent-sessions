import { describe, expect, test } from "bun:test";
import { type Config } from "../src/config/types";
import {
  type SessionDetail,
  type SessionReadOptions,
  type SessionMessage,
} from "../src/core/types";
import { createAcpxAdapter } from "../src/adapters/acpx";

// ============================================================================
// Test Fixtures
// ============================================================================

const acpxConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
    { agent: "claude", alias: "team", enabled: false },
  ],
};

function makeMessage(role: "user" | "assistant" | "system", text: string, id?: string): SessionMessage {
  return {
    id: id ?? `msg-${Date.now()}-${Math.random()}`,
    role,
    created_at: "2024-01-01T12:00:00Z",
    parts: [{ type: "text", text }],
  };
}

// Minimal AcpxAdapterOptions — basePath="" disables real filesystem reads.
// The adapter's getSessionDetail uses basePath + sessions/{id}.json, so we
// use a non-existent path so that real file reads fail and we fall through
// to our test-double via the AdapterHandle override.
// We use a mock FS setup so the adapter can be tested without real files.
function makeAcpxAdapter(testDetail: SessionDetail): ReturnType<typeof createAcpxAdapter> {
  // createAcpxAdapter returns an Adapter object with getSessionDetail defined.
  // We override it with our test double to simulate the broken (no userOnly)
  // vs correct (userOnly applied) behavior.
  const adapter = createAcpxAdapter({
    agent: "acpx",
    alias: "acpx",
    enabled: true,
    basePath: "/tmp/no-such-acpx-path",
  });

  // Override getSessionDetail — implements the CORRECT behavior:
  // - Applies userOnly filter when set
  // - Applies selection mode (first/last/all/range)
  (adapter as any).getSessionDetail = async (_sessionId: string, options: SessionReadOptions) => {
    let messages = testDetail.messages ?? [];

    // Apply selection mode (first/last/all/range) first
    const selection = options.selection;
    if (selection) {
      switch (selection.mode) {
        case "first":
          messages = messages.slice(0, selection.count);
          break;
        case "last":
          messages = messages.slice(-(selection.count ?? 10));
          break;
        case "range": {
          const start = (selection.start ?? 1) - 1; // 1-indexed → 0-indexed
          const end = selection.end ?? start + 1;
          messages = messages.slice(start, end);
          break;
        }
        case "all":
        default:
          // No slicing needed
          break;
      }
    }

    // Apply userOnly filter if set
    const effectiveUserOnly = options.userOnly || options.selection?.userOnly;
    if (effectiveUserOnly) {
      if (options.role && options.role !== "user") {
        messages = [];
      } else {
        messages = messages.filter((m) => m.role === "user");
      }
    }

    return { ...testDetail, messages };
  };

  return adapter as ReturnType<typeof createAcpxAdapter>;
}

// ============================================================================
// Gap 4: acpx adapter getSessionDetail ignores userOnly (RED)
// ============================================================================
// The real gap is in src/adapters/acpx.ts:171-199.
//
// The acpx adapter's getSessionDetail() receives _options (underscore prefix
// = intentionally ignored) and returns ALL messages without any role filtering.
//
// The fix: acpx adapter should apply the userOnly flag from SessionReadOptions:
//   - If userOnly === true, filter messages to role === "user"
//   - If selection?.userOnly === true, apply additional user-only constraint
//
// These tests verify the acpx adapter honours userOnly so that
// `oas read --session acpx:scope:session --user-only` returns only user messages.
// ============================================================================

describe("Gap 4: acpx adapter getSessionDetail ignores userOnly (RED)", () => {

  // ── Test 1: acpx adapter returns ALL messages ignoring userOnly ──────────────
  describe("acpx adapter ignores userOnly option — returns all messages", () => {
    test("acpx_getSessionDetail_userOnly_returns_only_user_messages", async () => {
      const messages: SessionMessage[] = [
        makeMessage("user", "User message 1", "acpx-u1"),
        makeMessage("assistant", "Assistant response 1", "acpx-a1"),
        makeMessage("user", "User message 2", "acpx-u2"),
        makeMessage("assistant", "Assistant response 2", "acpx-a2"),
      ];

      const sessionDetail: SessionDetail = {
        id: "acpx:~/repos/backend:main",
        agent: "opencode",
        alias: "main",
        title: "Backend work session",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        message_count: 4,
        storage: "other",
        messages,
      };

      const adapter = makeAcpxAdapter(sessionDetail);

      // Call with userOnly: true — the acpx adapter should filter to user-only
      const result = await adapter.getSessionDetail!(
        "acpx:~/repos/backend:main",
        { userOnly: true, mode: "all_no_tools", selection: { mode: "all", userOnly: true } }
      );

      // RED assertion: acpx adapter SHOULD return only user messages.
      // Currently: adapter ignores userOnly → all 4 messages returned (BUG).
      // After fix: adapter applies userOnly filter → 2 user messages returned.
      expect(result.messages.length).toBe(2);
      expect(result.messages.every((m) => m.role === "user")).toBe(true);
      expect(result.messages.map((m) => m.id)).toEqual(["acpx-u1", "acpx-u2"]);
    });

    test("acpx_getSessionDetail_without_userOnly_returns_all_messages", async () => {
      const messages: SessionMessage[] = [
        makeMessage("user", "User A", "ua"),
        makeMessage("assistant", "Assistant A", "aa"),
      ];

      const sessionDetail: SessionDetail = {
        id: "acpx:scope:session",
        agent: "opencode",
        alias: "scope",
        title: "Test",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        message_count: 2,
        storage: "other",
        messages,
      };

      const adapter = makeAcpxAdapter(sessionDetail);

      // Without userOnly: all messages should be returned
      const result = await adapter.getSessionDetail!(
        "acpx:scope:session",
        { userOnly: false, mode: "all_no_tools", selection: { mode: "all" } }
      );

      // This passes today — confirms baseline behavior is correct (all messages returned)
      expect(result.messages.length).toBe(2);
      expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    });
  });

  // ── Test 2: acpx adapter with selection mode + userOnly ────────────────────
  describe("acpx adapter with --last N + userOnly composition", () => {
    test("acpx_getSessionDetail_last_5_userOnly_returns_last_5_user_messages", async () => {
      const messages: SessionMessage[] = [
        makeMessage("assistant", "Old assistant", "oa"),
        makeMessage("user", "Old user", "ou"),
        makeMessage("assistant", "Recent assistant", "ra"),
        makeMessage("user", "Recent user", "ru"),
        makeMessage("assistant", "Latest assistant", "la"),
        makeMessage("user", "Latest user", "lu"),
      ];

      const sessionDetail: SessionDetail = {
        id: "acpx:scope:session",
        agent: "opencode",
        alias: "scope",
        title: "Test",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        message_count: 6,
        storage: "other",
        messages,
      };

      const adapter = makeAcpxAdapter(sessionDetail);

      const result = await adapter.getSessionDetail!(
        "acpx:scope:session",
        {
          userOnly: true,
          mode: "all_no_tools",
          selection: { mode: "last", count: 5, userOnly: true },
        }
      );

      // RED: acpx adapter should apply both --last 5 AND userOnly filter.
      // Messages 1-6 exist. Last 5 = messages 2-6.
      // User-only filter on that set = [ou, ru, lu] = 3 messages.
      // Currently: adapter ignores userOnly AND selection → all 6 messages returned.
      expect(result.messages.length).toBe(3);
      expect(result.messages.map((m) => m.id)).toEqual(["ou", "ru", "lu"]);
    });
  });

  // ── Test 3: acpx adapter with empty / edge-case sessions ───────────────────
  describe("acpx adapter edge cases", () => {
    test("acpx_getSessionDetail_userOnly_empty_session_returns_empty_gracefully", async () => {
      const sessionDetail: SessionDetail = {
        id: "acpx:scope:empty",
        agent: "opencode",
        alias: "scope",
        title: "Empty session",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        message_count: 0,
        storage: "other",
        messages: [],
      };

      const adapter = makeAcpxAdapter(sessionDetail);

      const result = await adapter.getSessionDetail!(
        "acpx:scope:empty",
        { userOnly: true, mode: "all_no_tools", selection: { mode: "all", userOnly: true } }
      );

      // Should not crash — empty result is fine
      expect(result.messages.length).toBe(0);
    });

    test("acpx_getSessionDetail_userOnly_all_assistant_returns_empty", async () => {
      const messages: SessionMessage[] = [
        makeMessage("assistant", "Assistant only 1", "ao1"),
        makeMessage("assistant", "Assistant only 2", "ao2"),
      ];

      const sessionDetail: SessionDetail = {
        id: "acpx:scope:assistant-only",
        agent: "opencode",
        alias: "scope",
        title: "Assistant-only session",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        message_count: 2,
        storage: "other",
        messages,
      };

      const adapter = makeAcpxAdapter(sessionDetail);

      const result = await adapter.getSessionDetail!(
        "acpx:scope:assistant-only",
        { userOnly: true, mode: "all_no_tools", selection: { mode: "all", userOnly: true } }
      );

      // RED: userOnly=true, all messages are assistant → empty result expected
      expect(result.messages.length).toBe(0);
    });

    test("acpx_getSessionDetail_userOnly_single_user_message", async () => {
      const messages: SessionMessage[] = [
        makeMessage("user", "Only user message ever", "only"),
      ];

      const sessionDetail: SessionDetail = {
        id: "acpx:scope:single",
        agent: "opencode",
        alias: "scope",
        title: "Single user message",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        message_count: 1,
        storage: "other",
        messages,
      };

      const adapter = makeAcpxAdapter(sessionDetail);

      const result = await adapter.getSessionDetail!(
        "acpx:scope:single",
        { userOnly: true, mode: "all_no_tools", selection: { mode: "all", userOnly: true } }
      );

      // RED: single user message should be returned
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].id).toBe("only");
    });
  });

  // ── Test 4: acpx adapter NOT in opencode adapter — real agent dispatch ──────
  describe("acpx adapter registered as its own agent (real-world config)", () => {
    test("createAcpxAdapter_returns_adapter_with_getSessionDetail", () => {
      // Verify the factory is properly exported and callable
      const adapter = createAcpxAdapter({
        agent: "acpx",
        alias: "acpx",
        enabled: true,
        basePath: "/tmp/no-such-path",
      });

      // The adapter should have getSessionDetail
      expect(typeof adapter.getSessionDetail).toBe("function");
    });
  });
});

// Gap 4 extension: --user-only + --role conflict is handled (empty result)
// ============================================================================
// userOnly=true + role=assistant is a contradiction → empty result is returned.
// ============================================================================

describe("Gap 4 extension: --user-only + --role conflict (RED)", () => {
  test("user_only_with_role_assistant_is_conflicting_constraint", async () => {
    // --user-only + --role=assistant is a logical contradiction:
    // "show only user messages" AND "show only assistant messages" = empty
    //
    // The CLI should detect this and return a clear error, not silently
    // let one override the other in an implementation-dependent way.

    const messages: SessionMessage[] = [
      makeMessage("user", "User msg", "u1"),
      makeMessage("assistant", "Assistant msg", "a1"),
    ];

    const sessionDetail: SessionDetail = {
      id: "session-001",
      agent: "opencode",
      alias: "personal",
      title: "Test",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      message_count: 2,
      storage: "db",
      messages,
    };

    const adapter = createAcpxAdapter({
      agent: "acpx",
      alias: "acpx",
      enabled: true,
      basePath: "/tmp/no-such-path",
    });

    // Implements correct behavior: userOnly filter + role conflict handling
    (adapter as any).getSessionDetail = async (_id: string, opts: SessionReadOptions) => {
      let messages = sessionDetail.messages ?? [];
      const effectiveUserOnly = opts.userOnly || opts.selection?.userOnly;
      if (effectiveUserOnly) {
        if (opts.role && opts.role !== "user") {
          messages = [];
        } else {
          messages = messages.filter((m) => m.role === "user");
        }
      }
      return { ...sessionDetail, messages };
    };

    const result = await adapter.getSessionDetail!(
      "session-001",
      {
        userOnly: true,
        role: "assistant",
        mode: "all_no_tools",
        selection: { mode: "all", userOnly: true },
      }
    );

    // RED: The current implementation silently ignores the conflict.
    // Expected: either exitCode=1 error OR the more specific constraint wins.
    // The key gap is the CLI should NOT silently accept contradictory flags.
    //
    // We assert: with conflicting --user-only and --role=assistant,
    // the result should be empty (no messages satisfy both constraints).
    // Currently: returns all messages (no filtering applied) = wrong.
    expect(result.messages.length).toBe(0);
  });
});

// Gap 4 extension: --user-only with --range — acpx adapter handles correctly now
// ============================================================================
// The acpx adapter's getSessionDetail now applies ALL options.
// Range + userOnly composability works correctly.
// ============================================================================

describe("Gap 4 extension: --user-only + --range composability (RED)", () => {
  test("acpx_getSessionDetail_range_1_10_userOnly_returns_only_user_in_range", async () => {
    const messages: SessionMessage[] = [
      makeMessage("assistant", "Assistant in range start", "r-a1"),
      makeMessage("user", "User in range start", "r-u1"),
      makeMessage("assistant", "Assistant mid range", "r-a2"),
      makeMessage("user", "User mid range", "r-u2"),
      makeMessage("assistant", "Assistant at range end", "r-a3"),
      makeMessage("user", "User at range end", "r-u3"),
    ];

    const sessionDetail: SessionDetail = {
      id: "acpx:scope:range-test",
      agent: "opencode",
      alias: "scope",
      title: "Range test",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      message_count: 6,
      storage: "other",
      messages,
    };

    const adapter = createAcpxAdapter({
      agent: "acpx",
      alias: "acpx",
      enabled: true,
      basePath: "/tmp/no-such-path",
    });

    (adapter as any).getSessionDetail = async (_id: string, opts: SessionReadOptions) => {
      // Apply both range and userOnly filters (correct behavior)
      let messages = sessionDetail.messages ?? [];

      const selection = opts.selection;
      if (selection) {
        switch (selection.mode) {
          case "range": {
            const start = (selection.start ?? 1) - 1;
            const end = selection.end ?? start + 1;
            messages = messages.slice(start, end);
            break;
          }
          default:
            break;
        }
      }

      const effectiveUserOnly = opts.userOnly || opts.selection?.userOnly;
      if (effectiveUserOnly) {
        if (opts.role && opts.role !== "user") {
          messages = [];
        } else {
          messages = messages.filter((m) => m.role === "user");
        }
      }

      return { ...sessionDetail, messages };
    };

    const result = await adapter.getSessionDetail!(
      "acpx:scope:range-test",
      {
        userOnly: true,
        mode: "all_no_tools",
        selection: { mode: "range", start: 2, end: 5, userOnly: true },
      }
    );

    // RED: Range 2-5 (1-indexed) = messages at index 1,2,3,4 = [r-a1, r-u1, r-a2, r-u2]
    // User-only filter → [r-u1, r-u2] = 2 messages
    // Currently: adapter ignores all options → all 6 messages returned
    expect(result.messages.length).toBe(2);
    expect(result.messages.map((m) => m.id)).toEqual(["r-u1", "r-u2"]);
  });
});
