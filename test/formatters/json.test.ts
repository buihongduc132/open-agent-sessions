import { describe, expect, test } from "bun:test";
import {
  formatSessionsJson,
  formatMessagesJson,
  type JsonFormatterOptions,
} from "../../src/cli/formatters/json";
import { SessionSummary, SessionDetail, SessionMessage, SessionPart } from "../../src/core/types";

// ============================================================================
// Test Fixtures
// ============================================================================

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-001",
    agent: "opencode",
    alias: "personal",
    title: "Test Session",
    created_at: "2026-03-03T13:16:46Z",
    updated_at: "2026-03-03T13:49:20Z",
    message_count: 5,
    storage: "db",
    ...overrides,
  };
}

function makeSessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "session-001",
    agent: "opencode",
    alias: "personal",
    title: "Test Session",
    created_at: "2026-03-03T13:16:46Z",
    updated_at: "2026-03-03T13:49:20Z",
    message_count: 5,
    storage: "db",
    messages: [],
    ...overrides,
  };
}

function makeMessage(
  role: "user" | "assistant" | "system",
  parts: SessionPart[],
  overrides: Partial<SessionMessage> = {}
): SessionMessage {
  return {
    id: "msg-001",
    role,
    created_at: "2026-03-03T13:20:00Z",
    parts,
    ...overrides,
  };
}

function makeTextPart(text: string): SessionPart {
  return { type: "text", text };
}

function makeToolPart(tool: string, status: string = "completed"): SessionPart {
  return { type: "tool", tool, state: { status } };
}

function makeReasoningPart(text: string): SessionPart {
  return { type: "reasoning", text };
}

// ============================================================================
// Tests: Session List Formatting
// ============================================================================

describe("formatSessionsJson", () => {
  test("outputs valid JSON array", () => {
    const sessions = [makeSession(), makeSession({ id: "s2" })];
    const result = formatSessionsJson(sessions);

    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  test("includes all required fields", () => {
    const session = makeSession({
      id: "test-123",
      agent: "codex",
      alias: "work",
      title: "Test Title",
      message_count: 10,
      created_at: "2026-03-03T13:16:46Z",
      updated_at: "2026-03-03T13:49:20Z",
    });
    const result = formatSessionsJson([session]);

    const parsed = JSON.parse(result);
    expect(parsed[0].id).toBe("test-123");
    expect(parsed[0].agent).toBe("codex");
    expect(parsed[0].alias).toBe("work");
    expect(parsed[0].title).toBe("Test Title");
    expect(parsed[0].message_count).toBe(10);
    expect(parsed[0].created_at).toBe("2026-03-03T13:16:46Z");
    expect(parsed[0].updated_at).toBe("2026-03-03T13:49:20Z");
  });

  test("outputs empty array for no sessions", () => {
    const result = formatSessionsJson([]);
    expect(result).toBe("[]\n");
  });

  test("formats single session", () => {
    const session = makeSession({ id: "single-session" });
    const result = formatSessionsJson([session]);

    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("single-session");
  });

  test("formats multiple sessions", () => {
    const sessions = [
      makeSession({ id: "s1", title: "First" }),
      makeSession({ id: "s2", title: "Second" }),
      makeSession({ id: "s3", title: "Third" }),
    ];
    const result = formatSessionsJson(sessions);

    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].id).toBe("s1");
    expect(parsed[1].id).toBe("s2");
    expect(parsed[2].id).toBe("s3");
  });

  test("ends with newline", () => {
    const result = formatSessionsJson([makeSession()]);
    expect(result.endsWith("\n")).toBe(true);
  });

  test("outputs pretty-printed JSON", () => {
    const result = formatSessionsJson([makeSession()]);
    // Pretty-printed JSON should have indentation
    expect(result).toContain("  ");
    expect(result).toContain("\n");
  });

  test("excludes storage field from output", () => {
    const session = makeSession({ storage: "jsonl" });
    const result = formatSessionsJson([session]);

    const parsed = JSON.parse(result);
    expect(parsed[0].storage).toBeUndefined();
  });

  test("handles sessions with empty title", () => {
    const session = makeSession({ title: "" });
    const result = formatSessionsJson([session]);

    const parsed = JSON.parse(result);
    expect(parsed[0].title).toBe("");
  });
});

// ============================================================================
// Tests: Session Detail Formatting
// ============================================================================

describe("formatMessagesJson", () => {
  test("outputs valid JSON with session and messages", () => {
    const detail = makeSessionDetail();
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.session).toBeDefined();
    expect(parsed.messages).toBeDefined();
    expect(Array.isArray(parsed.messages)).toBe(true);
  });

  test("includes all session metadata", () => {
    const detail = makeSessionDetail({
      id: "test-id",
      agent: "codex",
      alias: "work",
      title: "Test Title",
      message_count: 42,
      created_at: "2026-03-03T13:16:46Z",
      updated_at: "2026-03-03T13:49:20Z",
    });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.session.id).toBe("test-id");
    expect(parsed.session.agent).toBe("codex");
    expect(parsed.session.alias).toBe("work");
    expect(parsed.session.title).toBe("Test Title");
    expect(parsed.session.message_count).toBe(42);
    expect(parsed.session.created_at).toBe("2026-03-03T13:16:46Z");
    expect(parsed.session.updated_at).toBe("2026-03-03T13:49:20Z");
  });

  test("includes warning when present", () => {
    const detail = makeSessionDetail({ warning: "This is a warning" });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.session.warning).toBe("This is a warning");
  });

  test("excludes warning when not present", () => {
    const detail = makeSessionDetail();
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.session.warning).toBeUndefined();
  });

  test("includes clone metadata when present", () => {
    const detail = makeSessionDetail({
      clone: {
        src: { agent: "opencode", session_id: "original-session", version: "1.0" },
      },
    });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.session.clone).toBeDefined();
    expect(parsed.session.clone.src.session_id).toBe("original-session");
  });

  test("excludes clone when not present", () => {
    const detail = makeSessionDetail();
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.session.clone).toBeUndefined();
  });

  test("formats empty messages array", () => {
    const detail = makeSessionDetail({ messages: [], message_count: 0 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages).toEqual([]);
  });

  test("formats single message", () => {
    const messages = [makeMessage("user", [makeTextPart("Hello")])];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[0].parts).toHaveLength(1);
  });

  test("formats multiple messages", () => {
    const messages = [
      makeMessage("user", [makeTextPart("Hello")], { id: "msg-1" }),
      makeMessage("assistant", [makeTextPart("Hi!")], { id: "msg-2" }),
      makeMessage("user", [makeTextPart("How are you?")], { id: "msg-3" }),
    ];
    const detail = makeSessionDetail({ messages, message_count: 3 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[0].id).toBe("msg-1");
    expect(parsed.messages[1].id).toBe("msg-2");
    expect(parsed.messages[2].id).toBe("msg-3");
  });

  test("includes message id, role, created_at, and parts", () => {
    const messages = [makeMessage("assistant", [makeTextPart("Response")], { id: "msg-xyz" })];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].id).toBe("msg-xyz");
    expect(parsed.messages[0].role).toBe("assistant");
    expect(parsed.messages[0].created_at).toBe("2026-03-03T13:20:00Z");
    expect(parsed.messages[0].parts).toBeDefined();
  });

  test("includes modelID when present", () => {
    const messages = [makeMessage("assistant", [makeTextPart("Hi")], { modelID: "gpt-4" })];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].modelID).toBe("gpt-4");
  });

  test("excludes modelID when not present", () => {
    const messages = [makeMessage("assistant", [makeTextPart("Hi")])];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].modelID).toBeUndefined();
  });

  test("includes agent when present", () => {
    const messages = [makeMessage("assistant", [makeTextPart("Hi")], { agent: "test-agent" })];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].agent).toBe("test-agent");
  });

  test("excludes agent when not present", () => {
    const messages = [makeMessage("assistant", [makeTextPart("Hi")])];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].agent).toBeUndefined();
  });

  test("ends with newline", () => {
    const detail = makeSessionDetail();
    const result = formatMessagesJson(detail);
    expect(result.endsWith("\n")).toBe(true);
  });

  test("outputs pretty-printed JSON", () => {
    const detail = makeSessionDetail();
    const result = formatMessagesJson(detail);
    expect(result).toContain("  ");
    expect(result).toContain("\n");
  });
});

// ============================================================================
// Tests: Timestamp Normalization
// ============================================================================

describe("timestamp normalization", () => {
  describe("formatSessionsJson timestamp handling", () => {
    test("normalizes ISO-8601 without Z suffix", () => {
      const sessions = [
        makeSession({
          created_at: "2026-03-03T13:16:46",
          updated_at: "2026-03-03T13:49:20",
        }),
      ];
      const result = formatSessionsJson(sessions);

      const parsed = JSON.parse(result);
      // ISO-8601 UTC format (with optional milliseconds)
      expect(parsed[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
      expect(parsed[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    });

    test("normalizes Unix timestamp (milliseconds)", () => {
      const sessions = [
        makeSession({
          created_at: 1709474206000 as unknown as string, // 2024-03-03T13:16:46Z
          updated_at: 1709476160000 as unknown as string, // 2024-03-03T13:49:20Z
        }),
      ];
      const result = formatSessionsJson(sessions);

      const parsed = JSON.parse(result);
      expect(parsed[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
      expect(parsed[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    });

    test("passes through already normalized ISO-8601 UTC", () => {
      const sessions = [
        makeSession({
          created_at: "2026-03-03T13:16:46Z",
          updated_at: "2026-03-03T13:49:20Z",
        }),
      ];
      const result = formatSessionsJson(sessions);

      const parsed = JSON.parse(result);
      expect(parsed[0].created_at).toBe("2026-03-03T13:16:46Z");
      expect(parsed[0].updated_at).toBe("2026-03-03T13:49:20Z");
    });
  });

  describe("formatMessagesJson timestamp handling", () => {
    test("normalizes session timestamps", () => {
      const detail = makeSessionDetail({
        created_at: "2026-03-03T13:16:46", // No Z suffix
        updated_at: 1709476160000 as unknown as string, // Unix timestamp
      });
      const result = formatMessagesJson(detail);

      const parsed = JSON.parse(result);
      expect(parsed.session.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
      expect(parsed.session.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    });

    test("normalizes message timestamps", () => {
      const messages = [
        makeMessage("user", [makeTextPart("Hello")], { 
          created_at: "2026-03-03T14:30:00" // No Z suffix
        }),
        makeMessage("assistant", [makeTextPart("Hi")], { 
          created_at: 1709476200000 as unknown as string // Unix timestamp
        }),
      ];
      const detail = makeSessionDetail({ messages, message_count: 2 });
      const result = formatMessagesJson(detail);

      const parsed = JSON.parse(result);
      expect(parsed.messages[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
      expect(parsed.messages[1].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    });

    test("passes through already normalized timestamps", () => {
      const messages = [
        makeMessage("user", [makeTextPart("Hello")], { 
          created_at: "2026-03-03T14:30:00Z"
        }),
      ];
      const detail = makeSessionDetail({ 
        messages, 
        message_count: 1,
        created_at: "2026-03-03T13:16:46Z",
        updated_at: "2026-03-03T13:49:20Z",
      });
      const result = formatMessagesJson(detail);

      const parsed = JSON.parse(result);
      expect(parsed.session.created_at).toBe("2026-03-03T13:16:46Z");
      expect(parsed.session.updated_at).toBe("2026-03-03T13:49:20Z");
      expect(parsed.messages[0].created_at).toBe("2026-03-03T14:30:00Z");
    });
  });
});

// ============================================================================
// Tests: Timestamp Format (ISO-8601 UTC)
// ============================================================================

describe("timestamp format", () => {
  test("session created_at is in ISO-8601 UTC format", () => {
    const detail = makeSessionDetail({
      created_at: "2026-03-03T13:16:46Z",
    });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.session.created_at).toBe("2026-03-03T13:16:46Z");
    // Validate ISO-8601 UTC format: YYYY-MM-DDTHH:MM:SSZ
    expect(parsed.session.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("session updated_at is in ISO-8601 UTC format", () => {
    const detail = makeSessionDetail({
      updated_at: "2026-03-03T13:49:20Z",
    });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.session.updated_at).toBe("2026-03-03T13:49:20Z");
    expect(parsed.session.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("message created_at is in ISO-8601 UTC format", () => {
    const messages = [makeMessage("user", [makeTextPart("Hello")], { created_at: "2026-03-03T14:30:00Z" })];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].created_at).toBe("2026-03-03T14:30:00Z");
    expect(parsed.messages[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("session list timestamps are in ISO-8601 UTC format", () => {
    const sessions = [
      makeSession({
        created_at: "2026-03-03T13:16:46Z",
        updated_at: "2026-03-03T13:49:20Z",
      }),
    ];
    const result = formatSessionsJson(sessions);

    const parsed = JSON.parse(result);
    expect(parsed[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(parsed[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

// ============================================================================
// Tests: Tool Visibility
// ============================================================================

describe("tool visibility handling", () => {
  test("hides tool parts by default", () => {
    const messages = [
      makeMessage("assistant", [
        makeTextPart("Hello"),
        makeToolPart("bash", "completed"),
        makeTextPart("Done"),
      ]),
    ];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].parts).toHaveLength(2);
    expect(parsed.messages[0].parts[0].type).toBe("text");
    expect(parsed.messages[0].parts[1].type).toBe("text");
  });

  test("shows tool parts with includeTools option", () => {
    const messages = [
      makeMessage("assistant", [
        makeTextPart("Hello"),
        makeToolPart("bash", "completed"),
        makeTextPart("Done"),
      ]),
    ];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail, { includeTools: true });

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].parts).toHaveLength(3);
    expect(parsed.messages[0].parts[0].type).toBe("text");
    expect(parsed.messages[0].parts[1].type).toBe("tool");
    expect(parsed.messages[0].parts[2].type).toBe("text");
  });

  test("filters all tool parts when multiple tools present", () => {
    const messages = [
      makeMessage("assistant", [
        makeTextPart("Start"),
        makeToolPart("bash", "completed"),
        makeToolPart("read", "completed"),
        makeToolPart("write", "running"),
        makeTextPart("End"),
      ]),
    ];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].parts).toHaveLength(2);
    expect(parsed.messages[0].parts.every((p: SessionPart) => p.type !== "tool")).toBe(true);
  });

  test("includes all tool parts with includeTools option when multiple tools present", () => {
    const messages = [
      makeMessage("assistant", [
        makeTextPart("Start"),
        makeToolPart("bash", "completed"),
        makeToolPart("read", "completed"),
        makeTextPart("End"),
      ]),
    ];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail, { includeTools: true });

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].parts).toHaveLength(4);
    const toolParts = parsed.messages[0].parts.filter((p: SessionPart) => p.type === "tool");
    expect(toolParts).toHaveLength(2);
  });

  test("message with only tool parts becomes empty when tools hidden", () => {
    const messages = [
      makeMessage("assistant", [
        makeToolPart("bash", "completed"),
        makeToolPart("read", "completed"),
      ]),
    ];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].parts).toHaveLength(0);
  });

  test("message with only tool parts includes them with includeTools option", () => {
    const messages = [
      makeMessage("assistant", [
        makeToolPart("bash", "completed"),
        makeToolPart("read", "completed"),
      ]),
    ];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail, { includeTools: true });

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].parts).toHaveLength(2);
  });

  test("tool part includes full state object", () => {
    const messages = [
      makeMessage("assistant", [
        makeToolPart("bash", "completed"),
      ]),
    ];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail, { includeTools: true });

    const parsed = JSON.parse(result);
    const toolPart = parsed.messages[0].parts[0];
    expect(toolPart.type).toBe("tool");
    expect(toolPart.tool).toBe("bash");
    expect(toolPart.state).toEqual({ status: "completed" });
  });

  test("preserves reasoning parts regardless of tool visibility", () => {
    const messages = [
      makeMessage("assistant", [
        makeReasoningPart("Thinking..."),
        makeToolPart("bash", "completed"),
        makeTextPart("Done"),
      ]),
    ];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    
    // Without tools
    const resultNoTools = formatMessagesJson(detail);
    const parsedNoTools = JSON.parse(resultNoTools);
    expect(parsedNoTools.messages[0].parts).toHaveLength(2);
    expect(parsedNoTools.messages[0].parts[0].type).toBe("reasoning");
    
    // With tools
    const resultWithTools = formatMessagesJson(detail, { includeTools: true });
    const parsedWithTools = JSON.parse(resultWithTools);
    expect(parsedWithTools.messages[0].parts).toHaveLength(3);
  });
});

// ============================================================================
// Tests: Multiple Messages with Different Roles
// ============================================================================

describe("messages with different roles", () => {
  test("formats user message correctly", () => {
    const messages = [makeMessage("user", [makeTextPart("Hello")], { id: "msg-user" })];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[0].id).toBe("msg-user");
  });

  test("formats assistant message correctly", () => {
    const messages = [makeMessage("assistant", [makeTextPart("Hi!")], { id: "msg-assistant" })];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].role).toBe("assistant");
    expect(parsed.messages[0].id).toBe("msg-assistant");
  });

  test("formats system message correctly", () => {
    const messages = [makeMessage("system", [makeTextPart("System message")], { id: "msg-system" })];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].role).toBe("system");
    expect(parsed.messages[0].id).toBe("msg-system");
  });

  test("preserves message order", () => {
    const messages = [
      makeMessage("system", [makeTextPart("Init")], { id: "msg-1" }),
      makeMessage("user", [makeTextPart("Q1")], { id: "msg-2" }),
      makeMessage("assistant", [makeTextPart("A1")], { id: "msg-3" }),
      makeMessage("user", [makeTextPart("Q2")], { id: "msg-4" }),
      makeMessage("assistant", [makeTextPart("A2")], { id: "msg-5" }),
    ];
    const detail = makeSessionDetail({ messages, message_count: 5 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].id).toBe("msg-1");
    expect(parsed.messages[1].id).toBe("msg-2");
    expect(parsed.messages[2].id).toBe("msg-3");
    expect(parsed.messages[3].id).toBe("msg-4");
    expect(parsed.messages[4].id).toBe("msg-5");
  });
});

// ============================================================================
// Tests: Edge Cases
// ============================================================================

describe("edge cases", () => {
  test("handles messages with undefined parts array", () => {
    const detail = makeSessionDetail({ messages: undefined, message_count: 0 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages).toEqual([]);
  });

  test("handles message with empty parts array", () => {
    const messages = [makeMessage("user", [])];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].parts).toEqual([]);
  });

  test("handles special characters in text content", () => {
    const messages = [
      makeMessage("user", [makeTextPart('Hello "world" with \n newlines and \t tabs')]),
    ];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    // Should parse without errors
    const parsed = JSON.parse(result);
    expect(parsed.messages[0].parts[0].text).toContain('"world"');
    expect(parsed.messages[0].parts[0].text).toContain('\n');
    expect(parsed.messages[0].parts[0].text).toContain('\t');
  });

  test("handles unicode characters in text content", () => {
    const messages = [
      makeMessage("user", [makeTextPart("Hello 世界 🌍 مرحبا")]),
    ];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].parts[0].text).toBe("Hello 世界 🌍 مرحبا");
  });

  test("handles very long text content", () => {
    const longText = "A".repeat(10000);
    const messages = [makeMessage("user", [makeTextPart(longText)])];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].parts[0].text).toBe(longText);
    expect(parsed.messages[0].parts[0].text.length).toBe(10000);
  });

  test("handles empty string values", () => {
    const detail = makeSessionDetail({
      id: "",
      title: "",
    });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.session.id).toBe("");
    expect(parsed.session.title).toBe("");
  });

  test("handles zero message count", () => {
    const detail = makeSessionDetail({ message_count: 0, messages: [] });
    const result = formatMessagesJson(detail);

    const parsed = JSON.parse(result);
    expect(parsed.session.message_count).toBe(0);
    expect(parsed.messages).toEqual([]);
  });
});

// ============================================================================
// Tests: JSON Validity
// ============================================================================

describe("JSON validity", () => {
  test("formatSessionsJson produces valid JSON", () => {
    const sessions = [
      makeSession(),
      makeSession({ id: "s2", title: 'Test with "quotes"' }),
    ];
    const result = formatSessionsJson(sessions);

    // Should not throw
    expect(() => JSON.parse(result)).not.toThrow();
  });

  test("formatMessagesJson produces valid JSON", () => {
    const messages = [
      makeMessage("user", [makeTextPart('Test with "quotes" and \n newlines')]),
      makeMessage("assistant", [makeTextPart("Response")]),
    ];
    const detail = makeSessionDetail({ messages, message_count: 2 });
    const result = formatMessagesJson(detail);

    // Should not throw
    expect(() => JSON.parse(result)).not.toThrow();
  });

  test("handles nested JSON in tool state", () => {
    const messages = [
      makeMessage("assistant", [
        {
          type: "tool",
          tool: "complex",
          state: {
            status: "completed",
            result: { nested: { deep: "value" }, array: [1, 2, 3] },
          },
        },
      ]),
    ];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatMessagesJson(detail, { includeTools: true });

    const parsed = JSON.parse(result);
    expect(parsed.messages[0].parts[0].state.result.nested.deep).toBe("value");
    expect(parsed.messages[0].parts[0].state.result.array).toEqual([1, 2, 3]);
  });
});
