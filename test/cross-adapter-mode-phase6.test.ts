/**
 * Cross-Adapter — Phase 6 Parity (RED PHASE)
 *
 * Failing tests for the final gap: SessionReadOptions.mode field.
 *
 * The `mode` field is already defined in src/core/types.ts:
 *   type SessionReadMode = "last_message" | "all_no_tools" | "all_with_tools";
 *   interface SessionReadOptions { mode?: SessionReadMode; ... }
 *
 * But NO adapter currently implements it. This test file proves that gap
 * across all 4 adapters (pi, claude, agy, zcode).
 *
 * Mode semantics:
 *   - "last_message"   → return only the last message (no selection/range)
 *   - "all_no_tools"   → return all messages but filter out tool parts
 *   - "all_with_tools" → return all messages including tool parts (default)
 *
 * Reference: src/core/types.ts (SessionReadMode, SessionReadOptions)
 * Gold standard: src/adapters/zcode.ts (95% parity, reference impl)
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createPiAdapter } from "../src/adapters/pi";
import { createClaudeAdapter } from "../src/adapters/claude";
import { createAntigravityAdapter } from "../src/adapters/antigravity";
import { createZcodeAdapter } from "../src/adapters/zcode";
import type { Adapter, SessionMessage } from "../src/core/types";

// ============================================================================
// Shared fixtures
// ============================================================================

const ISO_A = "2024-01-01T00:00:00.000Z";
const ISO_B = "2024-01-01T00:01:00.000Z";
const ISO_C = "2024-01-01T00:02:00.000Z";
const ISO_D = "2024-01-01T00:03:00.000Z";

// ============================================================================
// Pi adapter helpers
// ============================================================================

const PI_TMP = join(process.cwd(), ".tmp-pi-phase6-test");

function makePiAdapter(): Adapter {
  return createPiAdapter(
    { agent: "pi", alias: "pi-phase6", enabled: true },
    { defaultPath: PI_TMP }
  );
}

function piSeedEvents(sessionId: string, events: Array<Record<string, unknown>>): void {
  const dir = join(PI_TMP, sessionId);
  mkdirSync(dir, { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(dir, "events.jsonl"), body);
}

// ============================================================================
// Claude adapter helpers
// ============================================================================

const CLAUDE_TMP = join(process.cwd(), ".tmp-claude-phase6-test");

function makeClaudeAdapter(): Adapter {
  return createClaudeAdapter(
    { agent: "claude", alias: "claude-phase6", enabled: true },
    { defaultPath: CLAUDE_TMP }
  );
}

function claudeSeedRecords(sessionId: string, records: Array<Record<string, unknown>>): void {
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(CLAUDE_TMP, `${sessionId}.jsonl`), body);
}

// ============================================================================
// AgY (antigravity) adapter helpers
// ============================================================================

const AGY_TMP = join(tmpdir(), "oas-agy-phase6-test");
const AGY_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeAgyAdapter(): Adapter {
  return createAntigravityAdapter(
    { agent: "antigravity", alias: "agy-phase6", enabled: true, path: AGY_TMP },
    {}
  );
}

function agySeedLogEntries(entries: Array<Record<string, unknown>>): void {
  const logDir = join(AGY_TMP, "brain", AGY_UUID, ".system_generated", "logs");
  mkdirSync(logDir, { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(logDir, "overview.txt"), body);
}

// ============================================================================
// Zcode adapter helpers
// ============================================================================

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
      status text not null,
      started_at integer not null,
      completed_at integer,
      duration_ms integer
    );
  `);
  return db;
}

function zcodeInsertSession(db: Database, opts: {
  id: string;
  title: string;
  time_created: number;
  time_updated: number;
}): void {
  db.run(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, task_type, title_source)
     VALUES (?, 'proj_test', NULL, ?, '/home/x/proj', ?, '1.0.0', ?, ?, 'interactive', 'first_input')`,
    [opts.id, opts.id, opts.title, opts.time_created, opts.time_updated]
  );
}

function zcodeInsertMessage(db: Database, opts: {
  id: string;
  session_id: string;
  data: string;
  time_created: number;
}): void {
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [opts.id, opts.session_id, opts.time_created, opts.time_created, opts.data]
  );
}

function zcodeInsertPart(db: Database, opts: {
  id: string;
  message_id: string;
  session_id: string;
  data: string;
  time_created: number;
}): void {
  db.run(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [opts.id, opts.message_id, opts.session_id, opts.time_created, opts.time_created, opts.data]
  );
}

function makeZcodeAdapter(db: Database): Adapter {
  return createZcodeAdapter(
    { agent: "zcode", alias: "zcode-phase6", enabled: true },
    { dbPath: db }
  );
}

// ============================================================================
// Tests
// ============================================================================

describe("Cross-Adapter — Phase 6 Parity (RED): SessionReadOptions.mode", () => {
  // --- Pi adapter: mode tests ---

  describe("pi adapter — mode field", () => {
    beforeEach(() => {
      rmSync(PI_TMP, { recursive: true, force: true });
      mkdirSync(PI_TMP, { recursive: true });
    });

    afterEach(() => {
      rmSync(PI_TMP, { recursive: true, force: true });
    });

    test("mode 'last_message' returns only the last message", async () => {
      // Seed 4 messages: user/assistant/user/assistant
      piSeedEvents("sess-multi", [
        { type: "message", id: "m1", timestamp: ISO_A, message: { role: "user", content: "msg-1" } },
        { type: "message", id: "m2", timestamp: ISO_B, message: { role: "assistant", content: "msg-2" } },
        { type: "message", id: "m3", timestamp: ISO_C, message: { role: "user", content: "msg-3" } },
        { type: "message", id: "m4", timestamp: ISO_D, message: { role: "assistant", content: "msg-4" } },
      ]);
      const adapter = makePiAdapter();
      const detail = await adapter.getSessionDetail!("sess-multi", { mode: "last_message" });
      // RED: pi adapter ignores mode, returns all 4 messages
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages![0].id).toBe("m4");
      expect(detail.messages![0].role).toBe("assistant");
    });

    test("mode 'all_no_tools' returns all messages but filters out tool parts", async () => {
      // Seed 2 messages: user (text only), assistant (text + tool)
      piSeedEvents("sess-tools", [
        {
          type: "message", id: "m1", timestamp: ISO_A,
          message: { role: "user", content: "read this file" },
        },
        {
          type: "message", id: "m2", timestamp: ISO_B,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "reading file" },
              { type: "tool", tool: "Read", state: { path: "/etc/hosts" } },
            ],
          },
        },
      ]);
      const adapter = makePiAdapter();
      const detail = await adapter.getSessionDetail!("sess-tools", { mode: "all_no_tools" });
      // RED: pi adapter ignores mode, returns tool parts
      expect(detail.messages).toHaveLength(2);
      const assistantMsg = detail.messages![1];
      expect(assistantMsg.parts).toHaveLength(1); // only text, no tool
      expect(assistantMsg.parts[0].type).toBe("text");
      expect(assistantMsg.parts.every((p) => p.type !== "tool")).toBe(true);
    });

    test("mode 'all_with_tools' returns all messages including tool parts", async () => {
      // Same seed as above
      piSeedEvents("sess-tools2", [
        {
          type: "message", id: "m1", timestamp: ISO_A,
          message: { role: "user", content: "read this file" },
        },
        {
          type: "message", id: "m2", timestamp: ISO_B,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "reading file" },
              { type: "tool", tool: "Read", state: { path: "/etc/hosts" } },
            ],
          },
        },
      ]);
      const adapter = makePiAdapter();
      const detail = await adapter.getSessionDetail!("sess-tools2", { mode: "all_with_tools" });
      // This SHOULD pass even without mode impl (default behavior), but we test it
      // to ensure the mode field is explicitly handled, not just coincidentally working.
      expect(detail.messages).toHaveLength(2);
      const assistantMsg = detail.messages![1];
      expect(assistantMsg.parts.some((p) => p.type === "tool")).toBe(true);
    });
  });

  // --- Claude adapter: mode tests ---

  describe("claude adapter — mode field", () => {
    beforeEach(() => {
      rmSync(CLAUDE_TMP, { recursive: true, force: true });
      mkdirSync(CLAUDE_TMP, { recursive: true });
    });

    afterEach(() => {
      rmSync(CLAUDE_TMP, { recursive: true, force: true });
    });

    test("mode 'last_message' returns only the last message", async () => {
      claudeSeedRecords("sess-multi", [
        { type: "user", id: "m1", timestamp: ISO_A, content: "msg-1" },
        { type: "assistant", id: "m2", timestamp: ISO_B, content: "msg-2" },
        { type: "user", id: "m3", timestamp: ISO_C, content: "msg-3" },
        { type: "assistant", id: "m4", timestamp: ISO_D, content: "msg-4" },
      ]);
      const adapter = makeClaudeAdapter();
      const detail = await adapter.getSessionDetail!("sess-multi", { mode: "last_message" });
      // RED: claude adapter ignores mode, returns all 4 messages
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages![0].id).toBe("m4");
    });

    test("mode 'all_no_tools' returns all messages but filters out tool parts", async () => {
      claudeSeedRecords("sess-tools", [
        { type: "user", id: "m1", timestamp: ISO_A, content: "read this file" },
        {
          type: "assistant", id: "m2", timestamp: ISO_B,
          content: [
            { type: "text", text: "reading file" },
            { type: "tool_use", id: "tu1", name: "Read", input: { path: "/etc/hosts" } },
          ],
        },
      ]);
      const adapter = makeClaudeAdapter();
      const detail = await adapter.getSessionDetail!("sess-tools", { mode: "all_no_tools" });
      // RED: claude adapter ignores mode, returns tool parts
      expect(detail.messages).toHaveLength(2);
      const assistantMsg = detail.messages![1];
      expect(assistantMsg.parts.every((p) => p.type !== "tool")).toBe(true);
    });
  });

  // --- AgY (antigravity) adapter: mode tests ---

  describe("agy adapter — mode field", () => {
    beforeEach(() => {
      rmSync(AGY_TMP, { recursive: true, force: true });
      mkdirSync(AGY_TMP, { recursive: true });
    });

    afterEach(() => {
      rmSync(AGY_TMP, { recursive: true, force: true });
    });

    test("mode 'last_message' returns only the last message", async () => {
      agySeedLogEntries([
        { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: ISO_A, content: "msg-1" },
        { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: ISO_B, content: "msg-2" },
        { step_index: 2, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: ISO_C, content: "msg-3" },
        { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: ISO_D, content: "msg-4" },
      ]);
      const adapter = makeAgyAdapter();
      const detail = await adapter.getSessionDetail!(AGY_UUID, { mode: "last_message" });
      // RED: agy adapter ignores mode, returns all 4 messages
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages![0].role).toBe("assistant");
    });

    test("mode 'all_no_tools' returns all messages but filters out tool parts", async () => {
      agySeedLogEntries([
        { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: ISO_A, content: "read this" },
        {
          step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: ISO_B,
          content: "reading file",
          tool_calls: [{ name: "Read", args: { path: "/etc/hosts" } }],
        },
      ]);
      const adapter = makeAgyAdapter();
      const detail = await adapter.getSessionDetail!(AGY_UUID, { mode: "all_no_tools" });
      // RED: agy adapter ignores mode, returns tool parts
      expect(detail.messages).toHaveLength(2);
      const assistantMsg = detail.messages![1];
      expect(assistantMsg.parts.every((p) => p.type !== "tool")).toBe(true);
    });
  });

  // --- Zcode adapter: mode tests ---

  describe("zcode adapter — mode field", () => {
    let db: Database;

    beforeEach(() => {
      db = createTestZcodeDb();
    });

    afterEach(() => {
      db.close();
    });

    test("mode 'last_message' returns only the last message", async () => {
      const ts = Date.parse(ISO_A);
      zcodeInsertSession(db, { id: "sess-multi", title: "Multi", time_created: ts, time_updated: ts + 3000 });
      zcodeInsertMessage(db, { id: "m1", session_id: "sess-multi", data: JSON.stringify({ role: "user", time: { created: ts } }), time_created: ts });
      zcodeInsertMessage(db, { id: "m2", session_id: "sess-multi", data: JSON.stringify({ role: "assistant", time: { created: ts + 1000 } }), time_created: ts + 1000 });
      zcodeInsertMessage(db, { id: "m3", session_id: "sess-multi", data: JSON.stringify({ role: "user", time: { created: ts + 2000 } }), time_created: ts + 2000 });
      zcodeInsertMessage(db, { id: "m4", session_id: "sess-multi", data: JSON.stringify({ role: "assistant", time: { created: ts + 3000 } }), time_created: ts + 3000 });
      zcodeInsertPart(db, { id: "p1", message_id: "m1", session_id: "sess-multi", data: JSON.stringify({ type: "text", text: "msg-1" }), time_created: ts });
      zcodeInsertPart(db, { id: "p2", message_id: "m2", session_id: "sess-multi", data: JSON.stringify({ type: "text", text: "msg-2" }), time_created: ts + 1000 });
      zcodeInsertPart(db, { id: "p3", message_id: "m3", session_id: "sess-multi", data: JSON.stringify({ type: "text", text: "msg-3" }), time_created: ts + 2000 });
      zcodeInsertPart(db, { id: "p4", message_id: "m4", session_id: "sess-multi", data: JSON.stringify({ type: "text", text: "msg-4" }), time_created: ts + 3000 });

      const adapter = makeZcodeAdapter(db);
      const detail = await adapter.getSessionDetail!("sess-multi", { mode: "last_message" });
      // RED: zcode adapter ignores mode, returns all 4 messages
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages![0].id).toBe("m4");
    });

    test("mode 'all_no_tools' returns all messages but filters out tool parts", async () => {
      const ts = Date.parse(ISO_A);
      zcodeInsertSession(db, { id: "sess-tools", title: "Tools", time_created: ts, time_updated: ts + 1000 });
      zcodeInsertMessage(db, { id: "m1", session_id: "sess-tools", data: JSON.stringify({ role: "user", time: { created: ts } }), time_created: ts });
      zcodeInsertMessage(db, { id: "m2", session_id: "sess-tools", data: JSON.stringify({ role: "assistant", time: { created: ts + 1000 } }), time_created: ts + 1000 });
      zcodeInsertPart(db, { id: "p1", message_id: "m1", session_id: "sess-tools", data: JSON.stringify({ type: "text", text: "read this" }), time_created: ts });
      zcodeInsertPart(db, { id: "p2", message_id: "m2", session_id: "sess-tools", data: JSON.stringify({ type: "text", text: "reading" }), time_created: ts + 1000 });
      zcodeInsertPart(db, { id: "p3", message_id: "m2", session_id: "sess-tools", data: JSON.stringify({ type: "tool", tool: "Read", state: { path: "/etc/hosts" } }), time_created: ts + 1000 });

      const adapter = makeZcodeAdapter(db);
      const detail = await adapter.getSessionDetail!("sess-tools", { mode: "all_no_tools" });
      // RED: zcode adapter ignores mode, returns tool parts
      expect(detail.messages).toHaveLength(2);
      const assistantMsg = detail.messages![1];
      expect(assistantMsg.parts.every((p) => p.type !== "tool")).toBe(true);
    });
  });

  // --- Cross-adapter consistency tests ---

  describe("cross-adapter consistency — mode field", () => {
    let piAdapter: Adapter;
    let claudeAdapter: Adapter;
    let agyAdapter: Adapter;
    let zcodeDb: Database;
    let zcodeAdapter: Adapter;

    beforeEach(() => {
      // Setup pi
      rmSync(PI_TMP, { recursive: true, force: true });
      mkdirSync(PI_TMP, { recursive: true });
      piSeedEvents("sess-cross", [
        { type: "message", id: "m1", timestamp: ISO_A, message: { role: "user", content: "hello" } },
        { type: "message", id: "m2", timestamp: ISO_B, message: { role: "assistant", content: "hi there" } },
        { type: "message", id: "m3", timestamp: ISO_C, message: { role: "user", content: "how are you" } },
        { type: "message", id: "m4", timestamp: ISO_D, message: { role: "assistant", content: "I'm good" } },
      ]);
      piAdapter = makePiAdapter();

      // Setup claude
      rmSync(CLAUDE_TMP, { recursive: true, force: true });
      mkdirSync(CLAUDE_TMP, { recursive: true });
      claudeSeedRecords("sess-cross", [
        { type: "user", id: "m1", timestamp: ISO_A, content: "hello" },
        { type: "assistant", id: "m2", timestamp: ISO_B, content: "hi there" },
        { type: "user", id: "m3", timestamp: ISO_C, content: "how are you" },
        { type: "assistant", id: "m4", timestamp: ISO_D, content: "I'm good" },
      ]);
      claudeAdapter = makeClaudeAdapter();

      // Setup agy
      rmSync(AGY_TMP, { recursive: true, force: true });
      mkdirSync(AGY_TMP, { recursive: true });
      agySeedLogEntries([
        { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: ISO_A, content: "hello" },
        { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: ISO_B, content: "hi there" },
        { step_index: 2, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: ISO_C, content: "how are you" },
        { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: ISO_D, content: "I'm good" },
      ]);
      agyAdapter = makeAgyAdapter();

      // Setup zcode
      zcodeDb = createTestZcodeDb();
      const ts = Date.parse(ISO_A);
      zcodeInsertSession(zcodeDb, { id: "sess-cross", title: "Cross", time_created: ts, time_updated: ts + 3000 });
      zcodeInsertMessage(zcodeDb, { id: "m1", session_id: "sess-cross", data: JSON.stringify({ role: "user", time: { created: ts } }), time_created: ts });
      zcodeInsertMessage(zcodeDb, { id: "m2", session_id: "sess-cross", data: JSON.stringify({ role: "assistant", time: { created: ts + 1000 } }), time_created: ts + 1000 });
      zcodeInsertMessage(zcodeDb, { id: "m3", session_id: "sess-cross", data: JSON.stringify({ role: "user", time: { created: ts + 2000 } }), time_created: ts + 2000 });
      zcodeInsertMessage(zcodeDb, { id: "m4", session_id: "sess-cross", data: JSON.stringify({ role: "assistant", time: { created: ts + 3000 } }), time_created: ts + 3000 });
      zcodeInsertPart(zcodeDb, { id: "p1", message_id: "m1", session_id: "sess-cross", data: JSON.stringify({ type: "text", text: "hello" }), time_created: ts });
      zcodeInsertPart(zcodeDb, { id: "p2", message_id: "m2", session_id: "sess-cross", data: JSON.stringify({ type: "text", text: "hi there" }), time_created: ts + 1000 });
      zcodeInsertPart(zcodeDb, { id: "p3", message_id: "m3", session_id: "sess-cross", data: JSON.stringify({ type: "text", text: "how are you" }), time_created: ts + 2000 });
      zcodeInsertPart(zcodeDb, { id: "p4", message_id: "m4", session_id: "sess-cross", data: JSON.stringify({ type: "text", text: "I'm good" }), time_created: ts + 3000 });
      zcodeAdapter = makeZcodeAdapter(zcodeDb);
    });

    afterEach(() => {
      rmSync(PI_TMP, { recursive: true, force: true });
      rmSync(CLAUDE_TMP, { recursive: true, force: true });
      rmSync(AGY_TMP, { recursive: true, force: true });
      zcodeDb.close();
    });

    test("all 4 adapters return exactly 1 message when mode='last_message'", async () => {
      const piDetail = await piAdapter.getSessionDetail!("sess-cross", { mode: "last_message" });
      const claudeDetail = await claudeAdapter.getSessionDetail!("sess-cross", { mode: "last_message" });
      const agyDetail = await agyAdapter.getSessionDetail!(AGY_UUID, { mode: "last_message" });
      const zcodeDetail = await zcodeAdapter.getSessionDetail!("sess-cross", { mode: "last_message" });

      // RED: all adapters ignore mode, return all 4 messages
      expect(piDetail.messages).toHaveLength(1);
      expect(claudeDetail.messages).toHaveLength(1);
      expect(agyDetail.messages).toHaveLength(1);
      expect(zcodeDetail.messages).toHaveLength(1);

      // All should return the last assistant message
      expect(piDetail.messages![0].role).toBe("assistant");
      expect(claudeDetail.messages![0].role).toBe("assistant");
      expect(agyDetail.messages![0].role).toBe("assistant");
      expect(zcodeDetail.messages![0].role).toBe("assistant");
    });

    test("all 4 adapters filter tool parts when mode='all_no_tools'", async () => {
      // Re-seed with tool parts
      piSeedEvents("sess-tools-cross", [
        {
          type: "message", id: "m5", timestamp: ISO_A,
          message: { role: "user", content: "read this" },
        },
        {
          type: "message", id: "m6", timestamp: ISO_B,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "reading" },
              { type: "tool", tool: "Read", state: { path: "/x" } },
            ],
          },
        },
      ]);

      claudeSeedRecords("sess-tools-cross", [
        { type: "user", id: "m5", timestamp: ISO_A, content: "read this" },
        {
          type: "assistant", id: "m6", timestamp: ISO_B,
          content: [
            { type: "text", text: "reading" },
            { type: "tool_use", id: "tu1", name: "Read", input: { path: "/x" } },
          ],
        },
      ]);

      agySeedLogEntries([
        { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: ISO_A, content: "read this" },
        {
          step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: ISO_B,
          content: "reading",
          tool_calls: [{ name: "Read", args: { path: "/x" } }],
        },
      ]);

      const ts = Date.parse(ISO_A);
      zcodeInsertSession(zcodeDb, { id: "sess-tools-cross", title: "Tools", time_created: ts, time_updated: ts + 1000 });
      zcodeInsertMessage(zcodeDb, { id: "m5", session_id: "sess-tools-cross", data: JSON.stringify({ role: "user", time: { created: ts } }), time_created: ts });
      zcodeInsertMessage(zcodeDb, { id: "m6", session_id: "sess-tools-cross", data: JSON.stringify({ role: "assistant", time: { created: ts + 1000 } }), time_created: ts + 1000 });
      zcodeInsertPart(zcodeDb, { id: "p5", message_id: "m5", session_id: "sess-tools-cross", data: JSON.stringify({ type: "text", text: "read this" }), time_created: ts });
      zcodeInsertPart(zcodeDb, { id: "p6", message_id: "m6", session_id: "sess-tools-cross", data: JSON.stringify({ type: "text", text: "reading" }), time_created: ts + 1000 });
      zcodeInsertPart(zcodeDb, { id: "p7", message_id: "m6", session_id: "sess-tools-cross", data: JSON.stringify({ type: "tool", tool: "Read", state: { path: "/x" } }), time_created: ts + 1000 });

      const piDetail = await piAdapter.getSessionDetail!("sess-tools-cross", { mode: "all_no_tools" });
      const claudeDetail = await claudeAdapter.getSessionDetail!("sess-tools-cross", { mode: "all_no_tools" });
      const agyDetail = await agyAdapter.getSessionDetail!(AGY_UUID, { mode: "all_no_tools" });
      const zcodeDetail = await zcodeAdapter.getSessionDetail!("sess-tools-cross", { mode: "all_no_tools" });

      // RED: all adapters ignore mode, return tool parts
      // All should return 2 messages (user + assistant)
      expect(piDetail.messages).toHaveLength(2);
      expect(claudeDetail.messages).toHaveLength(2);
      expect(agyDetail.messages).toHaveLength(2);
      expect(zcodeDetail.messages).toHaveLength(2);

      // All assistant messages should have NO tool parts
      const piAssistant = piDetail.messages![1];
      const claudeAssistant = claudeDetail.messages![1];
      const agyAssistant = agyDetail.messages![1];
      const zcodeAssistant = zcodeDetail.messages![1];

      expect(piAssistant.parts.every((p) => p.type !== "tool")).toBe(true);
      expect(claudeAssistant.parts.every((p) => p.type !== "tool")).toBe(true);
      expect(agyAssistant.parts.every((p) => p.type !== "tool")).toBe(true);
      expect(zcodeAssistant.parts.every((p) => p.type !== "tool")).toBe(true);
    });
  });
});
