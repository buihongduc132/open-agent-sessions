import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "../../../src/adapters/claude";

const tempRoots: string[] = [];
const timestamp = "2026-10-30T10:00:00Z";

function fixture(records: unknown[], filename = "session-a.jsonl") {
  const root = mkdtempSync(join(tmpdir(), "oas-g06-"));
  tempRoots.push(root);
  const path = join(root, filename);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const adapter = createClaudeAdapter({ agent: "claude", alias: "local", enabled: true, path: root });
  return { adapter, root };
}

const record = (type: string, extra: Record<string, unknown> = {}) => ({ type, timestamp, ...extra });
afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("G06 Claude real JSONL shape", () => {
  test("latest nonempty ai-title wins over a user message", () => {
    const { adapter } = fixture([
      record("user", { message: { content: "Original user request" } }),
      record("ai-title", { aiTitle: "First title" }),
      record("ai-title", { aiTitle: "" }),
      record("ai-title", { aiTitle: "Final title" }),
    ]);
    expect(adapter.listSessions()[0]?.title).toBe("Final title");
  });

  test("message.content string is the user title without ai-title", () => {
    const { adapter } = fixture([record("user", { message: { role: "user", content: "Do research\nMore details" } })]);
    expect(adapter.listSessions()[0]?.title).toBe("Do research");
  });

  test("tool_result carrier and isMeta user are not title candidates or messages", () => {
    const { adapter } = fixture([
      record("user", { toolUseResult: { stdout: "done" }, message: { content: [{ type: "tool_result", content: "old" }] } }),
      record("user", { isMeta: true, message: { content: "Injected metadata" } }),
      record("user", { message: { content: [{ type: "tool_result", content: "no title" }, { type: "text", text: "Actual request" }] } }),
    ]);
    expect(adapter.listSessions()[0]?.title).toBe("Actual request");
    expect(adapter.listSessions()[0]?.message_count).toBe(2);
  });

  test("wrapper-only and tool-result-only content fall through to first real user", () => {
    const { adapter } = fixture([
      record("user", { message: { content: "<system-reminder>not a prompt</system-reminder>\n<command-name>/help</command-name>" } }),
      record("user", { message: { content: [{ type: "tool_result", content: "x" }] } }),
      record("user", { message: { content: "<system-reminder>noise</system-reminder>\n<command-args>hide</command-args>\nActual title" } }),
    ]);
    expect(adapter.listSessions()[0]?.title).toBe("Actual title");
    expect(adapter.listSessions()[0]?.message_count).toBe(2);
  });

  test("last-prompt fallback and id fallback", () => {
    const a = fixture([record("last-prompt", { lastPrompt: "Previous" }), record("last-prompt", { lastPrompt: "Latest\nline" })], "first.jsonl");
    const b = fixture([record("system", {})], "second.jsonl");
    expect(a.adapter.listSessions()[0]?.title).toBe("Latest");
    expect(b.adapter.listSessions()[0]?.title).toBe("second");
  });

  test("title is bounded to 120 characters", () => {
    const { adapter } = fixture([record("user", { message: { content: "a".repeat(500) } })]);
    expect(adapter.listSessions()[0]?.title).toBe("a".repeat(120));
  });

  test("legacy top-level content still works; null message is harmless", () => {
    const { adapter } = fixture([
      record("assistant", { message: null }),
      record("user", { message: null, content: "Legacy prompt" }),
    ]);
    expect(adapter.listSessions()[0]?.title).toBe("Legacy prompt");
  });

  test("subagent file reports its parent; root session is not a subagent", () => {
    const { adapter } = fixture([
      record("user", { sessionId: "parent-uuid", message: { content: "Sub task" } }),
    ], "parent-uuid/subagents/agent-x.jsonl");
    expect(adapter.listSessions()[0]?.parentSessionId).toBe("parent-uuid");
    const root = fixture([record("user", { sessionId: "parent-uuid", message: { content: "Root" } })], "root.jsonl");
    expect(root.adapter.listSessions()[0]?.parentSessionId).toBeUndefined();
  });

  test("message detail uses nested content and model; tool search uses nested tool_use", async () => {
    const { adapter } = fixture([
      record("user", { message: { content: "Explain things" } }),
      record("assistant", { message: { model: "claude-test-model", content: [{ type: "tool_use", name: "Bash", input: { command: "true" } }] } }),
    ]);
    const details = await adapter.getSessionDetail?.("session-a", { mode: "all" });
    expect(details?.messages[0]?.parts).toContainEqual({ type: "text", text: "Explain things" });
    expect(details?.messages[1]?.modelID).toBe("claude-test-model");
    expect(details?.messages[1]?.parts[0]?.type).toBe("tool");
    expect(adapter.toolSearchSessions?.({ tool: "bash" }).map((s) => s.id)).toEqual(["session-a"]);
  });

  test("default path discovers ~/.claude/projects before transcripts", () => {
    const home = mkdtempSync(join(tmpdir(), "oas-g06-home-"));
    tempRoots.push(home);
    const projects = join(home, ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    mkdirSync(join(home, ".claude", "transcripts"), { recursive: true });
    writeFileSync(join(projects, "my-session.jsonl"), JSON.stringify(record("user", { message: { content: "Found" } })) + "\n");
    const adapter = createClaudeAdapter({ agent: "claude", alias: "local", enabled: true }, { homeDir: home });
    expect(adapter.listSessions()[0]?.title).toBe("Found");
  });
});
