/**
 * Hermes Adapter Tests — R-43, R-44, R-45
 */

import { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach } from "bun:test";
import { createHermesAdapter } from "../src/adapters/hermes";

function createTestHermesDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT,
      model_config TEXT, system_prompt TEXT, parent_session_id TEXT,
      started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
      message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0, billing_provider TEXT,
      billing_base_url TEXT, billing_mode TEXT, estimated_cost_usd REAL,
      actual_cost_usd REAL, cost_status TEXT, cost_source TEXT,
      pricing_version TEXT, title TEXT,
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT, tool_call_id TEXT,
      tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL,
      token_count INTEGER, finish_reason TEXT, reasoning TEXT,
      reasoning_details TEXT, codex_reasoning_items TEXT
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content, content=messages, content_rowid=id
    );
    CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;
    CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
  return db;
}

type TestEntry = { agent: "hermes"; alias: string; enabled: boolean };

function insertSession(db: Database, opts: {
  id: string; source?: string; model?: string; title?: string | null;
  parent_session_id?: string | null; started_at: number;
  ended_at?: number | null; message_count?: number; tool_call_count?: number;
}): void {
  const t = opts.title === null ? "NULL" : `'${opts.title}'`;
  const p = opts.parent_session_id === null ? "NULL" : `'${opts.parent_session_id}'`;
  const e = opts.ended_at === null ? "NULL" : String(opts.ended_at);
  db.exec(`INSERT INTO sessions (id, source, model, title, parent_session_id, started_at, ended_at, message_count, tool_call_count)
    VALUES ('${opts.id}', '${opts.source ?? "cli"}', '${opts.model ?? "test"}', ${t}, ${p}, ${opts.started_at}, ${e}, ${opts.message_count ?? 0}, ${opts.tool_call_count ?? 0})`);
}

function insertMessage(db: Database, opts: {
  session_id: string; role: string; content?: string | null;
  tool_name?: string | null; tool_calls?: string | null;
  reasoning?: string | null; timestamp: number;
}): void {
  const c = (opts.content == null) ? "NULL" : `'${opts.content}'`;
  const tn = (opts.tool_name == null) ? "NULL" : `'${opts.tool_name}'`;
  const tc = (opts.tool_calls == null) ? "NULL" : `'${opts.tool_calls}'`;
  const r = (opts.reasoning == null) ? "NULL" : `'${opts.reasoning}'`;
  db.exec(`INSERT INTO messages (session_id, role, content, tool_name, tool_calls, reasoning, timestamp)
    VALUES ('${opts.session_id}', '${opts.role}', ${c}, ${tn}, ${tc}, ${r}, ${opts.timestamp})`);
}

function makeAdapter(db: Database) {
  return createHermesAdapter(
    { agent: "hermes", alias: "test", enabled: true } as TestEntry,
    { dbPath: db }
  );
}

describe("hermes adapter", () => {
  let db: Database;
  beforeEach(() => { db = createTestHermesDb(); });

  describe("listSessions", () => {
    it("returns all sessions sorted by updated_at desc", () => {
      insertSession(db, { id: "old", started_at: 1000, ended_at: 2000, message_count: 2 });
      insertMessage(db, { session_id: "old", role: "user", content: "first", timestamp: 1000 });
      insertMessage(db, { session_id: "old", role: "assistant", content: "reply", timestamp: 2000 });
      insertSession(db, { id: "new", started_at: 3000, ended_at: 4000, message_count: 1 });
      insertMessage(db, { session_id: "new", role: "user", content: "hello", timestamp: 3000 });

      const sessions = makeAdapter(db).listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe("new");
      expect(sessions[1].id).toBe("old");
    });

    it("derives title from first user message when null", () => {
      insertSession(db, { id: "s1", started_at: 1000, ended_at: 2000, title: null, message_count: 1 });
      insertMessage(db, { session_id: "s1", role: "user", content: "How do I fix the build error?", timestamp: 1000 });

      expect(makeAdapter(db).listSessions()[0].title).toBe("How do I fix the build error?");
    });

    it("truncates derived title to 80 chars", () => {
      insertSession(db, { id: "s1", started_at: 1000, ended_at: 2000, title: null, message_count: 1 });
      insertMessage(db, { session_id: "s1", role: "user", content: "A".repeat(120), timestamp: 1000 });

      const title = makeAdapter(db).listSessions()[0].title;
      expect(title.length).toBeLessThanOrEqual(80);
    });

    it("uses session title when present", () => {
      insertSession(db, { id: "s1", started_at: 1000, ended_at: 2000, title: "My Title", message_count: 1 });
      insertMessage(db, { session_id: "s1", role: "user", content: "ignored", timestamp: 1000 });

      expect(makeAdapter(db).listSessions()[0].title).toBe("My Title");
    });

    it("maps parent_session_id to parentSessionId", () => {
      insertSession(db, { id: "parent", started_at: 1000, ended_at: 2000, message_count: 1 });
      insertSession(db, { id: "child", started_at: 3000, ended_at: null, parent_session_id: "parent", message_count: 0 });

      const child = makeAdapter(db).listSessions().find(s => s.id === "child");
      expect(child?.parentSessionId).toBe("parent");
    });

    it("returns empty array when no sessions", () => {
      expect(makeAdapter(db).listSessions()).toEqual([]);
    });

    it("uses latest message timestamp when ended_at is null", () => {
      insertSession(db, { id: "s1", started_at: 1000, ended_at: null, message_count: 2 });
      insertMessage(db, { session_id: "s1", role: "user", content: "a", timestamp: 1000 });
      insertMessage(db, { session_id: "s1", role: "assistant", content: "b", timestamp: 5000 });

      expect(makeAdapter(db).listSessions()[0].updated_at).toBe(new Date(5000 * 1000).toISOString());
    });

    it("maps storage as db", () => {
      insertSession(db, { id: "s1", started_at: 1000, ended_at: 2000, message_count: 1 });
      insertMessage(db, { session_id: "s1", role: "user", content: "hi", timestamp: 1000 });

      expect(makeAdapter(db).listSessions()[0].storage).toBe("db");
    });
  });

  describe("getSessionDetail", () => {
    it("returns messages with correct roles", async () => {
      insertSession(db, { id: "s1", started_at: 1000, ended_at: 3000, message_count: 2 });
      insertMessage(db, { session_id: "s1", role: "user", content: "hello", timestamp: 1000 });
      insertMessage(db, { session_id: "s1", role: "assistant", content: "hi", timestamp: 2000 });

      const detail = await makeAdapter(db).getSessionDetail!("s1", {});
      expect(detail.messages).toHaveLength(2);
      expect(detail.messages![0].role).toBe("user");
      expect(detail.messages![1].role).toBe("assistant");
    });

    it("maps tool messages to tool parts", async () => {
      insertSession(db, { id: "s1", started_at: 1000, ended_at: 3000, message_count: 1 });
      insertMessage(db, { session_id: "s1", role: "tool", content: '{"output":"ok"}', tool_name: "terminal", timestamp: 2000 });

      const detail = await makeAdapter(db).getSessionDetail!("s1", {});
      const toolPart = detail.messages![0].parts.find(p => p.type === "tool") as { type: "tool"; tool: string };
      expect(toolPart?.tool).toBe("terminal");
    });

    it("maps reasoning to reasoning part", async () => {
      insertSession(db, { id: "s1", started_at: 1000, ended_at: 3000, message_count: 1 });
      insertMessage(db, { session_id: "s1", role: "assistant", content: "ans", reasoning: "thinking...", timestamp: 1000 });

      const detail = await makeAdapter(db).getSessionDetail!("s1", {});
      const rp = detail.messages![0].parts.find(p => p.type === "reasoning") as { type: "reasoning"; text: string };
      expect(rp?.text).toBe("thinking...");
    });

    it("supports first selection mode", async () => {
      insertSession(db, { id: "s1", started_at: 1000, ended_at: 4000, message_count: 3 });
      insertMessage(db, { session_id: "s1", role: "user", content: "m1", timestamp: 1000 });
      insertMessage(db, { session_id: "s1", role: "assistant", content: "m2", timestamp: 2000 });
      insertMessage(db, { session_id: "s1", role: "user", content: "m3", timestamp: 3000 });

      const detail = await makeAdapter(db).getSessionDetail!("s1", { selection: { mode: "first", count: 1 } });
      expect(detail.messages).toHaveLength(1);
    });

    it("supports last selection mode", async () => {
      insertSession(db, { id: "s1", started_at: 1000, ended_at: 4000, message_count: 3 });
      insertMessage(db, { session_id: "s1", role: "user", content: "m1", timestamp: 1000 });
      insertMessage(db, { session_id: "s1", role: "assistant", content: "m2", timestamp: 2000 });
      insertMessage(db, { session_id: "s1", role: "user", content: "m3", timestamp: 3000 });

      const detail = await makeAdapter(db).getSessionDetail!("s1", { selection: { mode: "last", count: 1 } });
      expect(detail.messages).toHaveLength(1);
      expect((detail.messages![0].parts[0] as { text: string }).text).toBe("m3");
    });

    it("supports userOnly filter", async () => {
      insertSession(db, { id: "s1", started_at: 1000, ended_at: 4000, message_count: 3 });
      insertMessage(db, { session_id: "s1", role: "user", content: "q1", timestamp: 1000 });
      insertMessage(db, { session_id: "s1", role: "assistant", content: "a1", timestamp: 2000 });
      insertMessage(db, { session_id: "s1", role: "user", content: "q2", timestamp: 3000 });

      const detail = await makeAdapter(db).getSessionDetail!("s1", { userOnly: true });
      expect(detail.messages).toHaveLength(2);
      expect(detail.messages!.every(m => m.role === "user")).toBe(true);
    });

    it("throws when session not found", async () => {
      await expect(makeAdapter(db).getSessionDetail!("nope", {})).rejects.toThrow(/not found/);
    });
  });

  describe("searchSessions", () => {
    it("finds sessions by content via FTS5", () => {
      insertSession(db, { id: "s1", started_at: 1000, ended_at: 2000, message_count: 1 });
      insertMessage(db, { session_id: "s1", role: "user", content: "deploy kubernetes cluster", timestamp: 1000 });
      insertSession(db, { id: "s2", started_at: 3000, ended_at: 4000, message_count: 1 });
      insertMessage(db, { session_id: "s2", role: "user", content: "fix css layout", timestamp: 3000 });

      const results = makeAdapter(db).searchSessions!({ text: "kubernetes" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("s1");
    });

    it("finds sessions by title", () => {
      insertSession(db, { id: "s1", started_at: 1000, ended_at: 2000, title: "K8s Deploy", message_count: 1 });
      insertMessage(db, { session_id: "s1", role: "user", content: "hi", timestamp: 1000 });

      const results = makeAdapter(db).searchSessions!({ text: "k8s" });
      expect(results).toHaveLength(1);
    });
  });

  describe("listSessionsByTimeRange", () => {
    it("filters sessions by started_at range", () => {
      insertSession(db, { id: "old", started_at: 1, ended_at: 2, message_count: 1 });
      insertMessage(db, { session_id: "old", role: "user", content: "a", timestamp: 1 });
      insertSession(db, { id: "mid", started_at: 5, ended_at: 6, message_count: 1 });
      insertMessage(db, { session_id: "mid", role: "user", content: "b", timestamp: 5 });
      insertSession(db, { id: "new", started_at: 10, ended_at: 11, message_count: 1 });
      insertMessage(db, { session_id: "new", role: "user", content: "c", timestamp: 10 });

      const results = makeAdapter(db).listSessionsByTimeRange!({ since: 3000, until: 8000 });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("mid");
    });
  });

  describe("toolSearchSessions", () => {
    it("finds sessions with tool calls", () => {
      insertSession(db, { id: "t1", started_at: 1000, ended_at: 3000, tool_call_count: 1, message_count: 2 });
      insertMessage(db, { session_id: "t1", role: "user", content: "run ls", timestamp: 1000 });
      insertMessage(db, { session_id: "t1", role: "tool", content: "{}", tool_name: "terminal", timestamp: 2000 });
      insertSession(db, { id: "t2", started_at: 4000, ended_at: 5000, message_count: 1 });
      insertMessage(db, { session_id: "t2", role: "user", content: "chat", timestamp: 4000 });

      const results = makeAdapter(db).toolSearchSessions!({ tool: "terminal" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("t1");
    });
  });

  describe("forkSession", () => {
    it("returns valid ForkResult stub", async () => {
      const result = await makeAdapter(db).forkSession!("src-123", "opencode", "main");
      expect(result.parentSessionId).toBe("src-123");
      expect(result.destAgent).toBe("opencode");
      expect(result.destAlias).toBe("main");
      expect(result.newSessionId).toBeTruthy();
      expect(result.forkedAt).toBeTruthy();
    });
  });

  describe("findSimilarSessions", () => {
    it("returns empty array (stub)", async () => {
      expect(await makeAdapter(db).findSimilarSessions!("x")).toEqual([]);
    });
  });
});
