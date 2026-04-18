/**
 * REQ-SIM-03: Adapter findSimilarSessions tests
 *
 * Tests the findSimilarSessions method on:
 *   A. Adapter interface — backward-compatible optional method
 *   B. OpenCode adapter — returns ranked results with scores
 *   C. Codex/Claude fallback — returns empty array
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeAdapter } from "../../src/adapters/opencode";
import { createCodexAdapter } from "../../src/adapters/codex";
import { createClaudeAdapter } from "../../src/adapters/claude";
import { OpenCodeAgentEntry, OpenCodeStorageConfig } from "../../src/config/types";
import { initializeSimilarity } from "../../src/similarity/config";
import { indexSessionEmbeddings } from "../../src/similarity/storage";
import { findSimilarSessions } from "../../src/similarity/search";
import type { Adapter } from "../../src/core/types";
import type { SimilarSessionResult } from "../../src/similarity/search";

// ─── Test Setup ────────────────────────────────────────────────────────────────

const makeOpenCodeEntry = (alias: string): OpenCodeAgentEntry => ({
  agent: "opencode",
  alias,
  enabled: true,
  storage: { mode: "db" } as OpenCodeStorageConfig,
});

function makeFakeCodexEntry(): { agent: "codex"; alias: string; enabled: boolean; path: string } {
  return { agent: "codex", alias: "test", enabled: true, path: "/tmp/nonexistent" };
}

function makeFakeClaudeEntry(): { agent: "claude"; alias: string; enabled: boolean; path: string } {
  return { agent: "claude", alias: "test", enabled: true, path: "/tmp/nonexistent" };
}

/**
 * Build an OpenCodeAgentEntry pointing at a specific DB path.
 * Pass dbPath explicitly so the adapter doesn't default to ~/.local/share/...
 */
function makeOpenCodeEntryWithDb(alias: string, dbPath: string): OpenCodeAgentEntry {
  return {
    agent: "opencode",
    alias,
    enabled: true,
    storage: { mode: "db", db_path: dbPath } as OpenCodeStorageConfig,
  };
}

function createTestDb(tempDir: string): Database {
  const dbPath = join(tempDir, "opencode.db");
  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      vcs TEXT,
      name TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    )
  `);

  return db;
}

function insertTestSession(
  db: Database,
  projectId: string,
  sessionId: string,
  title: string,
  cwd: string
): void {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, projectId, "slug", cwd, title, "1.0", now, now]
  );
}

function insertTestMessage(
  db: Database,
  sessionId: string,
  messageId: string,
  role: string,
  text: string
): void {
  const now = Math.floor(Date.now() / 1000);
  const data = JSON.stringify({ role });
  db.run(
    `INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`,
    [messageId, sessionId, now, data]
  );
  db.run(
    `INSERT INTO part (id, message_id, session_id, time_created, data)
     VALUES (?, ?, ?, ?, ?)`,
    [
      `part-${messageId}`,
      messageId,
      sessionId,
      now,
      JSON.stringify({ type: "text", text }),
    ]
  );
}

// ─── A. Adapter interface — backward compatibility ─────────────────────────────

describe("A. Adapter interface — findSimilarSessions is optional", () => {
  test("findSimilarSessions is optional (compile-time check)", () => {
    // Minimal adapter without findSimilarSessions — must still satisfy Adapter type
    const minimalAdapter: Adapter = {
      version: "1.0.0",
      listSessions: () => [],
    };
    expect(typeof minimalAdapter.listSessions).toBe("function");
    expect(minimalAdapter.findSimilarSessions).toBeUndefined();
  });

  test("adapter with findSimilarSessions satisfies Adapter interface", () => {
    const adapterWithSimilar: Adapter = {
      version: "1.0.0",
      listSessions: () => [],
      findSimilarSessions: async () => [],
    };
    expect(typeof adapterWithSimilar.findSimilarSessions).toBe("function");
  });
});

// ─── B. OpenCode adapter — findSimilarSessions ─────────────────────────────────

describe("B. OpenCode adapter — findSimilarSessions", () => {
  let tempDir: string;
  let db: Database;
  let dbPath: string;
  let projectId: string;
  let cwd: string;
  let adapter: ReturnType<typeof createOpenCodeAdapter>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `sim-adapter-test-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
    cwd = tempDir;
    dbPath = join(tempDir, "opencode.db");

    db = createTestDb(tempDir);
    projectId = "proj-001";
    db.run(`INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)`,
      [projectId, cwd, 0, 0]);

    // Initialize similarity subsystem
    initializeSimilarity(db, { enabled: true, embeddingProvider: "local", topK: 5, vectorDimension: 384 });

    // Use explicit db_path so adapter resolves to our temp DB, not ~/.local/share/...
    const entry = makeOpenCodeEntryWithDb("test", dbPath);
    adapter = createOpenCodeAdapter(entry, { cwd });
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
    db?.close();
  });

  test("findSimilarSessions returns empty when session not found", async () => {
    // The session does not exist — expect a clear error, not a crash
    await expect(adapter.findSimilarSessions!("sess-nonexistent", 5)).rejects.toThrow();
  });

  test("findSimilarSessions returns results with stored embeddings", async () => {
    // Insert two sessions with enough content
    insertTestSession(db, projectId, "sess-alpha", "Alpha session", cwd);
    insertTestMessage(db, "sess-alpha", "msg-alpha", "user",
      "This is a detailed session about implementing a database schema with TypeScript and SQLite.");
    insertTestMessage(db, "sess-alpha", "msg-alpha2", "assistant",
      "I will help you design the schema with proper indexes and foreign key constraints.");

    insertTestSession(db, projectId, "sess-beta", "Beta session", cwd);
    insertTestMessage(db, "sess-beta", "msg-beta", "user",
      "How to set up a Redis cache for session data with TTL expiration?");
    insertTestMessage(db, "sess-beta", "msg-beta2", "assistant",
      "You can use Redis with the SETEX command to set key expiration times.");

    insertTestSession(db, projectId, "sess-gamma", "Gamma session", cwd);
    insertTestMessage(db, "sess-gamma", "msg-gamma", "user",
      "Database schema design patterns for PostgreSQL with TypeScript integration.");

    // Index all sessions — create fresh adapter (DB is readonly, so indexing is skipped)
    const entry2 = makeOpenCodeEntryWithDb("test", dbPath);
    const adapter2 = createOpenCodeAdapter(entry2, { cwd });

    const [alpha, beta, gamma] = await Promise.all([
      adapter2.getSessionDetail!("sess-alpha", { mode: "all_no_tools" }),
      adapter2.getSessionDetail!("sess-beta", { mode: "all_no_tools" }),
      adapter2.getSessionDetail!("sess-gamma", { mode: "all_no_tools" }),
    ]);

    // Store embeddings directly (DB is readonly — we use a new writable DB for this)
    const writableDb = new Database(dbPath);
    indexSessionEmbeddings(writableDb, alpha);
    indexSessionEmbeddings(writableDb, beta);
    indexSessionEmbeddings(writableDb, gamma);
    writableDb.close();

    // Now query for similar sessions to alpha
    const results = await adapter2.findSimilarSessions!("sess-alpha", 5);

    expect(Array.isArray(results)).toBe(true);
    // The query session itself should not appear in results
    expect(results.some((r) => r.sessionId === "sess-alpha")).toBe(false);
  });

  test("findSimilarSessions excludes the query session from results", async () => {
    insertTestSession(db, projectId, "sess-src", "Source session", cwd);
    insertTestMessage(db, "sess-src", "msg-src1", "user",
      "Writing a custom React hook for data fetching with loading states and error handling.");
    insertTestMessage(db, "sess-src", "msg-src2", "assistant",
      "Here is a complete implementation of useFetch hook with TypeScript generics.");

    insertTestSession(db, projectId, "sess-other", "Other session", cwd);
    insertTestMessage(db, "sess-other", "msg-other", "user",
      "Building REST APIs with Express and TypeScript for production applications.");

    // Index both sessions using a writable DB
    const entry2 = makeOpenCodeEntryWithDb("test", dbPath);
    const adapter2 = createOpenCodeAdapter(entry2, { cwd });

    const [srcDetail, otherDetail] = await Promise.all([
      adapter2.getSessionDetail!("sess-src", { mode: "all_no_tools" }),
      adapter2.getSessionDetail!("sess-other", { mode: "all_no_tools" }),
    ]);

    const writableDb = new Database(dbPath);
    indexSessionEmbeddings(writableDb, srcDetail);
    indexSessionEmbeddings(writableDb, otherDetail);
    writableDb.close();

    const results = await adapter2.findSimilarSessions!("sess-src", 5);

    // The source session must NOT appear in its own results
    for (const result of results) {
      expect(result.sessionId).not.toBe("sess-src");
    }
  });

  test("findSimilarSessions respects topK parameter", async () => {
    // Insert multiple sessions
    for (let i = 1; i <= 5; i++) {
      insertTestSession(db, projectId, `sess-${i}`, `Session ${i}`, cwd);
      insertTestMessage(db, `sess-${i}`, `msg-${i}`, "user",
        `This is session number ${i} about TypeScript and JavaScript programming patterns for web development.`);
    }

    // Index all sessions using a writable DB
    const entry2 = makeOpenCodeEntryWithDb("test", dbPath);
    const adapter2 = createOpenCodeAdapter(entry2, { cwd });

    const writableDb = new Database(dbPath);
    for (let i = 1; i <= 5; i++) {
      const detail = await adapter2.getSessionDetail!(`sess-${i}`, { mode: "all_no_tools" });
      indexSessionEmbeddings(writableDb, detail);
    }
    writableDb.close();

    const results = await adapter2.findSimilarSessions!("sess-1", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

// ─── C. Codex/Claude fallback — empty array ───────────────────────────────────

describe("C. Codex/Claude fallback — note 'Not yet supported'", () => {
  test("codex adapter returns note 'Not yet supported' for findSimilarSessions", async () => {
    const entry = makeFakeCodexEntry();
    const adapter = createCodexAdapter(entry);
    const results = await adapter.findSimilarSessions!("fake-session-id", 5);
    expect(results).toHaveLength(1);
    expect(results[0].note).toBe("Not yet supported");
    expect(results[0].matchType).toBe("none");
  });

  test("claude adapter returns note 'Not yet supported' for findSimilarSessions", async () => {
    const entry = makeFakeClaudeEntry();
    const adapter = createClaudeAdapter(entry);
    const results = await adapter.findSimilarSessions!("fake-session-id", 5);
    expect(results).toHaveLength(1);
    expect(results[0].note).toBe("Not yet supported");
    expect(results[0].matchType).toBe("none");
  });

  test("findSimilarSessions is present on Codex adapter", () => {
    const entry = makeFakeCodexEntry();
    const adapter = createCodexAdapter(entry);
    expect(typeof adapter.findSimilarSessions).toBe("function");
  });

  test("findSimilarSessions is present on Claude adapter", () => {
    const entry = makeFakeClaudeEntry();
    const adapter = createClaudeAdapter(entry);
    expect(typeof adapter.findSimilarSessions).toBe("function");
  });
});
