import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter } from "../src/adapters/codex";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "oas-codex-"));
}

function writeSession(filePath: string, lines: unknown[]): void {
  const payload = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(filePath, payload, "utf8");
}

describe("codex adapter", () => {
  test("maps session fields from codex JSONL", () => {
    const dir = tempDir();
    const filePath = join(dir, "session.jsonl");
    writeSession(filePath, [
      {
        timestamp: "2026-02-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "cx-100", timestamp: "2026-02-01T00:00:00Z", title: "Refactor notes" },
      },
      {
        timestamp: "2026-02-01T01:00:00Z",
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "Hello" }] },
      },
      {
        timestamp: "2026-02-01T02:00:00Z",
        type: "response_item",
        payload: { role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
      },
    ]);

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
      path: filePath,
    });
    const sessions = adapter.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0]).toEqual({
      id: "cx-100",
      agent: "codex",
      alias: "work",
      title: "Refactor notes",
      created_at: "2026-02-01T00:00:00.000Z",
      updated_at: "2026-02-01T02:00:00.000Z",
      message_count: 2,
      storage: "other",
    });
  });

  test("falls back to first user line when title is missing", () => {
    const dir = tempDir();
    const filePath = join(dir, "session.jsonl");
    writeSession(filePath, [
      {
        timestamp: "2026-02-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "cx-200", timestamp: "2026-02-01T00:00:00Z" },
      },
      {
        timestamp: "2026-02-01T00:10:00Z",
        type: "response_item",
        payload: {
          role: "user",
          content: [{ type: "input_text", text: "First line\nSecond line" }],
        },
      },
    ]);

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
      path: filePath,
    });
    const sessions = adapter.listSessions();
    expect(sessions[0]?.title).toBe("First line");
  });

  test("reads jsonl files recursively from a directory", () => {
    const dir = tempDir();
    const nested = join(dir, "nested");
    mkdirSync(nested, { recursive: true });
    writeSession(join(dir, "a.jsonl"), [
      {
        timestamp: "2026-02-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "cx-001", timestamp: "2026-02-01T00:00:00Z" },
      },
    ]);
    writeSession(join(nested, "b.jsonl"), [
      {
        timestamp: "2026-02-02T00:00:00Z",
        type: "session_meta",
        payload: { id: "cx-002", timestamp: "2026-02-02T00:00:00Z" },
      },
    ]);

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
      path: dir,
    });
    const sessions = adapter.listSessions();
    expect(sessions.map((session) => session.id).sort()).toEqual(["cx-001", "cx-002"]);
  });

  test("ignores non-jsonl files in a directory", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "notes.txt"), "ignore", "utf8");
    writeSession(join(dir, "a.jsonl"), [
      {
        timestamp: "2026-02-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "cx-010", timestamp: "2026-02-01T00:00:00Z" },
      },
    ]);

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
      path: dir,
    });
    const sessions = adapter.listSessions();
    expect(sessions.map((session) => session.id)).toEqual(["cx-010"]);
  });

  test("invalid timestamps raise an error", () => {
    const dir = tempDir();
    const filePath = join(dir, "session.jsonl");
    writeSession(filePath, [
      {
        timestamp: "not-a-time",
        type: "session_meta",
        payload: { id: "cx-300", timestamp: "2026-02-01T00:00:00Z" },
      },
    ]);

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
      path: filePath,
    });
    expect(() => adapter.listSessions()).toThrow(/timestamp invalid/i);
  });

  test("timestamp errors include session id and path context", () => {
    const dir = tempDir();
    const filePath = join(dir, "session.jsonl");
    writeSession(filePath, [
      {
        timestamp: "bad",
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "Hello" }] },
      },
      {
        timestamp: "2026-02-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "cx-350", timestamp: "2026-02-01T00:00:00Z" },
      },
    ]);

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
      path: filePath,
    });
    expect(() => adapter.listSessions()).toThrow(
      new RegExp(`\\[codex:work\\].*cx-350.*${filePath}`)
    );
  });

  test("missing session_meta raises an error with agent context", () => {
    const dir = tempDir();
    const filePath = join(dir, "session.jsonl");
    writeSession(filePath, [
      {
        timestamp: "2026-02-01T00:00:00Z",
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "Hello" }] },
      },
    ]);

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
      path: filePath,
    });
    expect(() => adapter.listSessions()).toThrow(/\[codex:work\].*session_meta/i);
  });

  test("missing session id raises an error", () => {
    const dir = tempDir();
    const filePath = join(dir, "session.jsonl");
    writeSession(filePath, [
      {
        timestamp: "2026-02-01T00:00:00Z",
        type: "session_meta",
        payload: { timestamp: "2026-02-01T00:00:00Z" },
      },
    ]);

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
      path: filePath,
    });
    expect(() => adapter.listSessions()).toThrow(/session id missing/i);
  });

  test("updated_at missing raises an error", () => {
    const dir = tempDir();
    const filePath = join(dir, "session.jsonl");
    writeSession(filePath, [
      {
        type: "session_meta",
        payload: { id: "cx-500", timestamp: "2026-02-01T00:00:00Z" },
      },
    ]);

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
      path: filePath,
    });
    expect(() => adapter.listSessions()).toThrow(/updated_at missing/i);
  });

  test("uses default path when path is omitted", () => {
    const dir = tempDir();
    const filePath = join(dir, "session.jsonl");
    writeSession(filePath, [
      {
        timestamp: "2026-02-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "cx-700", timestamp: "2026-02-01T00:00:00Z" },
      },
    ]);

    const adapter = createCodexAdapter(
      {
        agent: "codex",
        alias: "work",
        enabled: true,
      },
      { defaultPath: dir }
    );
    const sessions = adapter.listSessions();
    expect(sessions.map((session) => session.id)).toEqual(["cx-700"]);
  });

  test("resolves relative path against config dir", () => {
    const dir = tempDir();
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeSession(join(sessionsDir, "session.jsonl"), [
      {
        timestamp: "2026-02-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "cx-800", timestamp: "2026-02-01T00:00:00Z" },
      },
    ]);

    const adapter = createCodexAdapter(
      {
        agent: "codex",
        alias: "work",
        enabled: true,
        path: "sessions",
      },
      { configDir: dir }
    );
    const sessions = adapter.listSessions();
    expect(sessions.map((session) => session.id)).toEqual(["cx-800"]);
  });

  test("missing path error includes resolved path", () => {
    const dir = tempDir();
    const adapter = createCodexAdapter(
      {
        agent: "codex",
        alias: "work",
        enabled: true,
        path: "missing.jsonl",
      },
      { configDir: dir }
    );
    expect(() => adapter.listSessions()).toThrow(
      new RegExp(`\\[codex:work\\].*${join(dir, "missing.jsonl")}`)
    );
  });
});
