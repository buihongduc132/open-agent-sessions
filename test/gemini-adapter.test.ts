import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGeminiAdapter } from "../src/adapters/gemini";
import { OtherAgentEntry } from "../src/config/types";

describe("GeminiAdapter", () => {
  let tmpDir: string;
  let entry: OtherAgentEntry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "oas-gemini-test-"));
    entry = {
      agent: "gemini",
      alias: "test-gemini",
      enabled: true,
      path: tmpDir,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("maps session fields from gemini JSONL", async () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    const header = {
      sessionId: "abc123-uuid",
      projectHash: "hash123",
      startTime: "2026-04-23T05:50:25.007Z",
      lastUpdated: "2026-04-23T06:00:00.000Z",
      kind: "main"
    };

    const userRecord = {
      id: "msg-001",
      timestamp: "2026-04-23T05:51:00.000Z",
      type: "user",
      content: [{ text: "Hello world" }]
    };

    const geminiRecord = {
      id: "msg-002",
      timestamp: "2026-04-23T05:51:05.000Z",
      type: "gemini",
      content: "I'll help you.",
      model: "gemini-3-flash-preview"
    };

    writeFileSync(sessionFile, [
      JSON.stringify(header),
      JSON.stringify(userRecord),
      JSON.stringify(geminiRecord)
    ].join("\n"));

    const adapter = createGeminiAdapter(entry);
    const sessions = adapter.listSessions();

    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.id).toBe("abc123-uuid");
    expect(s.agent).toBe("gemini");
    expect(s.alias).toBe("test-gemini");
    expect(s.title).toBe("Hello world");
    expect(s.created_at).toBe("2026-04-23T05:50:25.007Z");
    expect(s.updated_at).toBe("2026-04-23T06:00:00.000Z");
    expect(s.message_count).toBe(2);
    expect(s.storage).toBe("jsonl");
  });

  it("extracts title from first user message text", () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    const header = { sessionId: "abc123-uuid", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" };
    const userRecord = { type: "user", content: [{ text: "Unique Title" }], timestamp: "2026-04-23T05:50:25Z" };

    writeFileSync(sessionFile, JSON.stringify(header) + "\n" + JSON.stringify(userRecord));

    const adapter = createGeminiAdapter(entry);
    const sessions = adapter.listSessions();
    expect(sessions[0].title).toBe("Unique Title");
  });

  it("falls back to session id when no user messages", () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    const header = { sessionId: "abc123-uuid", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" };
    const geminiRecord = { type: "gemini", content: "Hi", timestamp: "2026-04-23T05:50:25Z" };

    writeFileSync(sessionFile, JSON.stringify(header) + "\n" + JSON.stringify(geminiRecord));

    const adapter = createGeminiAdapter(entry);
    const sessions = adapter.listSessions();
    expect(sessions[0].title).toBe("abc123-uuid");
  });

  it("reads jsonl files recursively from project dirs", () => {
    const p1 = join(tmpDir, "proj1", "chats");
    const p2 = join(tmpDir, "proj2", "chats");
    mkdirSync(p1, { recursive: true });
    mkdirSync(p2, { recursive: true });

    writeFileSync(join(p1, "session-1.jsonl"), JSON.stringify({ sessionId: "1", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" }));
    writeFileSync(join(p2, "session-2.jsonl"), JSON.stringify({ sessionId: "2", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" }));

    const adapter = createGeminiAdapter(entry);
    const sessions = adapter.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map(s => s.id).sort()).toEqual(["1", "2"]);
  });

  it("ignores $set state-update lines", () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    writeFileSync(sessionFile, [
      JSON.stringify({ sessionId: "abc123-uuid", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" }),
      JSON.stringify({ "$set": { some: "state" } }),
      JSON.stringify({ type: "user", content: [{ text: "Hi" }], timestamp: "2026-04-23T05:50:25Z" })
    ].join("\n"));

    const adapter = createGeminiAdapter(entry);
    const sessions = adapter.listSessions();
    expect(sessions[0].message_count).toBe(1);
  });

  it("ignores error and info record types", () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    writeFileSync(sessionFile, [
      JSON.stringify({ sessionId: "abc123-uuid", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" }),
      JSON.stringify({ type: "error", content: "bad", timestamp: "2026-04-23T05:50:25Z" }),
      JSON.stringify({ type: "info", content: "FYI", timestamp: "2026-04-23T05:50:25Z" }),
      JSON.stringify({ type: "user", content: [{ text: "Hi" }], timestamp: "2026-04-23T05:50:25Z" })
    ].join("\n"));

    const adapter = createGeminiAdapter(entry);
    const sessions = adapter.listSessions();
    expect(sessions[0].message_count).toBe(1);
  });

  it("deduplicates gemini records with same id", async () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    writeFileSync(sessionFile, [
      JSON.stringify({ sessionId: "abc123-uuid", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" }),
      JSON.stringify({ id: "m1", type: "gemini", content: "Part 1", timestamp: "2026-04-23T05:50:25Z" }),
      JSON.stringify({ id: "m1", type: "gemini", content: "Part 1 & 2", timestamp: "2026-04-23T05:50:26Z" })
    ].join("\n"));

    const adapter = createGeminiAdapter(entry);
    const detail = await adapter.getSessionDetail("abc123-uuid", {});
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages![0].parts[0].text).toBe("Part 1 & 2");
  });

  it("handles JSONL parse errors with context", () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    writeFileSync(sessionFile, '{"sessionId": "1", "startTime": "2026-04-23T05:50:25Z"}\n{invalid-json}');

    const adapter = createGeminiAdapter(entry);
    expect(() => adapter.listSessions()).toThrow(/JSONL parse error/);
  });

  it("returns empty when no session files found", () => {
    const adapter = createGeminiAdapter(entry);
    expect(adapter.listSessions()).toEqual([]);
  });

  it("searchSessions matches content and title", () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    writeFileSync(sessionFile, [
      JSON.stringify({ sessionId: "abc123-uuid", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" }),
      JSON.stringify({ type: "user", content: [{ text: "findme" }], timestamp: "2026-04-23T05:50:25Z" })
    ].join("\n"));

    const adapter = createGeminiAdapter(entry);
    const results = adapter.searchSessions!({ text: "findme" });
    expect(results).toHaveLength(1);
  });

  it("getSessionDetail returns messages with tool parts", async () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    const geminiRecord = {
      id: "msg-002",
      timestamp: "2026-04-23T05:51:05.000Z",
      type: "gemini",
      content: "Running tool",
      toolCalls: [{
        id: "tool_001",
        name: "ls",
        args: { path: "." },
        result: [{ functionResponse: { response: { output: "files" } } }],
        status: "completed"
      }]
    };

    writeFileSync(sessionFile, [
      JSON.stringify({ sessionId: "abc123-uuid", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" }),
      JSON.stringify(geminiRecord)
    ].join("\n"));

    const adapter = createGeminiAdapter(entry);
    const detail = await adapter.getSessionDetail("abc123-uuid", {});
    const toolPart = detail.messages![0].parts.find(p => p.type === "tool");
    expect(toolPart).toBeDefined();
    expect((toolPart as any).tool).toBe("ls");
  });

  it("getSessionDetail returns reasoning parts from thoughts", async () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    const geminiRecord = {
      id: "msg-002",
      timestamp: "2026-04-23T05:51:05.000Z",
      type: "gemini",
      content: "Answer",
      thoughts: [{ subject: "Thinking", description: "Calculating", timestamp: "..." }]
    };

    writeFileSync(sessionFile, [
      JSON.stringify({ sessionId: "abc123-uuid", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" }),
      JSON.stringify(geminiRecord)
    ].join("\n"));

    const adapter = createGeminiAdapter(entry);
    const detail = await adapter.getSessionDetail("abc123-uuid", {});
    const reasoningPart = detail.messages![0].parts.find(p => p.type === "reasoning");
    expect(reasoningPart).toBeDefined();
    expect((reasoningPart as any).text).toContain("Calculating");
  });

  it("getSessionDetail maps gemini tokens to usage metadata", async () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    const geminiRecord = {
      id: "msg-002",
      timestamp: "2026-04-23T05:51:05.000Z",
      type: "gemini",
      content: "Answer",
      tokens: { total: 100 }
    };

    writeFileSync(sessionFile, [
      JSON.stringify({ sessionId: "abc123-uuid", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" }),
      JSON.stringify(geminiRecord)
    ].join("\n"));

    const adapter = createGeminiAdapter(entry);
    const detail = await adapter.getSessionDetail("abc123-uuid", {});
    expect((detail.messages![0] as any).tokens).toEqual({ total: 100 });
  });

  it("getSessionDetail supports first/last/range selection", async () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    writeFileSync(sessionFile, [
      JSON.stringify({ sessionId: "abc123-uuid", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" }),
      JSON.stringify({ id: "1", type: "user", content: [{ text: "1" }], timestamp: "2026-04-23T05:50:25Z" }),
      JSON.stringify({ id: "2", type: "user", content: [{ text: "2" }], timestamp: "2026-04-23T05:50:26Z" }),
      JSON.stringify({ id: "3", type: "user", content: [{ text: "3" }], timestamp: "2026-04-23T05:50:27Z" })
    ].join("\n"));

    const adapter = createGeminiAdapter(entry);
    const last1 = await adapter.getSessionDetail("abc123-uuid", { selection: { mode: "last", count: 1 } });
    expect(last1.messages).toHaveLength(1);
    expect(last1.messages![0].id).toBe("3");

    const range = await adapter.getSessionDetail("abc123-uuid", { selection: { mode: "range", start: 1, end: 2 } });
    expect(range.messages).toHaveLength(2);
    expect(range.messages![0].id).toBe("1");
    expect(range.messages![1].id).toBe("2");
  });

  it("getSessionDetail supports userOnly filter", async () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    writeFileSync(sessionFile, [
      JSON.stringify({ sessionId: "abc123-uuid", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" }),
      JSON.stringify({ id: "1", type: "user", content: [{ text: "u" }], timestamp: "2026-04-23T05:50:25Z" }),
      JSON.stringify({ id: "2", type: "gemini", content: "g", timestamp: "2026-04-23T05:50:26Z" })
    ].join("\n"));

    const adapter = createGeminiAdapter(entry);
    const userOnly = await adapter.getSessionDetail("abc123-uuid", { userOnly: true });
    expect(userOnly.messages).toHaveLength(1);
    expect(userOnly.messages![0].role).toBe("user");
  });

  it("getSessionDetail throws when session not found", async () => {
    const adapter = createGeminiAdapter(entry);
    expect(adapter.getSessionDetail("none", {})).rejects.toThrow(/session not found/);
  });

  it("extracts model from gemini records", async () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    writeFileSync(sessionFile, [
      JSON.stringify({ sessionId: "abc123-uuid", startTime: "2026-04-23T05:50:25Z", lastUpdated: "2026-04-23T05:50:25Z" }),
      JSON.stringify({ id: "1", type: "gemini", content: "hi", model: "model-x", timestamp: "2026-04-23T05:50:25Z" })
    ].join("\n"));

    const adapter = createGeminiAdapter(entry);
    const detail = await adapter.getSessionDetail("abc123-uuid", {});
    expect(detail.messages![0].modelID).toBe("model-x");
  });

  it("invalid timestamps raise error with context", () => {
    const projectDir = join(tmpDir, "project1", "chats");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-abc123.jsonl");

    writeFileSync(sessionFile, [
      JSON.stringify({ sessionId: "abc123-uuid", startTime: "invalid", lastUpdated: "2026-04-23T05:50:25Z" })
    ].join("\n"));

    const adapter = createGeminiAdapter(entry);
    expect(() => adapter.listSessions()).toThrow(/timestamp invalid/);
  });
});
