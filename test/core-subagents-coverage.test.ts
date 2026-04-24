import { describe, expect, test } from "bun:test";
import { 
  inferSubAgents, 
  categorise, 
  formatSubAgentSummary, 
  formatStatusLine, 
  buildForkChain 
} from "../src/core/subagents";
import type { SessionDetail } from "../src/core/types";

describe("src/core/subagents.ts coverage", () => {
  const mockDetail: SessionDetail = {
    id: "s1",
    agent: "opencode",
    alias: "main",
    title: "Test Session",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T01:00:00Z",
    message_count: 2,
    storage: "db",
    messages: [
      {
        id: "m1",
        role: "user",
        created_at: "2024-01-01T00:00:00Z",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "m2",
        role: "assistant",
        created_at: "2024-01-01T00:01:00Z",
        modelID: "gpt-4",
        parts: [
          { type: "reasoning", text: "Thinking..." } as any,
          { type: "text", text: "Hi" },
          { type: "tool", tool: "bash", args: "{}" } as any,
          { type: "tool", tool: "MCP_web_search", args: "{}" } as any,
          { type: "tool", tool: "custom_tool_x", args: "{}" } as any
        ]
      }
    ]
  };

  test("inferSubAgents correctly aggregates session data", () => {
    const summary = inferSubAgents(mockDetail);
    expect(summary.messageCount).toBe(2);
    expect(summary.models).toEqual(["gpt-4"]);
    expect(summary.reasoningUsed).toBe(true);
    expect(summary.toolCallCount).toBe(3);
    expect(summary.roles).toEqual({ user: 1, assistant: 1, system: 0 });
    expect(summary.startedAt).toBe("2024-01-01T00:00:00Z");
    expect(summary.endedAt).toBe("2024-01-01T00:01:00Z");
    
    const bashTool = summary.tools.find(t => t.name === "bash");
    expect(bashTool?.isMcp).toBe(false);
    expect(bashTool?.isCustom).toBe(false); // bash is known

    const mcpTool = summary.tools.find(t => t.name === "MCP_web_search");
    expect(mcpTool?.isMcp).toBe(true);
    expect(mcpTool?.isCustom).toBe(false);

    const customTool = summary.tools.find(t => t.name === "custom_tool_x");
    expect(customTool?.isMcp).toBe(false);
    expect(customTool?.isCustom).toBe(true);
  });

  test("categorise matches known tools", () => {
    expect(categorise("bash")).toBe("Shell/CLI");
    expect(categorise("git_commit")).toBe("GitOperator");
    expect(categorise("unknown")).toBeUndefined();
  });

  test("formatSubAgentSummary produces readable string", () => {
    const summary = inferSubAgents(mockDetail);
    const formatted = formatSubAgentSummary(summary);
    expect(formatted).toContain("Models: gpt-4");
    expect(formatted).toContain("Sub-agents: Shell/CLI(1)");
    expect(formatted).toContain("3 tool types, 3 calls");
    expect(formatted).toContain("MCP: MCP_web_search");
    expect(formatted).toContain("Custom: CustomTool:custom_tool_x");
    expect(formatted).toContain("Reasoning: yes");
  });

  test("formatStatusLine produces concise TUI string", () => {
    const summary = inferSubAgents(mockDetail);
    const status = formatStatusLine(summary);
    expect(status).toBe("gpt-4 | 2 msgs | 3 tools | 💭");
  });

  test("formatStatusLine handles no tools or reasoning", () => {
    const emptySummary = inferSubAgents({ ...mockDetail, messages: [] });
    expect(formatStatusLine(emptySummary)).toBe("0 msgs");
  });

  describe("buildForkChain", () => {
    const sessions = {
      "s1": { id: "s1", agent: "a", alias: "m", title: "Root" },
      "s2": { id: "s2", parentSessionId: "s1", agent: "a", alias: "m", title: "Child" },
      "s3": { id: "s3", parentSessionId: "s2", agent: "a", alias: "m", title: "Grandchild" },
    };

    const resolveParent = (id: string) => (sessions as any)[id] || null;

    test("builds linear chain from grandchild to root", () => {
      const chain = buildForkChain(sessions.s3, resolveParent);
      expect(chain).toHaveLength(3);
      expect(chain[0].sessionId).toBe("s1");
      expect(chain[1].sessionId).toBe("s2");
      expect(chain[2].sessionId).toBe("s3");
      expect(chain[2].depth).toBe(0);
      expect(chain[1].depth).toBe(1);
      expect(chain[0].depth).toBe(2);
    });

    test("handles cycles gracefully", () => {
      const cyclicSessions = {
        "a": { id: "a", parentSessionId: "b", agent: "x", alias: "y" },
        "b": { id: "b", parentSessionId: "a", agent: "x", alias: "y" },
      };
      const chain = buildForkChain(cyclicSessions.a, (id) => (cyclicSessions as any)[id]);
      expect(chain).toHaveLength(2);
      expect(chain.map(n => n.sessionId)).toContain("a");
      expect(chain.map(n => n.sessionId)).toContain("b");
    });

    test("respects maxDepth", () => {
      const chain = buildForkChain(sessions.s3, resolveParent, 1);
      expect(chain).toHaveLength(1);
      expect(chain[0].sessionId).toBe("s3");
    });

    test("handles missing titles", () => {
      const session = { id: "no-title", agent: "a", alias: "m" };
      const chain = buildForkChain(session, () => null);
      expect(chain[0].title).toBe("no-title");
    });
  });
});
