import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

  // F2: listSessionsByTimeRange — Codex adapter time-range listing
  describe("listSessionsByTimeRange", () => {
    test("returns top N sessions when since=undefined, sorted by time_updated desc", () => {
      const dir = tempDir();
      // Codex stores ONE session per JSONL file — use separate files
      const filePath1 = join(dir, "cx-001.jsonl");
      writeSession(filePath1, [
        {
          timestamp: "2026-01-01T00:00:00Z",
          type: "session_meta",
          payload: { id: "cx-001", timestamp: "2026-01-01T00:00:00Z" },
        },
        {
          timestamp: "2026-01-03T10:00:00Z",
          type: "response_item",
          payload: { role: "user", content: [{ type: "input_text", text: "Old session" }] },
        },
      ]);
      const filePath2 = join(dir, "cx-002.jsonl");
      writeSession(filePath2, [
        {
          timestamp: "2026-01-15T00:00:00Z",
          type: "session_meta",
          payload: { id: "cx-002", timestamp: "2026-01-15T00:00:00Z" },
        },
        {
          timestamp: "2026-01-16T00:00:00Z",
          type: "response_item",
          payload: { role: "assistant", content: [{ type: "output_text", text: "Newer session" }] },
        },
      ]);

      const adapter = createCodexAdapter(
        { agent: "codex", alias: "work", enabled: true, path: dir },
        { defaultPath: dir }
      );

      const result = adapter.listSessionsByTimeRange!({ since: undefined, limit: 20 });

      // Should be sorted by last activity DESC; cx-002 updated Jan 16, cx-001 at Jan 3
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("cx-002");
      expect(result[1].id).toBe("cx-001");
    });

    test("returns sessions newer than since timestamp", () => {
      const dir = tempDir();
      const filePath = join(dir, "a.jsonl");
      // cx-003 updated Jan 20, cx-002 updated Jan 15, cx-001 updated Jan 5
      writeSession(filePath, [
        {
          timestamp: "2026-01-05T00:00:00Z",
          type: "session_meta",
          payload: { id: "cx-001", timestamp: "2026-01-05T00:00:00Z" },
        },
        {
          timestamp: "2026-01-05T10:00:00Z",
          type: "response_item",
          payload: { role: "user", content: [{ type: "input_text", text: "Message for cx-001" }] },
        },
      ]);
      const filePath2 = join(dir, "b.jsonl");
      writeSession(filePath2, [
        {
          timestamp: "2026-01-15T00:00:00Z",
          type: "session_meta",
          payload: { id: "cx-002", timestamp: "2026-01-15T00:00:00Z" },
        },
        {
          timestamp: "2026-01-15T10:00:00Z",
          type: "response_item",
          payload: { role: "assistant", content: [{ type: "output_text", text: "Message for cx-002" }] },
        },
      ]);
      const filePath3 = join(dir, "c.jsonl");
      writeSession(filePath3, [
        {
          timestamp: "2026-01-20T00:00:00Z",
          type: "session_meta",
          payload: { id: "cx-003", timestamp: "2026-01-20T00:00:00Z" },
        },
        {
          timestamp: "2026-01-20T10:00:00Z",
          type: "response_item",
          payload: { role: "user", content: [{ type: "input_text", text: "Message for cx-003" }] },
        },
      ]);

      const adapter = createCodexAdapter(
        { agent: "codex", alias: "work", enabled: true, path: dir },
        { defaultPath: dir }
      );

      const since = new Date("2026-01-10T00:00:00Z").getTime();
      const result = adapter.listSessionsByTimeRange!({ since, limit: 50 });

      // Only cx-002 (Jan 15) and cx-003 (Jan 20) have activity >= since
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.id).sort()).toEqual(["cx-002", "cx-003"]);
      expect(result[0].id).toBe("cx-003"); // most recent first
      expect(result[1].id).toBe("cx-002");
    });

    test("respects limit parameter", () => {
      const dir = tempDir();
      for (let i = 0; i < 10; i++) {
        const fp = join(dir, `s${i}.jsonl`);
        writeSession(fp, [
          {
            timestamp: `2026-01-0${i}T00:00:00Z`,
            type: "session_meta",
            payload: { id: `cx-${String(i).padStart(3, "0")}`, timestamp: `2026-01-0${i}T00:00:00Z` },
          },
          {
            timestamp: `2026-01-0${i}T01:00:00Z`,
            type: "response_item",
            payload: { role: "user", content: [{ type: "input_text", text: `Message ${i}` }] },
          },
        ]);
      }

      const adapter = createCodexAdapter(
        { agent: "codex", alias: "work", enabled: true, path: dir },
        { defaultPath: dir }
      );

      const result = adapter.listSessionsByTimeRange!({ since: undefined, limit: 3 });

      expect(result).toHaveLength(3);
    });

    test("skips the skipSessionId session", () => {
      const dir = tempDir();
      // Use separate files — Codex stores one session per file
      const filePathSkip = join(dir, "cx-to-skip.jsonl");
      writeSession(filePathSkip, [
        {
          timestamp: "2026-01-15T00:00:00Z",
          type: "session_meta",
          payload: { id: "cx-to-skip", timestamp: "2026-01-15T00:00:00Z" },
        },
        {
          timestamp: "2026-01-15T10:00:00Z",
          type: "response_item",
          payload: { role: "user", content: [{ type: "input_text", text: "Skip me" }] },
        },
      ]);
      const filePathKeep = join(dir, "cx-keep.jsonl");
      writeSession(filePathKeep, [
        {
          timestamp: "2026-01-10T00:00:00Z",
          type: "session_meta",
          payload: { id: "cx-keep", timestamp: "2026-01-10T00:00:00Z" },
        },
        {
          timestamp: "2026-01-10T10:00:00Z",
          type: "response_item",
          payload: { role: "user", content: [{ type: "input_text", text: "Keep me" }] },
        },
      ]);

      const adapter = createCodexAdapter(
        { agent: "codex", alias: "work", enabled: true, path: dir },
        { defaultPath: dir }
      );

      const result = adapter.listSessionsByTimeRange!({
        since: undefined,
        limit: 20,
        skipSessionId: "cx-to-skip",
      });

      expect(result.some((s) => s.id === "cx-to-skip")).toBe(false);
      expect(result.some((s) => s.id === "cx-keep")).toBe(true);
    });

    test("returns empty array when no sessions match the time range", () => {
      const dir = tempDir();
      const filePath = join(dir, "old.jsonl");
      writeSession(filePath, [
        {
          timestamp: "2024-01-01T00:00:00Z",
          type: "session_meta",
          payload: { id: "cx-old", timestamp: "2024-01-01T00:00:00Z" },
        },
        {
          timestamp: "2024-01-01T01:00:00Z",
          type: "response_item",
          payload: { role: "user", content: [{ type: "input_text", text: "Old" }] },
        },
      ]);

      const adapter = createCodexAdapter(
        { agent: "codex", alias: "work", enabled: true, path: filePath },
        { defaultPath: dir }
      );

      const since = new Date("2026-01-01T00:00:00Z").getTime();
      const result = adapter.listSessionsByTimeRange!({ since, limit: 50 });

      expect(result).toEqual([]);
    });

    // F2: SQLite-backed listSessionsByTimeRange (real Codex storage)
    // Codex stores sessions in ~/.codex/state_5.sqlite — the threads table.
    // This path is triggered when the path ends in .sqlite (or is the default state_5.sqlite).
    describe("SQLite-backed listSessionsByTimeRange (F2)", () => {
      // Test helper: check if the real Codex DB exists and is accessible.
      // Returns the DB path string if present, otherwise null (skip test).
      function realSqliteDbPath(): string | null {
        const path = join(homedir(), ".codex", "state_5.sqlite");
        try {
          const { statSync } = require("node:fs") as typeof import("node:fs");
          const stat = statSync(path);
          if (stat?.isFile()) return path;
        } catch { /* not accessible */ }
        return null;
      }

      test("returns up to limit sessions when since=undefined", () => {
        const dbPath = realSqliteDbPath();
        expect(dbPath).not.toBeNull(); // FAIL if no real DB — must have ~/.codex/state_5.sqlite

        const adapter = createCodexAdapter(
          { agent: "codex", alias: "work", enabled: true, path: dbPath! },
          {}
        );

        const result = adapter.listSessionsByTimeRange!({ since: undefined, limit: 5 });

        expect(result.length).toBeLessThanOrEqual(5);
        for (const session of result) {
          expect(session.agent).toBe("codex");
          expect(session.alias).toBe("work");
          expect(typeof session.id).toBe("string");
          expect(typeof session.created_at).toBe("string");
          expect(typeof session.updated_at).toBe("string");
        }
      });

      test("returns only sessions newer than since timestamp", () => {
        const dbPath = realSqliteDbPath();
        expect(dbPath).not.toBeNull();

        const adapter = createCodexAdapter(
          { agent: "codex", alias: "work", enabled: true, path: dbPath! },
          {}
        );

        // Use a timestamp in the middle of the known data range
        const since = new Date("2026-03-01T00:00:00Z").getTime();
        const result = adapter.listSessionsByTimeRange!({ since, limit: 50 });

        // All results must have updated_at >= since
        for (const session of result) {
          expect(Date.parse(session.updated_at)).toBeGreaterThanOrEqual(since);
        }
        // Should be sorted by last activity DESC
        for (let i = 0; i < result.length - 1; i++) {
          expect(Date.parse(result[i].updated_at)).toBeGreaterThanOrEqual(
            Date.parse(result[i + 1].updated_at)
          );
        }
      });

      test("skips the skipSessionId session", () => {
        const dbPath = realSqliteDbPath();
        expect(dbPath).not.toBeNull();

        const adapter = createCodexAdapter(
          { agent: "codex", alias: "work", enabled: true, path: dbPath! },
          {}
        );

        // Get the first session to use as skip target
        const all = adapter.listSessionsByTimeRange!({ since: undefined, limit: 1 });
        expect(all.length).toBeGreaterThan(0); // FAIL if SQLite path not handled
        const skipId = all[0].id;

        // Request with skipSessionId — the skipped session must not appear
        const result = adapter.listSessionsByTimeRange!({
          since: undefined,
          limit: 50,
          skipSessionId: skipId,
        });

        expect(result.some((s) => s.id === skipId)).toBe(false);
      });

      test("returns empty array when since is a future timestamp", () => {
        const dbPath = realSqliteDbPath();
        expect(dbPath).not.toBeNull();

        const adapter = createCodexAdapter(
          { agent: "codex", alias: "work", enabled: true, path: dbPath! },
          {}
        );

        // A timestamp well in the future
        const futureSince = new Date("2099-01-01T00:00:00Z").getTime();
        const result = adapter.listSessionsByTimeRange!({ since: futureSince, limit: 50 });

        expect(result).toEqual([]);
      });
    });
  });
});
