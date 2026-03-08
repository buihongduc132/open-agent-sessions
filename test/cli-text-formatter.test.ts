import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  formatSessionRow,
  formatSessionsTable,
  formatSessionsJson,
  formatSessionDetail,
  formatSessionDetailJson,
  formatMessage,
  formatPart,
  formatRelativeTime,
  formatLocalTimestamp,
  formatLocalDate,
  truncateId,
  truncateText,
  formatErrors,
  type ReadQuery,
  type TextFormatterOptions,
} from "../src/cli/formatters/text";
import { SessionSummary, SessionDetail, SessionMessage, SessionPart } from "../src/core/types";

// ============================================================================
// Test Fixtures
// ============================================================================

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-001",
    agent: "opencode",
    alias: "personal",
    title: "Test Session",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 5,
    storage: "db",
    ...overrides,
  };
}

function makeReadQuery(overrides: Partial<ReadQuery> = {}): ReadQuery {
  return {
    agent: "opencode",
    alias: "personal",
    id: "session-001",
    ...overrides,
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

function makeMessage(role: "user" | "assistant" | "system", text: string, overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: "msg-001",
    role,
    created_at: "2024-01-01T12:00:00Z",
    parts: [{ type: "text", text }],
    ...overrides,
  };
}

// ============================================================================
// Tests: Session List Formatting
// ============================================================================

describe("formatSessionRow", () => {
  test("formats session with title", () => {
    const session = makeSession({ title: "My Session" });
    const result = formatSessionRow(session);
    
    expect(result).toContain("[opencode:personal]");
    expect(result).toContain("My Session");
    expect(result).toContain("session-001");
    expect(result).toContain("msg");
  });

  test("formats session without title (uses ID)", () => {
    const session = makeSession({ title: "" });
    const result = formatSessionRow(session);
    
    expect(result).toContain("[opencode:personal]");
    expect(result).toContain("session-001");
  });

  test("truncates long IDs", () => {
    const session = makeSession({ id: "very-long-session-id-that-should-be-truncated-for-readability" });
    const result = formatSessionRow(session);
    
    // ID is truncated to 20 chars + "..."
    expect(result).toContain("very-long-session-id...");
    expect(result).not.toContain("that-should-be-truncated");
  });

  test("truncates long titles", () => {
    const session = makeSession({ 
      title: "This is a very long title that should be truncated to fit within the display width" 
    });
    const result = formatSessionRow(session);
    
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(200);
  });

  test("includes message count", () => {
    const session = makeSession({ message_count: 42 });
    const result = formatSessionRow(session);
    
    expect(result).toContain("42");
    expect(result).toContain("msg");
  });

  test("aligns columns properly with different data", () => {
    const session1 = makeSession({ id: "short", title: "Short", message_count: 1 });
    const session2 = makeSession({ id: "very-long-id-here", title: "A Much Longer Title Here", message_count: 1000 });
    
    const result1 = formatSessionRow(session1);
    const result2 = formatSessionRow(session2);
    
    // Both should have consistent formatting structure
    expect(result1).toContain("msg");
    expect(result2).toContain("msg");
  });
});

describe("formatSessionsTable", () => {
  test("formats empty sessions list", () => {
    const result = formatSessionsTable([]);
    expect(result).toBe("No sessions found.\n");
  });

  test("formats single session", () => {
    const sessions = [makeSession({ title: "Single" })];
    const result = formatSessionsTable(sessions);
    
    expect(result).toContain("Single");
    expect(result).toContain("session-001");
    expect(result.endsWith("\n")).toBe(true);
  });

  test("formats multiple sessions", () => {
    const sessions = [
      makeSession({ id: "s1", title: "First" }),
      makeSession({ id: "s2", title: "Second" }),
      makeSession({ id: "s3", title: "Third" }),
    ];
    const result = formatSessionsTable(sessions);
    
    expect(result).toContain("First");
    expect(result).toContain("Second");
    expect(result).toContain("Third");
    expect(result.split("\n").filter(l => l.length > 0)).toHaveLength(3);
  });
});

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
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      storage: "jsonl",
    });
    const result = formatSessionsJson([session]);
    
    const parsed = JSON.parse(result);
    expect(parsed[0].id).toBe("test-123");
    expect(parsed[0].agent).toBe("codex");
    expect(parsed[0].alias).toBe("work");
    expect(parsed[0].title).toBe("Test Title");
    expect(parsed[0].message_count).toBe(10);
    expect(parsed[0].created_at).toBe("2024-01-01T00:00:00Z");
    expect(parsed[0].updated_at).toBe("2024-01-02T00:00:00Z");
    expect(parsed[0].storage).toBe("jsonl");
  });

  test("outputs empty array for no sessions", () => {
    const result = formatSessionsJson([]);
    expect(result).toBe("[]\n");
  });
});

// ============================================================================
// Tests: Session Detail Formatting
// ============================================================================

describe("formatSessionDetail", () => {
  test("formats session header with all fields", () => {
    const detail = makeSessionDetail();
    const target = makeReadQuery();
    const result = formatSessionDetail(detail, target);
    
    expect(result).toContain("Session [opencode:personal]");
    expect(result).toContain("id: session-001");
    expect(result).toContain("title: Test Session");
    expect(result).toContain("created_at: 2024-01-01 00:00:00");
    expect(result).toContain("updated_at: 2024-01-02 00:00:00");
    expect(result).toContain("message_count: 5");
    expect(result).toContain("storage: db");
  });

  test("uses ID as title when title is empty", () => {
    const detail = makeSessionDetail({ title: "" });
    const target = makeReadQuery();
    const result = formatSessionDetail(detail, target);
    
    expect(result).toContain("title: session-001");
  });

  test("shows warning when present", () => {
    const detail = makeSessionDetail({ warning: "This is a warning" });
    const target = makeReadQuery();
    const result = formatSessionDetail(detail, target);
    
    expect(result).toContain("Warning:");
    expect(result).toContain("This is a warning");
  });

  test("shows messages when present", () => {
    const messages = [makeMessage("user", "Hello")];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const target = makeReadQuery();
    const result = formatSessionDetail(detail, target);
    
    expect(result).toContain("Messages (1):");
    expect(result).toContain("Hello");
  });

  test("hides messages section when no messages", () => {
    const detail = makeSessionDetail({ messages: [], message_count: 0 });
    const target = makeReadQuery();
    const result = formatSessionDetail(detail, target);
    
    expect(result).not.toContain("Messages (");
  });
});

describe("formatSessionDetailJson", () => {
  test("outputs valid JSON with session and messages", () => {
    const messages = [makeMessage("user", "Hello")];
    const detail = makeSessionDetail({ messages, message_count: 1 });
    const result = formatSessionDetailJson(detail);
    
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
      warning: "Warning message",
    });
    const result = formatSessionDetailJson(detail);
    
    const parsed = JSON.parse(result);
    expect(parsed.session.id).toBe("test-id");
    expect(parsed.session.agent).toBe("codex");
    expect(parsed.session.alias).toBe("work");
    expect(parsed.session.title).toBe("Test Title");
    expect(parsed.session.warning).toBe("Warning message");
  });
});

// ============================================================================
// Tests: Message Formatting
// ============================================================================

describe("formatMessage", () => {
  test("formats user message with role badge", () => {
    const message = makeMessage("user", "Hello world");
    const result = formatMessage(message);
    
    expect(result.join("\n")).toContain("USER");
    expect(result.join("\n")).toContain("Hello world");
  });

  test("formats assistant message with role badge", () => {
    const message = makeMessage("assistant", "Hi there!");
    const result = formatMessage(message);
    
    expect(result.join("\n")).toContain("ASSISTANT");
    expect(result.join("\n")).toContain("Hi there!");
  });

  test("formats system message with role badge", () => {
    const message = makeMessage("system", "System message");
    const result = formatMessage(message);
    
    expect(result.join("\n")).toContain("SYSTEM");
    expect(result.join("\n")).toContain("System message");
  });

  test("includes timestamp", () => {
    const message = makeMessage("user", "Hello");
    const result = formatMessage(message);

    expect(result.join("\n")).toContain("2024-01-01 12:00:00");
  });

  test("includes agent/model when present", () => {
    const message = makeMessage("assistant", "Hello", {
      agent: "test-agent",
      modelID: "test-model",
    });
    const result = formatMessage(message);
    
    expect(result.join("\n")).toContain("test-agent");
    expect(result.join("\n")).toContain("test-model");
  });

  test("indents text content", () => {
    const message = makeMessage("user", "Line 1\nLine 2\nLine 3");
    const result = formatMessage(message);
    
    // All content lines should be indented
    const contentLines = result.filter(l => l.includes("Line"));
    for (const line of contentLines) {
      expect(line.startsWith("  ")).toBe(true);
    }
  });
});

// ============================================================================
// Tests: Part Formatting
// ============================================================================

describe("formatPart", () => {
  describe("text parts", () => {
    test("indents single line text", () => {
      const part: SessionPart = { type: "text", text: "Hello" };
      const result = formatPart(part);
      
      expect(result).toEqual(["  Hello"]);
    });

    test("indents multi-line text", () => {
      const part: SessionPart = { type: "text", text: "Line 1\nLine 2" };
      const result = formatPart(part);
      
      expect(result).toEqual(["  Line 1", "  Line 2"]);
    });

    test("trims whitespace", () => {
      const part: SessionPart = { type: "text", text: "  Hello  \n  World  " };
      const result = formatPart(part);
      
      // formatPart trims the text first, then splits by newlines and indents
      // After trim: "Hello  \n  World" - leading/trailing removed, inner whitespace preserved
      // After split by "\n": ["Hello  ", "  World"]
      // After map with "  " prefix: ["  Hello  ", "    World"]
      expect(result).toEqual(["  Hello  ", "    World"]);
    });
  });

  describe("tool parts", () => {
    test("hides tool by default", () => {
      const part: SessionPart = { type: "tool", tool: "bash", state: { status: "completed" } };
      const result = formatPart(part);
      
      expect(result).toEqual([]);
    });

    test("shows tool with showTools option", () => {
      const part: SessionPart = { type: "tool", tool: "bash", state: { status: "completed" } };
      const result = formatPart(part, { showTools: true });
      
      expect(result).toEqual(["  [tool: bash - completed]"]);
    });

    test("shows unknown status when state is empty", () => {
      const part: SessionPart = { type: "tool", tool: "test", state: {} };
      const result = formatPart(part, { showTools: true });
      
      expect(result).toEqual(["  [tool: test - unknown]"]);
    });
  });

  describe("reasoning parts", () => {
    test("formats reasoning with label and indented content", () => {
      const part: SessionPart = { type: "reasoning", text: "Thinking..." };
      const result = formatPart(part);
      
      expect(result[0]).toBe("  [reasoning]");
      expect(result[1]).toBe("    Thinking...");
    });

    test("formats multi-line reasoning", () => {
      const part: SessionPart = { type: "reasoning", text: "Step 1\nStep 2" };
      const result = formatPart(part);
      
      expect(result).toEqual(["  [reasoning]", "    Step 1", "    Step 2"]);
    });
  });

  describe("unknown part types", () => {
    test("formats unknown type as bracketed label", () => {
      const part: SessionPart = { type: "custom_type" as any };
      const result = formatPart(part);
      
      expect(result).toEqual(["  [custom_type]"]);
    });
  });
});

// ============================================================================
// Tests: Timestamp Formatting
// ============================================================================

describe("formatRelativeTime", () => {
  test("returns 'just now' for very recent timestamps", () => {
    const now = new Date().toISOString();
    const result = formatRelativeTime(now);
    expect(result).toBe("just now");
  });

  test("returns minutes ago for timestamps within an hour", () => {
    const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = formatRelativeTime(fiveMinsAgo);
    expect(result).toBe("5m ago");
  });

  test("returns hours ago for timestamps within a day", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const result = formatRelativeTime(twoHoursAgo);
    expect(result).toBe("2h ago");
  });

  test("returns days ago for timestamps within a week", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const result = formatRelativeTime(threeDaysAgo);
    expect(result).toBe("3d ago");
  });

  test("returns locale date for timestamps older than a week", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const result = formatRelativeTime(tenDaysAgo.toISOString());
    expect(result).toBe(tenDaysAgo.toLocaleDateString());
  });
});

describe("formatLocalTimestamp", () => {
  test("formats timestamp in local format", () => {
    const timestamp = "2024-01-15T14:30:45Z";
    const result = formatLocalTimestamp(timestamp);
    
    // The format should be: YYYY-MM-DD HH:MM:SS
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("pads single digit values", () => {
    const timestamp = "2024-01-05T09:05:03Z";
    const result = formatLocalTimestamp(timestamp);
    
    // All values should be zero-padded
    expect(result).toMatch(/2024-01-0\d 0\d:0\d:0\d/);
  });
});

describe("formatLocalDate", () => {
  test("formats date only", () => {
    const timestamp = "2024-01-15T14:30:45Z";
    const result = formatLocalDate(timestamp);
    
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("pads single digit month and day", () => {
    const timestamp = "2024-01-05T14:30:45Z";
    const result = formatLocalDate(timestamp);
    
    expect(result).toBe("2024-01-05");
  });
});

// ============================================================================
// Tests: ID and Text Truncation
// ============================================================================

describe("truncateId", () => {
  test("returns short IDs unchanged", () => {
    const result = truncateId("short-id");
    expect(result).toBe("short-id");
  });

  test("truncates long IDs with ellipsis", () => {
    const longId = "this-is-a-very-long-session-id-that-should-be-truncated";
    const result = truncateId(longId, 20);
    
    // Takes first 20 chars and appends "..."
    expect(result.length).toBe(23); // 20 + 3 for "..."
    expect(result).toBe("this-is-a-very-long-...");
  });

  test("uses default max length of 20", () => {
    const longId = "123456789012345678901234567890";
    const result = truncateId(longId);
    
    expect(result.length).toBe(23);
    expect(result).toBe("12345678901234567890...");
  });

  test("handles edge case of exact length", () => {
    const exactId = "12345678901234567890"; // exactly 20 chars
    const result = truncateId(exactId, 20);
    
    expect(result).toBe("12345678901234567890");
  });
});

describe("truncateText", () => {
  test("returns short text unchanged", () => {
    const result = truncateText("Short text", 50);
    expect(result).toBe("Short text");
  });

  test("truncates long text with ellipsis", () => {
    const longText = "This is a very long text that should be truncated for display";
    const result = truncateText(longText, 20);
    
    expect(result).toBe("This is a very lo...");
    expect(result.length).toBe(20);
  });

  test("accounts for ellipsis in length calculation", () => {
    const text = "123456789012345678901234567890";
    const result = truncateText(text, 10);
    
    expect(result.length).toBe(10);
    expect(result.endsWith("...")).toBe(true);
  });
});

// ============================================================================
// Tests: Error Formatting
// ============================================================================

describe("formatErrors", () => {
  test("returns empty string for no errors", () => {
    const result = formatErrors([]);
    expect(result).toBe("");
  });

  test("formats single error", () => {
    const errors = [{ agent: "opencode", alias: "personal", message: "Connection failed" }];
    const result = formatErrors(errors);
    
    expect(result).toContain("[opencode:personal]");
    expect(result).toContain("Connection failed");
    expect(result.endsWith("\n")).toBe(true);
  });

  test("formats multiple errors", () => {
    const errors = [
      { agent: "opencode", alias: "personal", message: "Error 1" },
      { agent: "codex", alias: "work", message: "Error 2" },
    ];
    const result = formatErrors(errors);
    
    expect(result).toContain("Error 1");
    expect(result).toContain("Error 2");
    expect(result).toContain("[opencode:personal]");
    expect(result).toContain("[codex:work]");
  });

  test("avoids duplicating label if already in message", () => {
    const errors = [{ agent: "opencode", alias: "personal", message: "[opencode:personal] Custom error" }];
    const result = formatErrors(errors);
    
    // Should not have duplicated label
    expect(result).toBe("[opencode:personal] Custom error\n");
  });
});

// ============================================================================
// Tests: Tool Visibility
// ============================================================================

describe("tool visibility handling", () => {
  test("hides tools by default in message", () => {
    const message: SessionMessage = {
      id: "msg-1",
      role: "assistant",
      created_at: "2024-01-01T12:00:00Z",
      parts: [
        { type: "text", text: "Hello" },
        { type: "tool", tool: "bash", state: { status: "completed" } },
        { type: "text", text: "Done" },
      ],
    };
    
    const result = formatMessage(message);
    const joined = result.join("\n");
    
    expect(joined).toContain("Hello");
    expect(joined).toContain("Done");
    expect(joined).not.toContain("[tool:");
  });

  test("shows tools with showTools option in message", () => {
    const message: SessionMessage = {
      id: "msg-1",
      role: "assistant",
      created_at: "2024-01-01T12:00:00Z",
      parts: [
        { type: "text", text: "Hello" },
        { type: "tool", tool: "bash", state: { status: "completed" } },
      ],
    };
    
    const result = formatMessage(message, { showTools: true });
    const joined = result.join("\n");
    
    expect(joined).toContain("Hello");
    expect(joined).toContain("[tool: bash - completed]");
  });

  test("hides tools by default in session detail", () => {
    const detail: SessionDetail = makeSessionDetail({
      messages: [{
        id: "msg-1",
        role: "assistant",
        created_at: "2024-01-01T12:00:00Z",
        parts: [
          { type: "tool", tool: "bash", state: { status: "completed" } },
        ],
      }],
      message_count: 1,
    });
    const target = makeReadQuery();
    
    const result = formatSessionDetail(detail, target);
    expect(result).not.toContain("[tool:");
  });

  test("shows tools with showTools option in session detail", () => {
    const detail: SessionDetail = makeSessionDetail({
      messages: [{
        id: "msg-1",
        role: "assistant",
        created_at: "2024-01-01T12:00:00Z",
        parts: [
          { type: "tool", tool: "bash", state: { status: "completed" } },
        ],
      }],
      message_count: 1,
    });
    const target = makeReadQuery();
    
    const result = formatSessionDetail(detail, target, { showTools: true });
    expect(result).toContain("[tool: bash - completed]");
  });
});

// ============================================================================
// Tests: Column Alignment
// ============================================================================

describe("column alignment", () => {
  test("aligns session rows with varying data lengths", () => {
    const sessions = [
      makeSession({ id: "short", title: "A", message_count: 1 }),
      makeSession({ id: "very-long-session-id-here", title: "A Much Longer Title Here", message_count: 999 }),
    ];
    
    const lines = sessions.map(formatSessionRow);
    
    // Both should have consistent structure
    for (const line of lines) {
      expect(line).toContain("[opencode:personal]");
      expect(line).toContain("msg");
    }
  });

  test("pads label to fixed width for column alignment", () => {
    // Test with different label lengths (all under 25 chars to test padding)
    const shortLabel = makeSession({ agent: "codex", alias: "a", title: "Test" });
    const mediumLabel = makeSession({ agent: "opencode", alias: "personal", title: "Test" });
    const longerLabel = makeSession({ agent: "opencode", alias: "work-project", title: "Test" });

    const shortResult = formatSessionRow(shortLabel);
    const mediumResult = formatSessionRow(mediumLabel);
    const longerResult = formatSessionRow(longerLabel);

    // All labels should be padded to 25 characters
    // Find the position after the label (first space after label)
    const getLabelEnd = (str: string) => {
      const match = str.match(/^\[.*?\]\s*/);
      return match ? match[0].length : -1;
    };

    const shortEnd = getLabelEnd(shortResult);
    const mediumEnd = getLabelEnd(mediumResult);
    const longerEnd = getLabelEnd(longerResult);

    // All should end at the same position (25 chars for label + 1 space = 26)
    expect(shortEnd).toBe(26);
    expect(mediumEnd).toBe(26);
    expect(longerEnd).toBe(26);
  });

  test("ensures columns start at same position regardless of label length", () => {
    const sessions = [
      makeSession({ agent: "codex", alias: "a", id: "id1", title: "Title" }),
      makeSession({ agent: "opencode", alias: "work-project", id: "id2", title: "Title" }),
    ];

    const [line1, line2] = sessions.map(formatSessionRow);

    // Find where "Title" appears in each line - should be at same position
    const titlePos1 = line1.indexOf("Title");
    const titlePos2 = line2.indexOf("Title");

    expect(titlePos1).toBe(titlePos2);
    expect(titlePos1).toBeGreaterThan(0);
  });
});
