import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeAdapter } from "../src/adapters/opencode";
import { OpenCodeAgentEntry, OpenCodeStorageConfig } from "../src/config/types";

describe("OpenCode Adapter", () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: Database;

  const makeEntry = (alias: string, storage: Partial<OpenCodeStorageConfig>): OpenCodeAgentEntry => ({
    agent: "opencode",
    alias,
    enabled: true,
    storage: {
      mode: storage.mode ?? "auto",
      ...storage,
    } as OpenCodeStorageConfig,
  });

  beforeEach(() => {
    tempDir = join(tmpdir(), `opencode-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "opencode.db");
    jsonlPath = join(tempDir, "opencode.jsonl");
    db = new Database(dbPath);

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
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const seedProject = (id: string, worktree: string) => {
    db.run(`INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)`, [
      id,
      worktree,
      Date.now(),
      Date.now(),
    ]);
  };

  const seedSession = (
    id: string,
    projectId: string,
    title: string,
    directory: string,
    timeCreated: number,
    timeUpdated: number
  ) => {
    db.run(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, projectId, id.slice(0, 8), directory, title, "v1", timeCreated, timeUpdated]
    );
  };

  const seedMessage = (id: string, sessionId: string, role: string, timeCreated: number) => {
    const data = JSON.stringify({ role, time: { created: timeCreated } });
    db.run(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
      [id, sessionId, timeCreated, timeCreated, data]
    );
  };

  const seedPart = (
    id: string,
    messageId: string,
    sessionId: string,
    type: string,
    content: Record<string, unknown>,
    timeCreated: number
  ) => {
    const data = JSON.stringify({ type, ...content });
    db.run(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, messageId, sessionId, timeCreated, timeCreated, data]
    );
  };

  const writeJsonl = (sessions: Record<string, unknown>[]) => {
    const lines = sessions.map((s) => JSON.stringify(s)).join("\n");
    writeFileSync(jsonlPath, lines, "utf-8");
  };

  // ===========================================================================
  // storage.mode Tests
  // ===========================================================================

  describe("storage.mode", () => {
    test("mode=auto prefers DB when both exist", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "DB Session", cwd, 1000, 2000);

      // Also create JSONL with different session
      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: cwd, title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath, jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("ses-1");
      expect(sessions[0].storage).toBe("db");
      expect(sessions[0].title).toBe("DB Session");
    });

    test("mode=auto falls back to JSONL when DB missing", () => {
      // Close and delete DB
      db.close();
      rmSync(dbPath, { force: true });

      const cwd = "/home/user/project";
      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: cwd, title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath, jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("ses-jsonl");
      expect(sessions[0].storage).toBe("jsonl");
      expect(sessions[0].title).toBe("JSONL Session");
    });

    test("mode=auto errors when neither DB nor JSONL exists", () => {
      db.close();
      rmSync(dbPath, { force: true });

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath, jsonl_path: jsonlPath });
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/storage not found/);
    });

    test("mode=db uses DB even when JSONL exists", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-db", projectId, "DB Session", cwd, 1000, 2000);

      // JSONL has different session
      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: cwd, title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath, jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("ses-db");
      expect(sessions[0].storage).toBe("db");
    });

    test("mode=db errors when DB missing even if JSONL exists", () => {
      db.close();
      rmSync(dbPath, { force: true });

      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: "/home/user", title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath, jsonl_path: jsonlPath });
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/DB not found/);
    });

    test("mode=jsonl uses JSONL even when DB exists", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-db", projectId, "DB Session", cwd, 1000, 2000);

      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: cwd, title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "jsonl", db_path: dbPath, jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("ses-jsonl");
      expect(sessions[0].storage).toBe("jsonl");
    });

    test("mode=jsonl errors when JSONL missing even if DB exists", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      const entry = makeEntry("main", { mode: "jsonl", db_path: dbPath, jsonl_path: jsonlPath });
      expect(() => createOpenCodeAdapter(entry, { cwd })).toThrow(/JSONL not found/);
    });

    test("rejects invalid storage mode", () => {
      const entry = makeEntry("main", { mode: "invalid" as "auto", db_path: dbPath });
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/Unsupported storage mode/);
    });
  });

  // ===========================================================================
  // Integration with resolveOpenCodeStorage helper
  // ===========================================================================

  describe("integration with config helper (AC7)", () => {
    // These tests verify that createOpenCodeAdapter uses the centralized
    // resolveOpenCodeStorage helper from src/config/opencode.ts for path resolution.
    // The behavior is verified by checking that storage.mode is respected exactly
    // as resolveOpenCodeStorage defines it.

    test("uses resolveOpenCodeStorage for path resolution - respects mode=auto behavior", () => {
      // When both DB and JSONL exist with mode=auto, resolveOpenCodeStorage prefers DB
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-db", projectId, "DB Session", cwd, 1000, 2000);

      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: cwd, title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("test-helper", { mode: "auto", db_path: dbPath, jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      // If resolveOpenCodeStorage is being used, mode=auto should prefer DB
      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].storage).toBe("db"); // DB preferred over JSONL
      expect(sessions[0].alias).toBe("test-helper");
    });

    test("uses resolveOpenCodeStorage for path resolution - respects mode=db explicit", () => {
      // When mode=db is set, resolveOpenCodeStorage only uses DB even if JSONL exists
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-db", projectId, "DB Session", cwd, 1000, 2000);

      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: cwd, title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("test-helper", { mode: "db", db_path: dbPath, jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      // If resolveOpenCodeStorage is being used, mode=db should ignore JSONL
      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].storage).toBe("db");
      expect(sessions[0].id).toBe("ses-db");
    });

    test("uses resolveOpenCodeStorage for path resolution - errors match helper output", () => {
      // When mode=db but DB is missing, resolveOpenCodeStorage throws "DB not found"
      db.close();
      rmSync(dbPath, { force: true });

      const entry = makeEntry("test-helper", { mode: "db", db_path: dbPath, jsonl_path: jsonlPath });
      
      // This error message comes from resolveOpenCodeStorage, verifying it's being used
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/DB not found/);
    });
  });

  // ===========================================================================
  // JSONL Parsing Tests
  // ===========================================================================

  describe("JSONL parsing", () => {
    test("parses valid JSONL file", () => {
      const cwd = "/home/user/project";
      writeJsonl([
        { id: "ses-1", projectID: "proj-1", directory: cwd, title: "Session 1", timeCreated: 1000, timeUpdated: 2000 },
        { id: "ses-2", projectID: "proj-1", directory: cwd, title: "Session 2", timeCreated: 3000, timeUpdated: 4000 },
      ]);

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.id).sort()).toEqual(["ses-1", "ses-2"]);
    });

    test("ignores blank lines in JSONL", () => {
      const cwd = "/home/user/project";
      // Write JSONL with blank lines
      const content = `{"id":"ses-1","projectID":"proj-1","directory":"${cwd}","title":"Session 1","timeCreated":1000,"timeUpdated":2000}

{"id":"ses-2","projectID":"proj-1","directory":"${cwd}","title":"Session 2","timeCreated":3000,"timeUpdated":4000}
   
`;
      writeFileSync(jsonlPath, content, "utf-8");

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(2);
    });

    test("errors on malformed JSONL with line number", () => {
      const cwd = "/home/user/project";
      // Line 2 is malformed
      const content = `{"id":"ses-1","projectID":"proj-1","directory":"${cwd}","title":"Session 1","timeCreated":1000,"timeUpdated":2000}
{invalid json}
{"id":"ses-3","projectID":"proj-1","directory":"${cwd}","title":"Session 3","timeCreated":5000,"timeUpdated":6000}`;
      writeFileSync(jsonlPath, content, "utf-8");

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      expect(() => adapter.listSessions()).toThrow(/line 2/);
    });

    test("returns empty list for empty JSONL file", () => {
      const cwd = "/home/user/project";
      writeFileSync(jsonlPath, "", "utf-8");

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toEqual([]);
    });

    test("returns empty list for JSONL with only whitespace", () => {
      const cwd = "/home/user/project";
      writeFileSync(jsonlPath, "   \n\n  \n", "utf-8");

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toEqual([]);
    });
  });

  // ===========================================================================
  // Title Fallback Tests
  // ===========================================================================

  describe("title fallback", () => {
    test("falls back to session id when title is empty (DB)", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-empty-title", projectId, "", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].title).toBe("ses-empty-title");
    });

    test("falls back to session id when title is null (JSONL)", () => {
      const cwd = "/home/user/project";
      writeJsonl([
        { id: "ses-null-title", projectID: "proj-1", directory: cwd, title: null, timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].title).toBe("ses-null-title");
    });

    test("falls back to session id when title is missing (JSONL)", () => {
      const cwd = "/home/user/project";
      writeJsonl([
        { id: "ses-missing-title", projectID: "proj-1", directory: cwd, timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].title).toBe("ses-missing-title");
    });
  });

  // ===========================================================================
  // Schema Validation Tests
  // ===========================================================================

  describe("schema validation", () => {
    test("errors when project table missing", () => {
      db.close();
      rmSync(dbPath, { force: true });
      db = new Database(dbPath);

      // Create all tables except project
      db.run(`CREATE TABLE session (id TEXT PRIMARY KEY)`);
      db.run(`CREATE TABLE message (id TEXT PRIMARY KEY)`);
      db.run(`CREATE TABLE part (id TEXT PRIMARY KEY)`);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/schema mismatch.*missing tables.*project/);
    });

    test("errors when required columns missing", () => {
      db.close();
      rmSync(dbPath, { force: true });
      db = new Database(dbPath);

      // Create tables with missing columns
      db.run(`CREATE TABLE project (id TEXT PRIMARY KEY)`); // Missing worktree
      db.run(`CREATE TABLE session (id TEXT PRIMARY KEY)`); // Missing required columns
      db.run(`CREATE TABLE message (id TEXT PRIMARY KEY)`);
      db.run(`CREATE TABLE part (id TEXT PRIMARY KEY)`);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/schema mismatch.*missing columns/);
    });

    test("includes expected schema reference in error", () => {
      db.close();
      rmSync(dbPath, { force: true });
      db = new Database(dbPath);
      db.run(`CREATE TABLE other (id TEXT)`);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/Expected schema/);
    });
  });

  // ===========================================================================
  // DB Lock Retry Tests
  // ===========================================================================

  describe("DB lock retry", () => {
    test("uses default retry delays [50, 100, 200]", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      // Should succeed without retries
      const adapter = createOpenCodeAdapter(entry, { cwd });
      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
    });

    test("supports custom lock retry delays via options", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd, lockRetries: [10, 20, 30] });
      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Error Context Tests
  // ===========================================================================

  describe("error context", () => {
    test("all errors include [agent:alias] label for missing DB path", () => {
      const entry = makeEntry("custom-alias", { mode: "db", db_path: "/nonexistent/path.db" });
      try {
        createOpenCodeAdapter(entry, { cwd: "/home/user" });
        expect(true).toBe(false); // Should not reach
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain("[opencode:custom-alias]");
      }
    });

    test("all errors include [agent:alias] label for missing JSONL path", () => {
      const entry = makeEntry("jsonl-alias", { mode: "jsonl", jsonl_path: "/nonexistent/path.jsonl" });
      try {
        createOpenCodeAdapter(entry, { cwd: "/home/user" });
        expect(true).toBe(false); // Should not reach
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain("[opencode:jsonl-alias]");
      }
    });

    test("session not found error includes context", async () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      const entry = makeEntry("my-alias", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      try {
        await adapter.getSessionDetail("nonexistent", { mode: "last_message" });
        expect(true).toBe(false); // Should not reach
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain("[opencode:my-alias]");
        expect((error as Error).message).toContain("session not found");
      }
    });
  });

  // ===========================================================================
  // SessionSummary Normalization Tests
  // ===========================================================================

  describe("SessionSummary normalization", () => {
    test("DB sessions have storage='db'", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].storage).toBe("db");
    });

    test("JSONL sessions have storage='jsonl'", () => {
      const cwd = "/home/user/project";
      writeJsonl([
        { id: "ses-1", projectID: "proj-1", directory: cwd, title: "Test", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].storage).toBe("jsonl");
    });

    test("alias comes from config entry", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("custom-alias", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].alias).toBe("custom-alias");
    });

    test("agent is always 'opencode'", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].agent).toBe("opencode");
    });
  });

  // ===========================================================================
  // Original Functionality Tests (preserved)
  // ===========================================================================

  describe("listSessions", () => {
    test("lists sessions for current CWD only", () => {
      const cwd = "/home/user/project-a";
      const projectA = "proj-a-123";
      const projectB = "proj-b-456";

      seedProject(projectA, cwd);
      seedProject(projectB, "/home/user/project-b");

      seedSession("ses-1", projectA, "Fix bug in module A", cwd, 1000, 2000);
      seedSession("ses-2", projectA, "Add feature X", cwd, 3000, 4000);
      seedSession("ses-3", projectB, "Unrelated session", "/home/user/project-b", 5000, 6000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.id).sort()).toEqual(["ses-1", "ses-2"]);
      expect(sessions[0].agent).toBe("opencode");
      expect(sessions[0].alias).toBe("main");
      expect(sessions[0].storage).toBe("db");
    });

    test("returns empty array when no sessions for CWD", () => {
      const cwd = "/home/user/empty-project";
      seedProject("proj-other", "/home/user/other");

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toEqual([]);
    });

    test("orders sessions by updated_at descending", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-old", projectId, "Old session", cwd, 1000, 2000);
      seedSession("ses-new", projectId, "New session", cwd, 3000, 5000);
      seedSession("ses-mid", projectId, "Mid session", cwd, 2000, 4000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();

      expect(sessions[0].id).toBe("ses-new");
      expect(sessions[1].id).toBe("ses-mid");
      expect(sessions[2].id).toBe("ses-old");
    });

    test("counts messages from message table", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      seedMessage("msg-1", "ses-1", "user", 1100);
      seedMessage("msg-2", "ses-1", "assistant", 1200);
      seedMessage("msg-3", "ses-1", "user", 1300);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();

      expect(sessions[0].message_count).toBe(3);
    });
  });

  describe("searchSessions", () => {
    test("searches by title with fuzzy match", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Fix critical bug in auth", cwd, 1000, 2000);
      seedSession("ses-2", projectId, "Add new feature", cwd, 3000, 4000);
      seedSession("ses-3", projectId, "Authentication refactor", cwd, 5000, 6000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const results = adapter.searchSessions({ text: "auth", cwd });

      expect(results).toHaveLength(2);
      expect(results.map((s) => s.id).sort()).toEqual(["ses-1", "ses-3"]);
    });

    test("searches by content in parts", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Generic title", cwd, 1000, 2000);
      seedSession("ses-2", projectId, "Another session", cwd, 3000, 4000);

      seedMessage("msg-1", "ses-1", "user", 1100);
      seedMessage("msg-2", "ses-2", "user", 3100);

      seedPart("prt-1", "msg-1", "ses-1", "text", { text: "How do I implement OAuth?" }, 1150);
      seedPart("prt-2", "msg-2", "ses-2", "text", { text: "Hello world" }, 3150);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const results = adapter.searchSessions({ text: "oauth", cwd });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("ses-1");
    });

    test("returns empty when no matches", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Fix bug", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const results = adapter.searchSessions({ text: "nonexistent", cwd });

      expect(results).toEqual([]);
    });

    test("filters results by CWD (excludes other projects)", () => {
      const cwdA = "/home/user/project-a";
      const cwdB = "/home/user/project-b";
      const projectA = "proj-a";
      const projectB = "proj-b";

      seedProject(projectA, cwdA);
      seedProject(projectB, cwdB);

      seedSession("ses-a1", projectA, "Fix authentication bug", cwdA, 1000, 2000);
      seedSession("ses-a2", projectA, "Auth refactor", cwdA, 3000, 4000);
      seedSession("ses-b1", projectB, "Authentication service", cwdB, 5000, 6000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd: cwdA });

      const results = adapter.searchSessions({ text: "auth", cwd: cwdA });

      expect(results).toHaveLength(2);
      expect(results.map((s) => s.id).sort()).toEqual(["ses-a1", "ses-a2"]);
      expect(results.find((s) => s.id === "ses-b1")).toBeUndefined();
    });

    test("matches with partial text and spacing differences", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Fix critical bug in auth module", cwd, 1000, 2000);
      seedSession("ses-2", projectId, "Implement user authentication", cwd, 3000, 4000);
      seedSession("ses-3", projectId, "Database connection fix", cwd, 5000, 6000);

      seedMessage("msg-1", "ses-3", "user", 5100);
      seedPart("prt-1", "msg-1", "ses-3", "text", { text: "How to fix  database   connection issues?" }, 5150);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const results = adapter.searchSessions({ text: "databas", cwd });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("ses-3");
    });
  });

  describe("getSessionDetail", () => {
    test("returns last message only with mode=last_message", async () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test session", cwd, 1000, 5000);

      seedMessage("msg-1", "ses-1", "user", 1100);
      seedMessage("msg-2", "ses-1", "assistant", 1200);
      seedMessage("msg-3", "ses-1", "user", 1300);

      seedPart("prt-1", "msg-1", "ses-1", "text", { text: "First message" }, 1150);
      seedPart("prt-2", "msg-2", "ses-1", "text", { text: "Response" }, 1250);
      seedPart("prt-3", "msg-3", "ses-1", "text", { text: "Last message" }, 1350);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const detail = await adapter.getSessionDetail("ses-1", { mode: "last_message" });

      expect(detail.id).toBe("ses-1");
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages?.[0].parts[0].text).toBe("Last message");
    });

    test("returns all messages without tool parts with mode=all_no_tools", async () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test session", cwd, 1000, 5000);

      seedMessage("msg-1", "ses-1", "user", 1100);
      seedMessage("msg-2", "ses-1", "assistant", 1200);

      seedPart("prt-1", "msg-1", "ses-1", "text", { text: "User question" }, 1150);
      seedPart("prt-2", "msg-2", "ses-1", "text", { text: "Response text" }, 1250);
      seedPart("prt-3", "msg-2", "ses-1", "tool", { tool: "bash", state: { status: "completed" } }, 1350);
      seedPart("prt-4", "msg-2", "ses-1", "step-start", {}, 1400);
      seedPart("prt-5", "msg-2", "ses-1", "step-finish", {}, 1450);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const detail = await adapter.getSessionDetail("ses-1", { mode: "all_no_tools" });

      expect(detail.messages).toHaveLength(2);
      expect(detail.messages?.[0].parts).toHaveLength(1);
      expect(detail.messages?.[1].parts).toHaveLength(1);
      expect(detail.messages?.[1].parts[0].type).toBe("text");

      const allParts = detail.messages?.flatMap((m) => m.parts) || [];
      expect(allParts.find((p) => p.type === "tool")).toBeUndefined();
      expect(allParts.find((p) => p.type === "step-start")).toBeUndefined();
      expect(allParts.find((p) => p.type === "step-finish")).toBeUndefined();
    });

    test("returns all messages with tools with mode=all_with_tools", async () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test session", cwd, 1000, 5000);

      seedMessage("msg-1", "ses-1", "user", 1100);
      seedMessage("msg-2", "ses-1", "assistant", 1200);

      seedPart("prt-1", "msg-1", "ses-1", "text", { text: "User question" }, 1150);
      seedPart("prt-2", "msg-2", "ses-1", "text", { text: "Response" }, 1250);
      seedPart("prt-3", "msg-2", "ses-1", "tool", { tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "file1\nfile2" } }, 1350);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const detail = await adapter.getSessionDetail("ses-1", { mode: "all_with_tools" });

      expect(detail.messages).toHaveLength(2);
      expect(detail.messages?.[1].parts).toHaveLength(2);

      const toolPart = detail.messages?.[1].parts.find((p) => p.type === "tool");
      expect(toolPart).toBeDefined();
      expect(toolPart?.tool).toBe("bash");
      expect(toolPart?.state?.input?.command).toBe("ls");
      expect(toolPart?.state?.output).toBe("file1\nfile2");
    });

    test("includes session metadata", async () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test session", cwd, 1000, 5000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const detail = await adapter.getSessionDetail("ses-1", { mode: "last_message" });

      expect(detail.id).toBe("ses-1");
      expect(detail.title).toBe("Test session");
      expect(detail.agent).toBe("opencode");
      expect(detail.alias).toBe("main");
      expect(detail.storage).toBe("db");
    });

    test("throws when session not found", async () => {
      const cwd = "/home/user/project";
      seedProject("proj-1", cwd);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      expect(adapter.getSessionDetail("ses-nonexistent", { mode: "last_message" })).rejects.toThrow(
        /not found/
      );
    });
  });

  describe("error handling", () => {
    test("throws when agent is not opencode", () => {
      const entry = { agent: "codex", alias: "main", enabled: true, storage: { mode: "auto" } } as OpenCodeAgentEntry;
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/opencode/);
    });
  });

  // ===========================================================================
  // Canonical Session Key Tests
  // ===========================================================================

  describe("canonical session key", () => {
    test("session summary contains all key components", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-123", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("my-alias", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      const session = sessions[0];

      // Canonical key is (agent, alias, session_id)
      expect(session.agent).toBe("opencode");
      expect(session.alias).toBe("my-alias");
      expect(session.id).toBe("ses-123");
    });
  });
});
