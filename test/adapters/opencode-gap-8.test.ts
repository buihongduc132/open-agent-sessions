/**
 * test/adapters/opencode-gap-8.test.ts
 *
 * GAP 8 — RED tests: parentSessionId MUST be populated by adapters.
 *
 * Gap 7 documented that: SessionSummary has parentSessionId?: string, the CLI
 * filters on it (rootsOnly, subOnly, childrenOf, default child filter), BUT
 * ZERO adapters populate it when returning SessionSummary[].
 *
 * This file tests the opencode adapter (both DB and JSONL paths).
 *
 * Root causes:
 *   DB path:  SessionRow type (opencode.ts:45-52) has no parent_id field,
 *             and the SELECT query (opencode.ts:350-356) doesn't read it.
 *             The DB schema DOES have parent_id (session.parent_id) but it's ignored.
 *   JSONL path: JsonlSessionRow has clone.src.session_id (opencode.ts:80-91),
 *               but listSessionsFromJsonl (opencode.ts:1103-1112) never reads it.
 *
 * Expected fixes:
 *   DB path:  Add parent_id to SessionRow type, SELECT it, propagate to SessionSummary.parentSessionId.
 *   JSONL path: Read row.clone?.src?.session_id, propagate to SessionSummary.parentSessionId.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeAdapter } from "../../src/adapters/opencode";
import { OpenCodeAgentEntry, OpenCodeStorageConfig } from "../../src/config/types";

// ============================================================================
// Fixtures
// ============================================================================

const makeEntry = (alias: string, storage: Partial<OpenCodeStorageConfig>): OpenCodeAgentEntry => ({
  agent: "opencode",
  alias,
  enabled: true,
  storage: {
    mode: storage.mode ?? "auto",
    ...storage,
  } as OpenCodeStorageConfig,
});

const CWD = "/home/user/project";

function writeJsonlLines(path: string, lines: object[]): void {
  const payload = lines.map((l) => JSON.stringify(l)).join("\n");
  writeFileSync(path, payload, "utf-8");
}

// ============================================================================
// GAP 8: OpenCode DB Adapter — parentSessionId
// ============================================================================

describe("GAP 8 — opencode DB adapter must populate parentSessionId", () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: Database;

  beforeEach(() => {
    tempDir = join(tmpdir(), `gap8-opencode-db-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "opencode.db");
    jsonlPath = join(tempDir, "opencode.jsonl");
    db = new Database(dbPath);

    // Create project table
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

    // Create session table WITH parent_id column (GAP 8: this column exists
    // in the schema but is NOT read by the current adapter implementation)
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

    // Create minimal message + part tables
    db.run(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `);

    // Seed a project
    db.run(
      `INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)`,
      ["proj-1", CWD, 1000, 2000]
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * WHY RED: listSessionsFromDb (opencode.ts:360-369) does NOT read session.parent_id.
   * The SELECT query (opencode.ts:350-356) does not include parent_id.
   * The SessionRow type (opencode.ts:45-52) has no parent_id field.
   * A session forked from parent "ses_parent_001" will have parent_id = "ses_parent_001"
   * in the DB, but the adapter returns SessionSummary with parentSessionId = undefined.
   *
   * Fix:
   *   1. Add `parent_id: string | null` to the SessionRow type.
   *   2. Include `s.parent_id` in the SELECT query.
   *   3. Map `row.parent_id ?? undefined` to `SessionSummary.parentSessionId`.
   */
  test("listSessions_db_populates_parentSessionId_when_session_has_parent_id", () => {
    // Insert a root session
    db.run(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["ses_root_001", "proj-1", "root001", CWD, "Root session", "v1", 1000, 2000]
    );

    // Insert a child session (forked from ses_root_001)
    // The parent_id column exists in the schema but is never read by the adapter
    db.run(
      `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["ses_child_001", "proj-1", "ses_root_001", "child001", CWD, "Child session", "v1", 1500, 2500]
    );

    // Add a message so the session appears in the list (message_count > 0)
    db.run(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?)`,
      ["msg-1", "ses_child_001", 1500, 1500, JSON.stringify({ role: "user" })]
    );
    db.run(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?)`,
      ["msg-2", "ses_root_001", 1000, 1000, JSON.stringify({ role: "user" })]
    );

    const entry = makeEntry("personal", { mode: "db", db_path: dbPath });
    const adapter = createOpenCodeAdapter(entry, { cwd: CWD });
    const sessions = adapter.listSessions();

    // Root session: parentSessionId should be undefined
    const rootSession = sessions.find((s) => s.id === "ses_root_001");
    expect(rootSession).toBeDefined();
    expect(rootSession!.parentSessionId).toBeUndefined();

    // Child session: parentSessionId should be "ses_root_001"
    // GAP 8 RED: currently rootSession.parentSessionId is undefined
    const childSession = sessions.find((s) => s.id === "ses_child_001");
    expect(childSession).toBeDefined();
    expect(childSession!.parentSessionId).toBe("ses_root_001");
  });

  /**
   * WHY RED: Same as above but with null parent_id (explicitly set to NULL in DB).
   * A session with parent_id = NULL should have parentSessionId = undefined.
   * This ensures we don't accidentally set parentSessionId = null.
   */
  test("listSessions_db_parentSessionId_is_undefined_when_parent_id_is_null", () => {
    db.run(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["ses_no_parent", "proj-1", "noparent", CWD, "No parent session", "v1", 1000, 2000]
    );
    db.run(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?)`,
      ["msg-x", "ses_no_parent", 1000, 1000, JSON.stringify({ role: "user" })]
    );

    const entry = makeEntry("personal", { mode: "db", db_path: dbPath });
    const adapter = createOpenCodeAdapter(entry, { cwd: CWD });
    const sessions = adapter.listSessions();

    const session = sessions.find((s) => s.id === "ses_no_parent");
    expect(session).toBeDefined();
    expect(session!.parentSessionId).toBeUndefined();
  });
});

// ============================================================================
// GAP 8: OpenCode JSONL Adapter — parentSessionId
// ============================================================================

describe("GAP 8 — opencode JSONL adapter must populate parentSessionId", () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `gap8-opencode-jsonl-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "opencode.db"); // won't be used
    jsonlPath = join(tempDir, "opencode.jsonl");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * WHY RED: listSessionsFromJsonl (opencode.ts:1103-1112) maps JsonlSessionRow
   * fields to SessionSummary but never reads row.clone?.src?.session_id.
   * The JsonlSessionRow type (opencode.ts:73-91) HAS the clone.src.session_id field.
   * When a session was forked (clone.src is set), parentSessionId must be populated.
   *
   * Fix: In listSessionsFromJsonl, add:
   *   parentSessionId: row.clone?.src?.session_id ?? undefined
   */
  test("listSessions_jsonl_populates_parentSessionId_from_clone_src_session_id", () => {
    // Root session: no clone metadata
    writeJsonlLines(jsonlPath, [
      {
        id: "ses_root_jsonl",
        projectID: "proj-1",
        directory: CWD,
        title: "Root session",
        timeCreated: 1000,
        timeUpdated: 2000,
      },
      // Child session: clone.src.session_id is the parent
      {
        id: "ses_child_jsonl",
        projectID: "proj-1",
        directory: CWD,
        title: "Child session",
        timeCreated: 1500,
        timeUpdated: 2500,
        clone: {
          src: {
            session_id: "ses_root_jsonl",
            agent: "opencode",
          },
        },
      },
    ]);

    const entry = makeEntry("personal", { mode: "jsonl", jsonl_path: jsonlPath });
    const adapter = createOpenCodeAdapter(entry, { cwd: CWD });
    const sessions = adapter.listSessions();

    const rootSession = sessions.find((s) => s.id === "ses_root_jsonl");
    expect(rootSession).toBeDefined();
    expect(rootSession!.parentSessionId).toBeUndefined();

    // GAP 8 RED: clone.src.session_id is ignored, so childSession.parentSessionId is undefined
    const childSession = sessions.find((s) => s.id === "ses_child_jsonl");
    expect(childSession).toBeDefined();
    expect(childSession!.parentSessionId).toBe("ses_root_jsonl");
  });

  /**
   * WHY RED: When clone.src is present but session_id is absent/null,
   * parentSessionId should be undefined (not the null value).
   */
  test("listSessions_jsonl_parentSessionId_undefined_when_clone_src_has_no_session_id", () => {
    writeJsonlLines(jsonlPath, [
      {
        id: "ses_malformed_clone",
        projectID: "proj-1",
        directory: CWD,
        title: "Malformed clone",
        timeCreated: 1000,
        timeUpdated: 2000,
        // clone.src exists but session_id is missing
        clone: {
          src: {
            agent: "opencode",
            // session_id is absent
          },
        },
      },
    ]);

    const entry = makeEntry("personal", { mode: "jsonl", jsonl_path: jsonlPath });
    const adapter = createOpenCodeAdapter(entry, { cwd: CWD });
    const sessions = adapter.listSessions();

    const session = sessions.find((s) => s.id === "ses_malformed_clone");
    expect(session).toBeDefined();
    expect(session!.parentSessionId).toBeUndefined();
  });
});
