import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "../src/adapters/claude";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "oas-claude-"));
}

function writeSession(filePath: string, lines: unknown[]): void {
  const payload = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(filePath, payload, "utf8");
}

describe("claude adapter", () => {
  test("maps session fields from claude JSONL", () => {
    const dir = tempDir();
    const filePath = join(dir, "ses_123.jsonl");
    writeSession(filePath, [
      {
        type: "system",
        timestamp: "2026-02-01T00:30:00Z",
        content: "System note",
      },
      {
        type: "user",
        timestamp: "2026-02-01T01:00:00Z",
        content: "First line\nSecond line",
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T02:00:00Z",
        content: "Reply",
      },
    ]);

    const adapter = createClaudeAdapter({
      agent: "claude",
      alias: "main",
      enabled: true,
      path: filePath,
    });
    const sessions = adapter.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0]).toEqual({
      id: "ses_123",
      agent: "claude",
      alias: "main",
      title: "First line",
      created_at: "2026-02-01T00:30:00.000Z",
      updated_at: "2026-02-01T02:00:00.000Z",
      message_count: 2,
      storage: "other",
    });
  });

  test("falls back to session id when title is missing", () => {
    const dir = tempDir();
    const filePath = join(dir, "ses_200.jsonl");
    writeSession(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T01:00:00Z",
        content: "",
      },
    ]);

    const adapter = createClaudeAdapter({
      agent: "claude",
      alias: "main",
      enabled: true,
      path: filePath,
    });
    const sessions = adapter.listSessions();
    expect(sessions[0]?.title).toBe("ses_200");
  });

  test("reads jsonl files recursively from a directory", () => {
    const dir = tempDir();
    const nested = join(dir, "nested");
    mkdirSync(nested, { recursive: true });
    writeSession(join(dir, "ses_001.jsonl"), [
      { type: "user", timestamp: "2026-02-01T00:00:00Z", content: "A" },
    ]);
    writeSession(join(nested, "ses_002.jsonl"), [
      { type: "user", timestamp: "2026-02-02T00:00:00Z", content: "B" },
    ]);

    const adapter = createClaudeAdapter({
      agent: "claude",
      alias: "main",
      enabled: true,
      path: dir,
    });
    const sessions = adapter.listSessions();
    expect(sessions.map((session) => session.id).sort()).toEqual(["ses_001", "ses_002"]);
  });

  test("ignores non-jsonl files in a directory", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "notes.txt"), "ignore", "utf8");
    writeSession(join(dir, "ses_010.jsonl"), [
      { type: "user", timestamp: "2026-02-01T00:00:00Z", content: "A" },
    ]);

    const adapter = createClaudeAdapter({
      agent: "claude",
      alias: "main",
      enabled: true,
      path: dir,
    });
    const sessions = adapter.listSessions();
    expect(sessions.map((session) => session.id)).toEqual(["ses_010"]);
  });

  test("invalid timestamps raise an error with context", () => {
    const dir = tempDir();
    const filePath = join(dir, "ses_300.jsonl");
    writeSession(filePath, [
      {
        type: "user",
        timestamp: "bad",
        content: "Hello",
      },
    ]);

    const adapter = createClaudeAdapter({
      agent: "claude",
      alias: "main",
      enabled: true,
      path: filePath,
    });
    expect(() => adapter.listSessions()).toThrow(
      new RegExp(`\\[claude:main\\].*ses_300.*${filePath}`)
    );
  });

  test("missing timestamps raise an error", () => {
    const dir = tempDir();
    const filePath = join(dir, "ses_400.jsonl");
    writeSession(filePath, [{ type: "user", content: "Hello" }]);

    const adapter = createClaudeAdapter({
      agent: "claude",
      alias: "main",
      enabled: true,
      path: filePath,
    });
    expect(() => adapter.listSessions()).toThrow(/timestamps missing/i);
  });

  test("JSONL parse errors include line numbers", () => {
    const dir = tempDir();
    const filePath = join(dir, "ses_500.jsonl");
    const payload = JSON.stringify({ type: "user", timestamp: "2026-02-01T00:00:00Z" });
    writeFileSync(filePath, `${payload}\n{bad json}\n`, "utf8");

    const adapter = createClaudeAdapter({
      agent: "claude",
      alias: "main",
      enabled: true,
      path: filePath,
    });
    expect(() => adapter.listSessions()).toThrow(/line 2/i);
  });

  test("uses default path when path is omitted", () => {
    const dir = tempDir();
    const filePath = join(dir, "ses_700.jsonl");
    writeSession(filePath, [
      { type: "user", timestamp: "2026-02-01T00:00:00Z", content: "Hello" },
    ]);

    const adapter = createClaudeAdapter(
      {
        agent: "claude",
        alias: "main",
        enabled: true,
      },
      { defaultPath: dir }
    );
    const sessions = adapter.listSessions();
    expect(sessions.map((session) => session.id)).toEqual(["ses_700"]);
  });

  test("resolves relative path against config dir", () => {
    const dir = tempDir();
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeSession(join(sessionsDir, "ses_800.jsonl"), [
      { type: "user", timestamp: "2026-02-01T00:00:00Z", content: "Hello" },
    ]);

    const adapter = createClaudeAdapter(
      {
        agent: "claude",
        alias: "main",
        enabled: true,
        path: "sessions",
      },
      { configDir: dir }
    );
    const sessions = adapter.listSessions();
    expect(sessions.map((session) => session.id)).toEqual(["ses_800"]);
  });

  test("missing path error includes resolved path", () => {
    const dir = tempDir();
    const adapter = createClaudeAdapter(
      {
        agent: "claude",
        alias: "main",
        enabled: true,
        path: "missing.jsonl",
      },
      { configDir: dir }
    );
    expect(() => adapter.listSessions()).toThrow(
      new RegExp(`\\[claude:main\\].*${join(dir, "missing.jsonl")}`)
    );
  });
});
