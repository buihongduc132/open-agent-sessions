/**
 * ZCode Adapter Tests — RED PHASE
 *
 * These tests describe the contract the GREEN-phase zcode adapter must satisfy.
 * Against the current stub (createZcodeAdapter throws "not implemented (RED)"),
 * every test FAILS — that is intentional.
 *
 * The fixture schema here mirrors the VERIFIED live ~/.zcode/cli/db/db.sqlite
 * DDL exactly (ms-epoch times; role inside message.data JSON; type inside
 * part.data JSON). See src/adapters/zcode.ts for the schema notes.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach } from "bun:test";
import { createZcodeAdapter } from "../../src/adapters/zcode";

// ---------------------------------------------------------------------------
// Fixture: build an in-memory SQLite DB matching the live zcode schema.
// ---------------------------------------------------------------------------

function createTestZcodeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE session (
      id text primary key,
      project_id text not null,
      parent_id text,
      slug text not null,
      directory text not null,
      title text not null,
      version text not null,
      time_created integer not null,
      time_updated integer not null,
      task_type text not null default 'interactive',
      title_source text not null default 'first_input',
      time_archived integer
    );

    CREATE TABLE message (
      id text primary key,
      session_id text not null references session(id) on delete cascade,
      time_created integer not null,
      time_updated integer not null,
      data text not null,
      sequence integer
    );

    CREATE TABLE part (
      id text primary key,
      message_id text not null references message(id) on delete cascade,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null,
      sequence integer
    );

    CREATE TABLE tool_usage (
      id text primary key,
      session_id text not null,
      tool_call_id text not null,
      tool_name text not null,
      status text not null check(status in ('running','completed','error','cancelled')),
      started_at integer not null,
      completed_at integer,
      duration_ms integer
    );
  `);
  return db;
}

type TestEntry = { agent: "zcode"; alias: string; enabled: boolean };

// --- Insert helpers -------------------------------------------------------

function insertSession(db: Database, opts: {
  id: string;
  project_id?: string;
  parent_id?: string | null;
  slug?: string;
  directory?: string;
  title: string;
  version?: string;
  time_created: number;
  time_updated: number;
  task_type?: string;
}): void {
  const projectId = opts.project_id ?? "proj_test";
  const parentId = opts.parent_id == null ? "NULL" : `'${opts.parent_id}'`;
  const slug = opts.slug ?? opts.id;
  const directory = opts.directory ?? "/home/x/proj";
  const version = opts.version ?? "1.0.0";
  const taskType = opts.task_type ?? "interactive";
  db.run(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, task_type, title_source)
     VALUES (?, ?, ${parentId}, ?, ?, ?, ?, ?, ?, ?, 'first_input')`,
    [opts.id, projectId, slug, directory, opts.title, version, opts.time_created, opts.time_updated, taskType]
  );
}

function insertMessage(db: Database, opts: {
  id: string;
  session_id: string;
  data: string; // JSON blob; must carry role at data.role
  time_created?: number;
  time_updated?: number;
  sequence?: number | null;
}): void {
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.session_id,
      opts.time_created ?? 0,
      opts.time_updated ?? 0,
      opts.data,
      opts.sequence ?? null,
    ]
  );
}

function insertPart(db: Database, opts: {
  id: string;
  message_id: string;
  session_id: string;
  data: string; // JSON blob; must carry type at data.type (text|tool|reasoning)
  time_created?: number;
  time_updated?: number;
  sequence?: number | null;
}): void {
  db.run(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.message_id,
      opts.session_id,
      opts.time_created ?? 0,
      opts.time_updated ?? 0,
      opts.data,
      opts.sequence ?? null,
    ]
  );
}

function insertToolUsage(db: Database, opts: {
  id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  status?: string;
  started_at: number;
  completed_at?: number | null;
  duration_ms?: number | null;
}): void {
  db.run(
    `INSERT INTO tool_usage (id, session_id, tool_call_id, tool_name, status, started_at, completed_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.session_id,
      opts.tool_call_id,
      opts.tool_name,
      opts.status ?? "completed",
      opts.started_at,
      opts.completed_at ?? null,
      opts.duration_ms ?? null,
    ]
  );
}

// Build the canonical two-session seed used across happy-path tests.
//   sess_test1: user text message
//   sess_test2: assistant reply with a reasoning part + a tool part, plus a tool_usage row for Read
function seedTwoSessions(db: Database): void {
  // Session 1 — older
  insertSession(db, {
    id: "sess_test1",
    directory: "/home/x/proj",
    title: "Test session",
    time_created: 1785000000000,
    time_updated: 1785000100000,
  });
  insertMessage(db, {
    id: "msg1",
    session_id: "sess_test1",
    time_created: 1785000000000,
    time_updated: 1785000000000,
    sequence: 0,
    data: JSON.stringify({ role: "user", time: { created: 1785000000000 } }),
  });
  insertPart(db, {
    id: "part1",
    message_id: "msg1",
    session_id: "sess_test1",
    time_created: 1785000000000,
    time_updated: 1785000000000,
    sequence: 0,
    data: JSON.stringify({ type: "text", text: "hello" }),
  });

  // Session 2 — newer; assistant message with reasoning + tool parts
  insertSession(db, {
    id: "sess_test2",
    directory: "/home/x/proj",
    title: "Read a file session",
    time_created: 1785007100000,
    time_updated: 1785007200000,
  });
  insertMessage(db, {
    id: "msg2",
    session_id: "sess_test2",
    time_created: 1785007100000,
    time_updated: 1785007100000,
    sequence: 0,
    data: JSON.stringify({ role: "user", time: { created: 1785007100000 } }),
  });
  insertPart(db, {
    id: "part2",
    message_id: "msg2",
    session_id: "sess_test2",
    time_created: 1785007100000,
    time_updated: 1785007100000,
    sequence: 0,
    data: JSON.stringify({ type: "text", text: "show me src/index.ts" }),
  });
  insertMessage(db, {
    id: "msg3",
    session_id: "sess_test2",
    time_created: 1785007150000,
    time_updated: 1785007150000,
    sequence: 1,
    data: JSON.stringify({
      role: "assistant",
      time: { created: 1785007150000 },
      model: { id: "zcode-model" },
      agent: "zcode-agent",
    }),
  });
  // reasoning part comes before the tool part within the assistant message
  insertPart(db, {
    id: "part3",
    message_id: "msg3",
    session_id: "sess_test2",
    time_created: 1785007150000,
    time_updated: 1785007150000,
    sequence: 0,
    data: JSON.stringify({ type: "reasoning", text: "I should read the file first" }),
  });
  insertPart(db, {
    id: "part4",
    message_id: "msg3",
    session_id: "sess_test2",
    time_created: 1785007160000,
    time_updated: 1785007160000,
    sequence: 1,
    data: JSON.stringify({
      type: "tool",
      tool: "Read",
      state: { path: "src/index.ts" },
    }),
  });
  insertToolUsage(db, {
    id: "tu1",
    session_id: "sess_test2",
    tool_call_id: "call_1",
    tool_name: "Read",
    status: "completed",
    started_at: 1785007160000,
    completed_at: 1785007165000,
    duration_ms: 5000,
  });
}

function makeAdapter(db: Database) {
  return createZcodeAdapter(
    { agent: "zcode", alias: "test", enabled: true } as TestEntry,
    { dbPath: db }
  );
}

describe("zcode adapter", () => {
  let db: Database;
  beforeEach(() => { db = createTestZcodeDb(); });

  // -------------------------------------------------------------------------
  // Failure paths FIRST (worst-first testing)
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("throws when dbPath points at a nonexistent file (deferred — OT4)", () => {
      const adapter = createZcodeAdapter(
        { agent: "zcode", alias: "test", enabled: true } as TestEntry,
        { dbPath: "/nonexistent/path/to/db.sqlite" }
      );
      expect(() => adapter.listSessions()).toThrow(/database not found|no such|not found/i);
    });

    it("throws 'schema mismatch' when the session table is missing (deferred — OT4)", () => {
      // Build a DB with only a stray table — none of the zcode tables exist.
      const emptyDb = new Database(":memory:");
      emptyDb.exec("CREATE TABLE unrelated (id text);");
      const adapter = createZcodeAdapter(
        { agent: "zcode", alias: "test", enabled: true } as TestEntry,
        { dbPath: emptyDb }
      );
      expect(() => adapter.listSessions()).toThrow(/schema mismatch/i);
    });
  });

  // -------------------------------------------------------------------------
  // Happy paths
  // -------------------------------------------------------------------------

  describe("listSessions", () => {
    it("returns seeded sessions with correct summary fields, sorted by updated_at desc", () => {
      seedTwoSessions(db);

      const sessions = makeAdapter(db).listSessions();

      expect(sessions).toHaveLength(2);

      // newer session first
      expect(sessions[0].id).toBe("sess_test2");
      expect(sessions[1].id).toBe("sess_test1");

      const s = sessions[1]; // sess_test1
      expect(s.agent).toBe("zcode");
      expect(s.alias).toBe("test");
      expect(s.title).toBe("Test session");
      // ms-epoch NOT divided by 1000
      expect(s.created_at).toBe(new Date(1785000000000).toISOString());
      expect(s.updated_at).toBe(new Date(1785000100000).toISOString());
      expect(s.message_count).toBe(1);
      expect(s.storage).toBe("db");
    });
  });

  describe("listSessionsByTimeRange", () => {
    it("filters sessions by since/until (ms) and honours limit", () => {
      seedTwoSessions(db);

      const adapter = makeAdapter(db);

      // Only sess_test1 falls in [1785000050000, 1785000150000]
      const only1 = adapter.listSessionsByTimeRange!({
        since: 1785000050000,
        until: 1785000150000,
      });
      expect(only1).toHaveLength(1);
      expect(only1[0].id).toBe("sess_test1");

      // Both sessions fall in the full window
      const both = adapter.listSessionsByTimeRange!({
        since: 1784999000000,
        until: 1785010000000,
      });
      expect(both).toHaveLength(2);
      expect(both[0].id).toBe("sess_test2"); // newest first
      expect(both[1].id).toBe("sess_test1");

      // limit=1 returns only the newest
      const limited = adapter.listSessionsByTimeRange!({
        since: 1784999000000,
        until: 1785010000000,
        limit: 1,
      });
      expect(limited).toHaveLength(1);
      expect(limited[0].id).toBe("sess_test2");
    });
  });

  describe("getSessionDetail", () => {
    it("joins message + part; role from data.role, part type from data.type", async () => {
      seedTwoSessions(db);

      const detail = await makeAdapter(db).getSessionDetail!("sess_test2", {});

      // summary fields
      expect(detail.id).toBe("sess_test2");
      expect(detail.agent).toBe("zcode");

      // Two messages: the user msg (msg2) and the assistant msg (msg3)
      expect(detail.messages).toHaveLength(2);

      const user = detail.messages!.find((m) => m.role === "user");
      const assistant = detail.messages!.find((m) => m.role === "assistant");
      expect(user).toBeDefined();
      expect(assistant).toBeDefined();

      // user message carries a single text part with the right text
      const userText = user!.parts.find((p) => p.type === "text") as { type: "text"; text: string };
      expect(userText?.text).toBe("show me src/index.ts");

      // assistant message carries BOTH a reasoning part and a tool part
      const reasoning = assistant!.parts.find((p) => p.type === "reasoning") as {
        type: "reasoning";
        text: string;
      };
      expect(reasoning?.text).toBe("I should read the file first");

      const toolPart = assistant!.parts.find((p) => p.type === "tool") as {
        type: "tool";
        tool: string;
        state: Record<string, unknown>;
      };
      expect(toolPart?.tool).toBe("Read");
      expect(toolPart?.state).toMatchObject({ path: "src/index.ts" });
    });

    it("throws 'session not found' for an unknown id", async () => {
      seedTwoSessions(db);
      await expect(
        makeAdapter(db).getSessionDetail!("does-not-exist", {})
      ).rejects.toThrow(/session not found/i);
    });
  });

  describe("searchSessions", () => {
    it("matches sessions by title (case-insensitive LIKE)", () => {
      seedTwoSessions(db);

      const results = makeAdapter(db).searchSessions!({ text: "read a file" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("sess_test2");
    });
  });

  describe("toolSearchSessions", () => {
    it("matches sessions by tool_usage.tool_name", () => {
      seedTwoSessions(db);

      const results = makeAdapter(db).toolSearchSessions!({ tool: "Read" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("sess_test2");
    });
  });

  describe("time conversion", () => {
    it("treats timestamps as ms-epoch (no /1000) when building ISO strings", () => {
      seedTwoSessions(db);

      const sessions = makeAdapter(db).listSessions();
      const s1 = sessions.find((s) => s.id === "sess_test1")!;

      // 1785000000000 ms → the exact ISO string (NOT 1785000000000 seconds)
      expect(s1.created_at).toBe(new Date(1785000000000).toISOString());
      // Sanity: the ms-epoch value given in the spec maps to a valid ISO date.
      const specIso = new Date(1785007107214).toISOString();
      expect(specIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // And it must NOT equal the seconds interpretation.
      expect(specIso).not.toBe(new Date(1785007107214 / 1000).toISOString());
    });
  });

  // -------------------------------------------------------------------------
  // MAJOR 3: parentSessionId populated from session.parent_id
  // -------------------------------------------------------------------------

  describe("parentSessionId", () => {
    it("populates parentSessionId when session.parent_id is set", () => {
      insertSession(db, {
        id: "sess_child",
        parent_id: "sess_parent",
        title: "Child session",
        time_created: 1785000000000,
        time_updated: 1785000100000,
      });
      insertSession(db, {
        id: "sess_parent",
        title: "Parent session",
        time_created: 1785000000000,
        time_updated: 1785000100000,
      });

      const sessions = makeAdapter(db).listSessions();
      const child = sessions.find((s) => s.id === "sess_child")!;
      const parent = sessions.find((s) => s.id === "sess_parent")!;

      expect(child.parentSessionId).toBe("sess_parent");
      // Sessions with no parent_id must NOT carry parentSessionId.
      expect(parent.parentSessionId).toBeUndefined();
    });

    it("populates parentSessionId via listSessionsByTimeRange too", () => {
      insertSession(db, {
        id: "sess_child",
        parent_id: "sess_parent",
        title: "Child session",
        time_created: 1785000000000,
        time_updated: 1785000100000,
      });

      const sessions = makeAdapter(db).listSessionsByTimeRange!({
        since: 0,
        until: 8640000000000000,
      });
      const child = sessions.find((s) => s.id === "sess_child")!;
      expect(child.parentSessionId).toBe("sess_parent");
    });
  });

  // -------------------------------------------------------------------------
  // MAJOR 4: archived sessions (time_archived set) excluded from list/search
  // -------------------------------------------------------------------------

  describe("archive exclusion", () => {
    it("excludes sessions with time_archived set from listSessions", () => {
      insertSession(db, {
        id: "sess_live",
        title: "Live session",
        time_created: 1785000000000,
        time_updated: 1785000100000,
      });
      insertSession(db, {
        id: "sess_archived",
        title: "Archived session",
        time_created: 1785000000000,
        time_updated: 1785000200000,
      });
      db.run("UPDATE session SET time_archived = 1785000200000 WHERE id = ?", [
        "sess_archived",
      ]);

      const sessions = makeAdapter(db).listSessions();
      const ids = sessions.map((s) => s.id);

      expect(ids).toContain("sess_live");
      expect(ids).not.toContain("sess_archived");
    });

    it("excludes archived sessions from listSessionsByTimeRange", () => {
      insertSession(db, {
        id: "sess_archived",
        title: "Archived session",
        time_created: 1785000000000,
        time_updated: 1785000200000,
      });
      db.run("UPDATE session SET time_archived = 1785000200000 WHERE id = ?", [
        "sess_archived",
      ]);

      const sessions = makeAdapter(db).listSessionsByTimeRange!({
        since: 0,
        until: 8640000000000000,
      });
      expect(sessions.map((s) => s.id)).not.toContain("sess_archived");
    });

    it("excludes archived sessions from searchSessions", () => {
      insertSession(db, {
        id: "sess_archived",
        title: "Archived searchtarget",
        time_created: 1785000000000,
        time_updated: 1785000200000,
      });
      db.run("UPDATE session SET time_archived = 1785000200000 WHERE id = ?", [
        "sess_archived",
      ]);

      const results = makeAdapter(db).searchSessions!({ text: "searchtarget" });
      expect(results.map((s) => s.id)).not.toContain("sess_archived");
    });
  });
});

